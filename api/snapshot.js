// Roster snapshot writer.
//
// The Mac-side regenerator (or a future Vercel cron) POSTs the unified
// candidate roster here. /api/candidates reads the most recent upload.
//
// POST /api/snapshot
//   body: { candidates: [...], generated_at?, data_window? }
//   200  → { ok: true, pathname, url, size, uploaded_at }
//   400  → body shape invalid
//   401  → missing/wrong X-Hiring-Token
//
// Required env vars:
//   HIRING_API_TOKEN       — same secret the dashboard + /api/candidates use
//   BLOB_READ_WRITE_TOKEN  — auto-injected when Blob is attached

import { put } from '@vercel/blob';

export const config = {
  runtime: 'nodejs',
  // Allow up to 60s — the roster JSON can be a few MB once we include
  // experiences/education detail across many candidates.
  maxDuration: 60,
};

const SNAPSHOT_PATH = 'hiring/roster.json';
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  // Vercel usually parses JSON automatically, but if a caller sets a different
  // content-type we read the raw stream as a fallback.
  let raw = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error(`body exceeds ${MAX_BODY_BYTES} bytes`);
    raw += chunk.toString('utf8');
  }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const expected = process.env.HIRING_API_TOKEN;
  if (!expected) {
    return res.status(500).json({ error: 'HIRING_API_TOKEN not configured' });
  }
  if (req.headers['x-hiring-token'] !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return res.status(400).json({ error: e?.message || 'failed to read body' });
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'expected JSON body' });
  }
  if (!Array.isArray(body.candidates)) {
    return res.status(400).json({ error: 'body.candidates must be an array' });
  }

  // Stamp generated_at if the caller didn't.
  const payload = {
    ...body,
    generated_at: body.generated_at || new Date().toISOString(),
  };
  const json = JSON.stringify(payload);

  try {
    const blob = await put(SNAPSHOT_PATH, json, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: true,
      allowOverwrite: true,
    });
    return res.status(200).json({
      ok: true,
      pathname: blob.pathname,
      url: blob.url,
      size: json.length,
      candidates: payload.candidates.length,
      uploaded_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('snapshot put error:', e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
