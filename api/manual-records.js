// Manual records — hand-curated candidates (and grade overrides) the cron
// merges into the roster. Today the Mac maintains this list locally; the
// cron reads it from Blob.
//
// Stored at `hiring/manual-records.json` in Blob.
//
// GET  /api/manual-records         → { records: [...] }
// POST /api/manual-records         body: array of records OR { records: [...] }
//                                   → { ok: true, count, pathname, url }
//
// Auth: X-Hiring-Token (same shared secret as the rest of the dashboard).
//
// Required env vars: HIRING_API_TOKEN, BLOB_READ_WRITE_TOKEN.

import { list, put } from '@vercel/blob';

export const config = { runtime: 'nodejs', maxDuration: 30 };

const PREFIX = 'hiring/manual-records';
const PATH = `${PREFIX}.json`;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
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

  const expected = process.env.HIRING_API_TOKEN;
  if (!expected) return res.status(500).json({ error: 'HIRING_API_TOKEN not configured' });
  if (req.headers['x-hiring-token'] !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (req.method === 'GET') {
    try {
      const page = await list({ prefix: PREFIX, limit: 100 });
      const blobs = (page.blobs || []).sort((a, b) =>
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
      );
      if (blobs.length === 0) {
        return res.status(200).json({ records: [], note: 'no manual records uploaded yet' });
      }
      const r = await fetch(blobs[0].url);
      if (!r.ok) return res.status(502).json({ error: `blob fetch failed: HTTP ${r.status}` });
      const text = await r.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = []; }
      const records = Array.isArray(parsed) ? parsed : (parsed.records || []);
      res.setHeader('X-Records-Uploaded-At', blobs[0].uploadedAt);
      return res.status(200).json({ records });
    } catch (e) {
      console.error('manual-records GET error:', e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return res.status(400).json({ error: e?.message || 'failed to read body' });
    }
    const records = Array.isArray(body) ? body : (body && Array.isArray(body.records) ? body.records : null);
    if (!records) {
      return res.status(400).json({ error: 'body must be an array or { records: [...] }' });
    }
    try {
      const json = JSON.stringify(records);
      const blob = await put(PATH, json, {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: true,
        allowOverwrite: true,
      });
      return res.status(200).json({
        ok: true,
        count: records.length,
        pathname: blob.pathname,
        url: blob.url,
        size: json.length,
      });
    } catch (e) {
      console.error('manual-records POST error:', e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
}
