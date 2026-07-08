const express    = require('express');
const fetch      = require('node-fetch');
const session    = require('./screenerSession');
const nseSession = require('./nseSession');
const app        = express();
// ── CORS — allow all origins ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'x-api-key, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT    = process.env.PORT    || 3000;
const API_KEY = process.env.API_KEY || '';

const SCREENER_BASE = 'https://www.screener.in';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ── Session-aware fetch ──
// Sends the current session cookie; on an auth failure (403/401,
// redirect to /login/, or a login-wall page) re-logins once and retries.
// authFailed:true in the result means even the fresh login didn't help
// (i.e. credentials are wrong) — callers surface that as a 401.
async function fetchWithSession(url, extraHeaders = {}) {
  const attempt = async () => {
    const resp = await fetch(url, {
      redirect: 'manual',
      headers: {
        'Cookie'    : session.cookieHeader(),
        'User-Agent': UA,
        ...extraHeaders
      }
    });
    const status   = resp.status;
    const location = resp.headers.get('location') || '';
    const html     = status >= 200 && status < 300 ? await resp.text() : '';
    // Session-gated endpoints bounce anonymous/invalid sessions to
    // /login/ or /register/ (both carry a ?next= back-reference)
    const authFailed =
      status === 401 || status === 403 ||
      (status >= 300 && status < 400 && /\/(login|register)\//.test(location)) ||
      (html && html.includes('id="login-form"'));
    return { status, location, html, authFailed };
  };

  await session.ensure();
  let r = await attempt();
  if (r.authFailed) {
    await session.refresh(); // throws with a clear message on bad credentials
    r = await attempt();
  }
  return r;
}

const XHR_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  'Referer'         : `${SCREENER_BASE}/company/`
};

const AUTH_ERROR = {
  error: 'screener.in auth failed even after auto-login — check SCREENER_EMAIL / SCREENER_PASSWORD env vars'
};

// ── Auth middleware ──
function checkKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Health check — no auth needed ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'screener-proxy' });
});

// ── Shared: resolve a symbol to its warehouse ID ──
// A plain 3xx here (not to /login/) is screener redirecting between
// consolidated/standalone views — just try the next URL.
async function findWarehouse(symbol) {
  const urls = [
    `${SCREENER_BASE}/company/${symbol}/consolidated/`,
    `${SCREENER_BASE}/company/${symbol}/`
  ];

  for (const url of urls) {
    const r = await fetchWithSession(url);
    if (r.authFailed) return { authFailed: true };
    if (r.status !== 200) continue;

    const match = r.html.match(/data-warehouse-id="(\d+)"/);
    if (match) return { warehouseId: match[1], url, html: r.html };
  }
  return {};
}

// ── Shared: key ratios (Market Cap, CMP, P/E, ROE...) from #top-ratios ──
// The LOGGED-IN company page renders the numbers empty (filled client-side),
// so if the session page yields nothing we refetch the page anonymously,
// where screener still server-renders the values.
async function getTopRatios(pageUrl, sessionHtml) {
  let ratios = parseTopRatios(sessionHtml || '');
  if (Object.keys(ratios).length > 0) return ratios;

  try {
    const resp = await fetch(pageUrl, { headers: { 'User-Agent': UA } });
    if (resp.status === 200) {
      ratios = parseTopRatios(await resp.text());
    }
  } catch (e) {
    console.log('⚠️ anonymous top-ratios fetch failed: ' + e.message);
  }
  return ratios;
}

// ── Get warehouse ID from stock symbol ──
// GET /warehouse?symbol=INFY
app.get('/warehouse', checkKey, async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol required' });
  }

  try {
    const found = await findWarehouse(symbol);
    if (found.authFailed) return res.status(401).json(AUTH_ERROR);
    if (!found.warehouseId) {
      return res.status(404).json({ error: 'Warehouse ID not found for: ' + symbol });
    }

    res.json({
      symbol      : symbol,
      warehouse_id: found.warehouseId,
      url         : found.url
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Get quick ratios (custom ratios) ──
// GET /quick_ratios?warehouse_id=6596470
app.get('/quick_ratios', checkKey, async (req, res) => {
  const wid = req.query.warehouse_id;
  if (!wid) return res.status(400).json({ error: 'warehouse_id required' });

  try {
    const r = await fetchWithSession(
      `${SCREENER_BASE}/api/company/${wid}/quick_ratios/`, XHR_HEADERS
    );
    if (r.authFailed) return res.status(401).json(AUTH_ERROR);

    const ratios = parseQuickRatios(r.html);
    res.json({ warehouse_id: wid, ratios });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Get peers ──
// GET /peers?warehouse_id=6596470
app.get('/peers', checkKey, async (req, res) => {
  const wid = req.query.warehouse_id;
  if (!wid) return res.status(400).json({ error: 'warehouse_id required' });

  try {
    const r = await fetchWithSession(
      `${SCREENER_BASE}/api/company/${wid}/peers/`, XHR_HEADERS
    );
    if (r.authFailed) return res.status(401).json(AUTH_ERROR);

    const peers = parsePeersHTML(r.html);
    res.json({ warehouse_id: wid, peers });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Combined endpoint — warehouse + ratios + peers in one call ──
// GET /stock?symbol=INFY
app.get('/stock', checkKey, async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  try {
    // Step 1: Get warehouse ID
    const found = await findWarehouse(symbol);
    if (found.authFailed) return res.status(401).json(AUTH_ERROR);
    if (!found.warehouseId) {
      return res.status(404).json({
        error: 'Stock not found on screener.in: ' + symbol
      });
    }

    // Step 2: Fetch custom ratios, peers, and key ratios in parallel
    const [ratiosR, peersR, topRatios] = await Promise.all([
      fetchWithSession(
        `${SCREENER_BASE}/api/company/${found.warehouseId}/quick_ratios/`,
        { 'X-Requested-With': 'XMLHttpRequest', 'Referer': found.url }
      ),
      fetchWithSession(
        `${SCREENER_BASE}/api/company/${found.warehouseId}/peers/`,
        { 'X-Requested-With': 'XMLHttpRequest', 'Referer': found.url }
      ),
      getTopRatios(found.url, found.html)
    ]);

    const ratios = parseQuickRatios(ratiosR.html);
    const peers  = parsePeersHTML(peersR.html);

    res.json({
      symbol,
      warehouse_id: found.warehouseId,
      screener_url: found.url,
      ratios,
      top_ratios  : topRatios,
      peers,
      fetched_at  : new Date().toISOString()
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Full company data — everything the app's screener modal needs ──
// GET /full?symbol=INFY
// Parses the financial tables straight from the company page (which we
// already download for the warehouse id), replacing the old
// IMPORTHTML-via-Google-Sheets path on the Apps Script side.
app.get('/full', checkKey, async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  try {
    const found = await findWarehouse(symbol);
    if (found.authFailed) return res.status(401).json(AUTH_ERROR);
    if (!found.warehouseId) {
      return res.status(404).json({
        error: 'Stock not found on screener.in: ' + symbol
      });
    }

    const html = found.html || '';

    const [ratiosR, peersR, topRatios] = await Promise.all([
      fetchWithSession(
        `${SCREENER_BASE}/api/company/${found.warehouseId}/quick_ratios/`,
        { 'X-Requested-With': 'XMLHttpRequest', 'Referer': found.url }
      ),
      fetchWithSession(
        `${SCREENER_BASE}/api/company/${found.warehouseId}/peers/`,
        { 'X-Requested-With': 'XMLHttpRequest', 'Referer': found.url }
      ),
      getTopRatios(found.url, html)
    ]);

    // key_ratios as plain display strings — the shape the app's modal expects
    const keyRatios = {};
    Object.keys(topRatios).forEach(k => { keyRatios[k] = topRatios[k].display; });

    res.json({
      symbol,
      warehouse_id : found.warehouseId,
      screener_url : found.url,
      key_ratios   : keyRatios,
      top_ratios   : topRatios,
      ratios       : parseQuickRatios(ratiosR.html),
      quarterly    : parseSectionTable(html, 'quarters'),
      annual_pl    : parseSectionTable(html, 'profit-loss'),
      balance_sheet: parseSectionTable(html, 'balance-sheet'),
      cash_flow    : parseSectionTable(html, 'cash-flow'),
      shareholding : parseSectionTable(html, 'shareholding', true),
      ...parseRangeTables(html),
      peers        : parsePeersHTML(peersR.html),
      fetched_at   : new Date().toISOString()
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Screen (saved query) results — logged-in view, so custom columns
// configured on the account show up instead of the public default set.
// GET /screen?path=screens/3781811/opm/&page=1
app.get('/screen', checkKey, async (req, res) => {
  const screenPath = String(req.query.path || '').trim();
  const page       = parseInt(req.query.page, 10) || 1;

  if (!/^screens\/\d+\/[\w-]+\/?$/.test(screenPath)) {
    return res.status(400).json({
      error: 'path required, e.g. screens/3781811/opm/'
    });
  }

  try {
    const cleanPath = screenPath.replace(/\/?$/, '/');
    const url = `${SCREENER_BASE}/${cleanPath}?page=${page}`;

    const r = await fetchWithSession(url);
    if (r.authFailed) return res.status(401).json(AUTH_ERROR);
    if (r.status !== 200) {
      return res.status(502).json({ error: 'screener.in HTTP ' + r.status });
    }

    const parsed     = parseScreenTable(r.html);
    const totalPages = parseScreenTotalPages(r.html);

    res.json({
      page,
      total_pages: totalPages,
      headers    : parsed.headers,
      rows       : parsed.rows,
      fetched_at : new Date().toISOString()
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── NSE session-aware JSON fetch ──
// Same shape as fetchWithSession above: send the current cookie jar, and
// on an auth failure (401/403, or a non-JSON body — Akamai's block page
// is HTML) warm a fresh session once and retry.
const NSE_BASE = 'https://www.nseindia.com';

async function fetchNSEJson(url) {
  const attempt = async () => {
    const resp = await fetch(url, {
      headers: {
        'Cookie'          : nseSession.cookieHeader(),
        'User-Agent'      : UA,
        'Accept'          : 'application/json, text/plain, */*',
        'Referer'         : NSE_BASE + '/',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });
    const status = resp.status;
    let json = null;
    try { json = await resp.json(); } catch (e) { /* Akamai block page, not JSON */ }
    const authFailed = status === 401 || status === 403 || !json;
    return { status, json, authFailed };
  };

  await nseSession.ensure();
  let r = await attempt();
  if (r.authFailed) {
    await nseSession.refresh();
    r = await attempt();
  }
  return r;
}

// ── NSE symbol/ISIN lookup by company name ──
// GET /nse-symbol?name=Sanofi Consumer
// Combines NSE's globalSearch (name → symbol) and getMetaData
// (symbol → ISIN) into one call. nseindia.com blocks this from a
// browser with no CORS headers on the response, and blocks bare
// server-side requests with no session cookie — this proxy solves the
// second problem for screener.in the same way (fetchWithSession above).
// Last-resort fallback for stocks never held by any tracked mutual fund,
// so absent from every MF-derived symbol sheet the app already checks.
app.get('/nse-symbol', checkKey, async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    const searchUrl = `${NSE_BASE}/api/NextApi/globalSearch/equity?symbol=${encodeURIComponent(name)}`;
    const searchR   = await fetchNSEJson(searchUrl);
    if (searchR.authFailed) {
      return res.status(401).json({ error: 'NSE session failed — Akamai may be blocking this IP' });
    }

    const hit    = searchR.json && searchR.json.data && searchR.json.data[0];
    const symbol = hit && hit.symbol ? String(hit.symbol).toUpperCase() : '';
    if (!symbol) {
      return res.status(404).json({ error: 'No NSE symbol found for: ' + name });
    }

    const metaUrl = `${NSE_BASE}/api/NextApi/apiClient/GetQuoteApi?functionName=getMetaData&symbol=${encodeURIComponent(symbol)}`;
    const metaR   = await fetchNSEJson(metaUrl);
    const isin    = (!metaR.authFailed && metaR.json && metaR.json.isin)
      ? String(metaR.json.isin).toUpperCase() : '';

    res.json({
      name,
      symbol,
      isin,
      company_name: hit.companyName || '',
      fetched_at  : new Date().toISOString()
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PARSERS ──

// First data-table inside <section id="...">, as rows the app's modal
// renders directly: [{ '': 'Sales', 'Mar 2025': 1234, ... }, ...]
function parseSectionTable(html, sectionId, isShareholding) {
  const sec = (html.match(new RegExp(
    '<section[^>]*id="' + sectionId + '"[\\s\\S]*?</section>', 'i'
  )) || [])[0] || '';
  const table = (sec.match(
    /<table[^>]*class="[^"]*data-table[^"]*"[\s\S]*?<\/table>/i
  ) || [])[0];
  if (!table) return [];

  const headHtml = (table.match(/<thead[\s\S]*?<\/thead>/i) || [''])[0];
  const headers  = [...headHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
    .map(h => h[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  if (headers.length < 2) return [];

  const rows     = [];
  const bodyHtml = (table.match(/<tbody[\s\S]*?<\/tbody>/i) || [''])[0];

  [...bodyHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].forEach(tr => {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(td => td[1].replace(/<[^>]+>/g, ' ')
                      .replace(/&nbsp;/gi, ' ')
                      .replace(/&amp;/gi, '&')
                      .replace(/\s+/g, ' ').trim());
    if (cells.length < 2) return;

    // Expandable label rows render as "Sales +" — strip the toggle marker
    const label = cells[0].replace(/\s*[+\-]\s*$/, '').trim();
    if (!label) return;

    const obj = { '': label };
    for (let i = 1; i < headers.length; i++) {
      obj[headers[i] || ('Col' + i)] =
        normalizeCell(cells[i] !== undefined ? cells[i] : '', isShareholding);
    }
    rows.push(obj);
  });

  return rows;
}

// "1,234" → 1234; shareholding "74.30%" → 74.3; "21%" and text stay strings
function normalizeCell(text, isShareholding) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (isShareholding && /^-?[\d,]+(\.\d+)?%$/.test(t)) {
    return Math.round(parseFloat(t.replace(/,/g, '')) * 100) / 100;
  }
  const plain = t.replace(/,/g, '');
  if (/^-?\d+(\.\d+)?$/.test(plain)) {
    return Math.round(parseFloat(plain) * 100) / 100;
  }
  return t;
}

// The four small "ranges" tables on the company page:
// Compounded Sales/Profit Growth, Stock Price CAGR, Return on Equity
// → { sales_growth: {'10 Years': '12%', ...}, profit_growth, price_cagr, roe_history }
function parseRangeTables(html) {
  const out = { sales_growth: {}, profit_growth: {}, price_cagr: {}, roe_history: {} };
  const map = {
    'compounded sales growth' : 'sales_growth',
    'compounded profit growth': 'profit_growth',
    'stock price cagr'        : 'price_cagr',
    'return on equity'        : 'roe_history'
  };

  [...html.matchAll(
    /<table[^>]*class="[^"]*ranges-table[^"]*"[^>]*>([\s\S]*?)<\/table>/gi
  )].forEach(t => {
    const titleM = t[1].match(/<th[^>]*>([\s\S]*?)<\/th>/i);
    const title  = titleM
      ? titleM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
      : '';
    const key = map[title];
    if (!key) return;

    [...t[1].matchAll(
      /<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi
    )].forEach(r => {
      const k = r[1].replace(/<[^>]+>/g, '').replace(/:/g, '').replace(/\s+/g, ' ').trim();
      const v = r[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (k && v && v !== '%') out[key][k] = v; // bare "%" = no value on the page
    });
  });

  return out;
}

// Key ratios from the company page's <ul id="top-ratios"> block:
// Market Cap, Current Price, High / Low, Stock P/E, Book Value,
// Dividend Yield, ROCE, ROE, Face Value.
// Returns { name: { value, unit, display } } — display is render-ready
// (e.g. "₹ 57,078 Cr.", "₹ 35,310 / 25,150", "1.95 %").
function parseTopRatios(html) {
  const block = (html.match(/<ul id="top-ratios"[\s\S]*?<\/ul>/i) || [])[0] || '';
  const out   = {};

  [...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].forEach(m => {
    const nameMatch = m[1].match(
      /<span[^>]*class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/span>/i
    );
    if (!nameMatch) return;
    const name = nameMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    const numbers = [...m[1].matchAll(
      /<span[^>]*class="[^"]*number[^"]*"[^>]*>([\s\S]*?)<\/span>/gi
    )].map(n => n[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
    if (!name || numbers.length === 0) return;

    const flat = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const unit = flat.includes('₹') && flat.includes('Cr') ? '₹Cr'
      : flat.includes('₹') ? '₹'
      : flat.includes('%') ? '%'
      : '';

    const value   = numbers.join(' / ');
    const display = (unit.startsWith('₹') ? '₹ ' : '') + value
      + (unit === '₹Cr' ? ' Cr.' : unit === '%' ? ' %' : '');

    out[name] = { value, unit, display };
  });

  return out;
}

function parseQuickRatios(html) {
  const ratios  = {};
  const matches = [...html.matchAll(
    /<li[^>]*data-source="quick-ratio"[^>]*>([\s\S]*?)<\/li>/gi
  )];

  matches.forEach(m => {
    const nameMatch = m[1].match(
      /<span[^>]*class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/span>/i
    );
    const numMatch  = m[1].match(
      /<span[^>]*class="[^"]*number[^"]*"[^>]*>([\s\S]*?)<\/span>/i
    );
    const unitMatch = m[1].match(
      /class="[^"]*nowrap value[^"]*"[^>]*>([\s\S]*?)<\/span>/i
    );

    if (!nameMatch) return;

    const name  = nameMatch[1].replace(/<[^>]+>/g, '').trim();
    const value = numMatch
      ? numMatch[1].replace(/<[^>]+>/g, '').replace(/,/g, '').trim()
      : '';

    // Detect unit (₹, %, Cr.)
    const unitRaw = unitMatch
      ? unitMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : '';
    const unit = unitRaw.includes('₹')  ? '₹'
      : unitRaw.includes('%')  ? '%'
      : unitRaw.includes('Cr') ? 'Cr'
      : '';

    if (name) ratios[name] = { value, unit };
  });

  return ratios;
}

// Main results table on a screener.in "screen" (saved query) page.
// Logged-in requests render whatever columns the account has configured
// (custom columns), rather than the public default set.
// NOTE: this table has no <thead> — the header row is just the first
// <tr> (with <th> cells) sitting directly inside <tbody>, data rows are
// <tr data-row-company-id="..."> with plain <td> cells.
function parseScreenTable(html) {
  const table = (html.match(
    /<table[^>]*class="[^"]*data-table[^"]*"[\s\S]*?<\/table>/i
  ) || [])[0];
  if (!table) return { headers: [], rows: [] };

  const trBlocks = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (trBlocks.length === 0) return { headers: [], rows: [] };

  const headers = [...trBlocks[0][1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)]
    .map(h => h[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (headers.length === 0) return { headers: [], rows: [] };

  const rows = [];
  trBlocks.slice(1).forEach(tr => {
    // Keep the raw (pre-strip) cell HTML around just long enough to pull
    // the Name cell's /company/<SYMBOL>/ link before it's thrown away —
    // that link is the only exact stock identity screener.in gives us.
    const rawCells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(td => td[1]);
    if (rawCells.length === 0) return;

    const cells = rawCells.map(raw => raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ').trim());

    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = normalizeCell(cells[i] !== undefined ? cells[i] : '');
    });

    const linkCellRaw = rawCells.find(raw => /href="[^"]*\/company\//i.test(raw));
    if (linkCellRaw) {
      const hrefMatch = linkCellRaw.match(/href="([^"]*\/company\/[^"]*)"/i);
      if (hrefMatch) obj._link = hrefMatch[1];
    }

    rows.push(obj);
  });

  return { headers, rows };
}

function parseScreenTotalPages(html) {
  const m = html.match(/Page\s+\d+\s+of\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : 1;
}

function parsePeersHTML(html) {
  if (!html || !html.includes('<table')) {
    return { headers: [], rows: [] };
  }

  // Extract headers
  const headers = [];
  const thMatches = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)];
  thMatches.forEach(th => {
    const tooltip = (th[0].match(/data-tooltip="([^"]*)"/) || [])[1] || '';
    const text    = th[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    headers.push(tooltip || text);
  });

  // Extract rows
  const rows     = [];
  const trMatch  = [...html.matchAll(
    /<tr[^>]*data-row-company-id="(\d+)"[^>]*>([\s\S]*?)<\/tr>/gi
  )];

  trMatch.forEach(tr => {
    const cells = [...tr[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(td => td[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());

    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] || ''; });
    rows.push(row);
  });

  return { headers, rows };
}

app.listen(PORT, () => {
  console.log('Screener proxy running on port ' + PORT);
  // Warm both sessions at boot (non-fatal — heals on first request anyway)
  session.ensure().catch(e => console.log('⚠️ startup login: ' + e.message));
  nseSession.ensure().catch(e => console.log('⚠️ startup NSE warm: ' + e.message));
});
