// Indeed session cookie storage.
//
// Indeed Employer's GraphQL API requires a logged-in browser session. We
// don't reverse-engineer their token-refresh flow; instead Robby pastes
// fresh cookies through the dashboard's "Indeed Auth" modal whenever the
// previous bearer token has expired (~ hourly under normal idle session).
//
// Stored at KV key `hiring:indeed:cookies` as:
//   {
//     cookies:      "<the full Cookie header value>",
//     fetched_at:   "<ISO timestamp of paste>",
//     jwt_iat:      <Unix seconds — bearer issued-at>,
//     jwt_exp:      <Unix seconds — bearer expires-at>,
//     user_email:   "<from PPID JWT, for sanity>"
//   }
//
// API:
//   GET  /api/indeed-cookies → status only:
//        {
//          has_cookies, fetched_at, jwt_exp, minutes_remaining, user_email,
//          status: "missing" | "expiring_soon" | "stale" | "valid"
//        }
//        NEVER returns the cookie string itself.
//
//   POST /api/indeed-cookies  body: { cookies }
//        → { ok, fetched_at, jwt_exp, minutes_remaining, status }
//
// Auth: shared X-Hiring-Token header (same as the dashboard's other endpoints).

import { kv } from '@vercel/kv';

export const config = {
  runtime: 'nodejs',
};

const KV_KEY = 'hiring:indeed:cookies';
const STALE_BUFFER_SEC = 60;          // treat as stale this many seconds before exp
const EXPIRING_SOON_SEC = 5 * 60;     // amber state — refresh recommended

function authOk(req) {
  const expected = process.env.HIRING_API_TOKEN;
  if (!expected) return false;
  return req.headers['x-hiring-token'] === expected;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  let raw = '';
  for await (const chunk of req) raw += chunk.toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Parse a JWT's payload without verifying signature (we just need iat/exp/email).
function parseJwt(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const parts = tok.split('.');
  if (parts.length < 2) return null;
  try {
    let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// Pull a named cookie value out of the full Cookie header string.
function getCookieValue(cookieStr, name) {
  if (!cookieStr) return null;
  const re = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`);
  const m = re.exec(cookieStr);
  return m ? decodeURIComponent(m[1]) : null;
}

function classify(jwtExp) {
  if (!jwtExp) return 'missing';
  const now = Math.floor(Date.now() / 1000);
  if (jwtExp <= now + STALE_BUFFER_SEC) return 'stale';
  if (jwtExp <= now + EXPIRING_SOON_SEC) return 'expiring_soon';
  return 'valid';
}

function statusPayload(rec) {
  if (!rec || !rec.cookies) {
    return { has_cookies: false, status: 'missing', fetched_at: null, jwt_exp: null,
             minutes_remaining: null, user_email: null };
  }
  const now = Math.floor(Date.now() / 1000);
  const minutes = rec.jwt_exp ? Math.max(0, Math.round((rec.jwt_exp - now) / 60)) : null;
  return {
    has_cookies: true,
    status: classify(rec.jwt_exp),
    fetched_at: rec.fetched_at || null,
    jwt_exp: rec.jwt_exp || null,
    minutes_remaining: minutes,
    user_email: rec.user_email || null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hiring-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!process.env.HIRING_API_TOKEN) {
    return res.status(500).json({ error: 'HIRING_API_TOKEN not configured' });
  }
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });

  if (req.method === 'GET') {
    try {
      const rec = await kv.get(KV_KEY);
      return res.status(200).json(statusPayload(rec));
    } catch (e) {
      console.error('indeed-cookies GET error:', e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (!body || typeof body.cookies !== 'string') {
      return res.status(400).json({ error: 'body.cookies (string) is required' });
    }
    const cookies = body.cookies.trim();
    if (cookies.length < 200) {
      return res.status(400).json({ error: 'cookie string looks too short — paste the full Cookie header value' });
    }
    // Surgical sanity check: bearer JWT must be present and parseable.
    const bearer = getCookieValue(cookies, '__Secure-PassportAuthProxy-BearerToken');
    if (!bearer) {
      return res.status(400).json({ error: 'cookie string is missing __Secure-PassportAuthProxy-BearerToken — likely incomplete' });
    }
    const bearerPayload = parseJwt(bearer);
    if (!bearerPayload || !bearerPayload.exp) {
      return res.status(400).json({ error: 'could not parse bearer JWT — paste may be corrupted' });
    }
    // PPID JWT carries the user email — handy for sanity ("we're authed as the right person").
    const ppid = getCookieValue(cookies, 'PPID');
    const ppidPayload = parseJwt(ppid);
    const userEmail = ppidPayload?.email || null;

    const rec = {
      cookies,
      fetched_at: new Date().toISOString(),
      jwt_iat: bearerPayload.iat || null,
      jwt_exp: bearerPayload.exp,
      user_email: userEmail,
    };
    try {
      await kv.set(KV_KEY, rec);
      return res.status(200).json({ ok: true, ...statusPayload(rec) });
    } catch (e) {
      console.error('indeed-cookies POST error:', e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).json({ error: 'method not allowed' });
}
