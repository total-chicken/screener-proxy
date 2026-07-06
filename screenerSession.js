// ============================================================
// screenerSession.js — self-refreshing screener.in session
//
// Logs in with SCREENER_EMAIL / SCREENER_PASSWORD (Render env vars)
// and keeps csrftoken + sessionid in memory. When screener.in
// rejects a request, callers ask for refresh() and retry once —
// no more manual cookie updates.
//
// Legacy SESSION_ID / CSRF_TOKEN env vars are used as the initial
// seed if present, so the first deploy needs no downtime; once they
// expire the auto-login takes over permanently.
// ============================================================

const fetch = require('node-fetch');

const LOGIN_URL = 'https://www.screener.in/login/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let cookies = {
  csrftoken: process.env.CSRF_TOKEN || '',
  sessionid: process.env.SESSION_ID || ''
};
let loginPromise = null; // dedupes concurrent refreshes

function cookieHeader() {
  return `csrftoken=${cookies.csrftoken}; sessionid=${cookies.sessionid}`;
}

function parseSetCookie(resp) {
  const out = {};
  const raw = (resp.headers.raw && resp.headers.raw()['set-cookie']) || [];
  raw.forEach(c => {
    const m = c.match(/^(csrftoken|sessionid)=([^;]+)/);
    if (m) out[m[1]] = m[2];
  });
  return out;
}

async function login() {
  if (!process.env.SCREENER_EMAIL || !process.env.SCREENER_PASSWORD) {
    throw new Error('SCREENER_EMAIL / SCREENER_PASSWORD env vars not set');
  }

  // Step 1: login page → csrftoken cookie + hidden csrfmiddlewaretoken
  const page = await fetch(LOGIN_URL, { headers: { 'User-Agent': UA } });
  if (page.status !== 200) {
    throw new Error('Login page returned HTTP ' + page.status);
  }
  const pre = parseSetCookie(page);
  const html = await page.text();
  const tokenMatch = html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/);
  if (!pre.csrftoken || !tokenMatch) {
    throw new Error('Could not extract CSRF token from login page');
  }

  // Step 2: POST credentials → 302 with fresh sessionid + csrftoken
  const form = new URLSearchParams({
    username: process.env.SCREENER_EMAIL,
    password: process.env.SCREENER_PASSWORD,
    csrfmiddlewaretoken: tokenMatch[1]
  });

  const resp = await fetch(LOGIN_URL, {
    method: 'POST',
    redirect: 'manual', // must see the 302 + Set-Cookie ourselves
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': 'csrftoken=' + pre.csrftoken,
      'Referer': LOGIN_URL,
      'User-Agent': UA
    },
    body: form.toString()
  });

  // 200 here means the login form was re-rendered → bad credentials
  if (resp.status !== 302) {
    throw new Error('screener.in login rejected (HTTP ' + resp.status +
                    ') — check SCREENER_EMAIL / SCREENER_PASSWORD');
  }

  const post = parseSetCookie(resp);
  if (!post.sessionid) {
    throw new Error('Login succeeded but no sessionid cookie received');
  }

  cookies = {
    csrftoken: post.csrftoken || pre.csrftoken,
    sessionid: post.sessionid
  };
  console.log('✅ screener.in session refreshed at ' + new Date().toISOString());
}

// Force a fresh login (concurrent callers share one login request)
function refresh() {
  if (!loginPromise) {
    loginPromise = login().finally(() => { loginPromise = null; });
  }
  return loginPromise;
}

// Make sure we have *some* session (seed cookies count; they heal on failure)
async function ensure() {
  if (!cookies.sessionid) await refresh();
}

module.exports = { cookieHeader, ensure, refresh };
