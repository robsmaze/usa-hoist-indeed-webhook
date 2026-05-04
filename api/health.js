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
];

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

  return res.status(ok ? 200 : 500).json({
    ok,
    checks,
    checked_at: new Date().toISOString(),
  });
}
