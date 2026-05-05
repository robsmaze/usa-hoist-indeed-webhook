// Health check for the hiring pipeline.
//
// Pinged by `~/usa-hoist-hiring/run-hiring-pull.sh` before it invokes the
// Indeed puller, so a broken webhook surfaces immediately instead of being
// discovered by a human reading the next morning's digest.
//
// GET /api/health
//   200 → { ok: true, checks: { env: {...}, blob: "ok", kv: "ok" } }
//   500 → { ok: false, checks: {...} }   (with the failing check named)
//
// No auth: the response only reports presence of env vars, not values, and
// the underlying probes are cheap reads. Public-by-design so any monitor
// (launchd, uptime service, oncall) can call it without a shared secret.

import { list } from '@vercel/blob';
import { kv } from '@vercel/kv';

export const config = {
  runtime: 'nodejs',
};

const REQUIRED_ENV = [
  'INDEED_WEBHOOK_SECRET',
  'PULL_API_KEY',
  'BLOB_READ_WRITE_TOKEN',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'HIRING_API_TOKEN',
  'ANTHROPIC_API_KEY',
];

const INDEED_COOKIES_KEY = 'hiring:indeed:cookies';
const STALE_BUFFER_SEC = 60;
const EXPIRING_SOON_SEC = 5 * 60;

// Mirrors the classify() logic in api/indeed-cookies.js. Kept as a tiny
// duplicate rather than a shared import so health.js stays import-light.
function classifyIndeedCookies(rec) {
  if (!rec || !rec.cookies || !rec.jwt_exp) return { status: 'missing', minutes_remaining: null };
  const now = Math.floor(Date.now() / 1000);
  const minutes = Math.max(0, Math.round((rec.jwt_exp - now) / 60));
  if (rec.jwt_exp <= now + STALE_BUFFER_SEC) return { status: 'stale', minutes_remaining: minutes };
  if (rec.jwt_exp <= now + EXPIRING_SOON_SEC) return { status: 'expiring_soon', minutes_remaining: minutes };
  return { status: 'valid', minutes_remaining: minutes };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const checks = { env: {}, blob: 'pending', kv: 'pending' };
  let ok = true;

  // Env presence (booleans only — never echo values).
  for (const k of REQUIRED_ENV) {
    const present = Boolean(process.env[k]);
    checks.env[k] = present;
    if (!present) ok = false;
  }

  // Blob read probe — listing a non-existent prefix is fine; we just need
  // the SDK to authenticate against the store.
  try {
    await list({ prefix: '__health__/', limit: 1 });
    checks.blob = 'ok';
  } catch (e) {
    checks.blob = `error: ${e?.message || String(e)}`;
    ok = false;
  }

  // KV read probe.
  try {
    await kv.get('__health__');
    checks.kv = 'ok';
  } catch (e) {
    checks.kv = `error: ${e?.message || String(e)}`;
    ok = false;
  }

  // Indeed cookies freshness — non-fatal (a missing cookie set is the
  // expected initial state on a fresh deploy). Surfaced so the dashboard
  // can show a "paste fresh cookies" banner.
  try {
    const rec = await kv.get(INDEED_COOKIES_KEY);
    checks.indeed_cookies = classifyIndeedCookies(rec);
  } catch (e) {
    checks.indeed_cookies = { status: 'error', error: e?.message || String(e) };
  }

  return res.status(ok ? 200 : 500).json({
    ok,
    checks,
    checked_at: new Date().toISOString(),
  });
}
