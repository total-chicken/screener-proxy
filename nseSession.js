// ============================================================
// nseSession.js — self-refreshing nseindia.com session
//
// nseindia.com's JSON APIs sit behind Akamai bot protection: a request
// with no prior cookie jar gets rejected, so (like screenerSession.js
// does for screener.in) we warm a real page first, keep whatever
// Set-Cookie headers it hands back, and reuse them on the API calls.
// No login/credentials needed here — it's public data, just gated on
// having *a* browser-shaped session.
// ============================================================

const fetch = require('node-fetch');

const NSE_BASE = 'https://www.nseindia.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let cookieJar    = {}; // name -> value, merged across every warm()
let warmPromise  = null; // dedupes concurrent refreshes

function cookieHeader() {
  return Object.keys(cookieJar).map(k => `${k}=${cookieJar[k]}`).join('; ');
}

function mergeSetCookie(resp) {
  const raw = (resp.headers.raw && resp.headers.raw()['set-cookie']) || [];
  raw.forEach(c => {
    const m = c.match(/^([^=]+)=([^;]*)/);
    if (m) cookieJar[m[1]] = m[2];
  });
}

async function warm() {
  const resp = await fetch(NSE_BASE, {
    headers: {
      'User-Agent'     : UA,
      'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  mergeSetCookie(resp);
  console.log('✅ NSE session warmed at ' + new Date().toISOString() +
              ' (' + Object.keys(cookieJar).length + ' cookies)');
}

function refresh() {
  if (!warmPromise) {
    cookieJar = {};
    warmPromise = warm().finally(() => { warmPromise = null; });
  }
  return warmPromise;
}

async function ensure() {
  if (Object.keys(cookieJar).length === 0) await refresh();
}

module.exports = { cookieHeader, ensure, refresh };
