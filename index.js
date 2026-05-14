const express  = require('express');
const fetch    = require('node-fetch');
const app      = express();
// ── CORS — allow all origins ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'x-api-key, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT        = process.env.PORT        || 3000;
const SESSION_ID  = process.env.SESSION_ID  || '';
const CSRF_TOKEN  = process.env.CSRF_TOKEN  || '';
const API_KEY     = process.env.API_KEY     || '';

const COOKIE = `sessionid=${SESSION_ID}; csrftoken=${CSRF_TOKEN}`;
const SCREENER_BASE = 'https://www.screener.in';

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

// ── Get warehouse ID from stock symbol ──
// GET /warehouse?symbol=INFY
app.get('/warehouse', checkKey, async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol required' });
  }

  try {
    const urls = [
      `${SCREENER_BASE}/company/${symbol}/consolidated/`,
      `${SCREENER_BASE}/company/${symbol}/`
    ];

    for (const url of urls) {
      const resp = await fetch(url, {
        headers: {
          'Cookie'    : COOKIE,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
        }
      });

      if (resp.status !== 200) continue;

      const html = await resp.text();

      // Check not login wall
      if (html.includes('id="login-form"')) {
        return res.status(401).json({
          error  : 'Cookie expired — update SESSION_ID and CSRF_TOKEN'
        });
      }

      // Extract warehouse ID
      const match = html.match(/data-warehouse-id="(\d+)"/);
      if (match) {
        return res.json({
          symbol      : symbol,
          warehouse_id: match[1],
          url         : url
        });
      }
    }

    res.status(404).json({ error: 'Warehouse ID not found for: ' + symbol });

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
    const url  = `${SCREENER_BASE}/api/company/${wid}/quick_ratios/`;
    const resp = await fetch(url, {
      headers: {
        'Cookie'           : COOKIE,
        'X-Requested-With' : 'XMLHttpRequest',
        'Referer'          : `${SCREENER_BASE}/company/`,
        'User-Agent'       : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
      }
    });

    if (resp.status === 403 || resp.status === 401) {
      return res.status(401).json({
        error: 'Cookie expired — update SESSION_ID and CSRF_TOKEN'
      });
    }

    const html   = await resp.text();
    const ratios = parseQuickRatios(html);

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
    const url  = `${SCREENER_BASE}/api/company/${wid}/peers/`;
    const resp = await fetch(url, {
      headers: {
        'Cookie'           : COOKIE,
        'X-Requested-With' : 'XMLHttpRequest',
        'Referer'          : `${SCREENER_BASE}/company/`,
        'User-Agent'       : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
      }
    });

    if (resp.status === 403 || resp.status === 401) {
      return res.status(401).json({
        error: 'Cookie expired — update SESSION_ID and CSRF_TOKEN'
      });
    }

    const html  = await resp.text();
    const peers = parsePeersHTML(html);

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
    const urls = [
      `${SCREENER_BASE}/company/${symbol}/consolidated/`,
      `${SCREENER_BASE}/company/${symbol}/`
    ];

    let warehouseId = null;
    let stockUrl    = null;

    for (const url of urls) {
      const resp = await fetch(url, {
        headers: {
          'Cookie'    : COOKIE,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
        }
      });

      if (resp.status !== 200) continue;
      const html  = await resp.text();

      if (html.includes('id="login-form"')) {
        return res.status(401).json({
          error: 'Cookie expired — update SESSION_ID and CSRF_TOKEN'
        });
      }

      const match = html.match(/data-warehouse-id="(\d+)"/);
      if (match) {
        warehouseId = match[1];
        stockUrl    = url;
        break;
      }
    }

    if (!warehouseId) {
      return res.status(404).json({
        error: 'Stock not found on screener.in: ' + symbol
      });
    }

    // Step 2: Fetch ratios and peers in parallel
    const [ratiosResp, peersResp] = await Promise.all([
      fetch(`${SCREENER_BASE}/api/company/${warehouseId}/quick_ratios/`, {
        headers: {
          'Cookie'           : COOKIE,
          'X-Requested-With' : 'XMLHttpRequest',
          'Referer'          : stockUrl,
          'User-Agent'       : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
        }
      }),
      fetch(`${SCREENER_BASE}/api/company/${warehouseId}/peers/`, {
        headers: {
          'Cookie'           : COOKIE,
          'X-Requested-With' : 'XMLHttpRequest',
          'Referer'          : stockUrl,
          'User-Agent'       : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
        }
      })
    ]);

    const ratiosHTML = await ratiosResp.text();
    const peersHTML  = await peersResp.text();

    const ratios = parseQuickRatios(ratiosHTML);
    const peers  = parsePeersHTML(peersHTML);

    res.json({
      symbol,
      warehouse_id: warehouseId,
      screener_url: stockUrl,
      ratios,
      peers,
      fetched_at  : new Date().toISOString()
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PARSERS ──

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
});
