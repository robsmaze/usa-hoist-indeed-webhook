// Server-side resume import.
//
// Local Node 25 + @vercel/blob has a "Cannot convert argument to a ByteString"
// bug that breaks `put()` from the macOS dev environment (also affects the
// Vercel CLI). This endpoint sidesteps it by doing the download + upload
// entirely server-side on Vercel's Node 20 runtime.
//
// POST /api/import-resume
//   body: {
//     source_url: string,    // the URL to fetch (e.g. Indeed resume download URL)
//     cookie:     string,    // cookie header to send to source_url (sensitive — DO NOT log)
//     target_path: string,   // Blob path to write to, e.g. "resumes/indeed/<id>.pdf"
//     content_type?: string  // optional; otherwise inferred from source response
//   }
//   200 → { ok: true, blob_url, blob_pathname, size, content_type }
//   401 → bad X-Hiring-Token
//   400 → invalid body
//   502 → source fetch failed
//
// Auth: HIRING_API_TOKEN (same shared secret as the rest of the dashboard).
//
// Required env vars: HIRING_API_TOKEN, BLOB_READ_WRITE_TOKEN.

import { put } from '@vercel/blob';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

const MAX_BODY_BYTES = 200 * 1024;   // small request body (just URL + cookie + path)
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20MB resume cap

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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const expected = process.env.HIRING_API_TOKEN;
  if (!expected) return res.status(500).json({ error: 'HIRING_API_TOKEN not configured' });
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
  const { source_url, cookie, target_path, content_type } = body;
  if (!source_url || typeof source_url !== 'string' || !/^https:\/\//.test(source_url)) {
    return res.status(400).json({ error: 'source_url must be an https URL' });
  }
  if (!target_path || typeof target_path !== 'string') {
    return res.status(400).json({ error: 'target_path is required' });
  }
  // target_path safety — keep writes inside our intended namespaces only
  if (!/^resumes\/[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(target_path)) {
    return res.status(400).json({ error: 'target_path must match resumes/<source>/<filename>' });
  }

  // 1. Download from source.
  let buffer, sourceCt;
  try {
    const headers = {
      'referer': 'https://employers.indeed.com/',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    };
    if (cookie && typeof cookie === 'string') headers.cookie = cookie;
    const r = await fetch(source_url, { headers });
    if (!r.ok) {
      return res.status(502).json({ error: `source fetch HTTP ${r.status}`, detail: (await r.text()).slice(0, 200) });
    }
    sourceCt = r.headers.get('content-type') || 'application/octet-stream';
    const ab = await r.arrayBuffer();
    if (ab.byteLength > MAX_DOWNLOAD_BYTES) {
      return res.status(413).json({ error: `download exceeds ${MAX_DOWNLOAD_BYTES} bytes (${ab.byteLength})` });
    }
    buffer = Buffer.from(ab);
  } catch (e) {
    return res.status(502).json({ error: `source fetch failed: ${e?.message || e}` });
  }

  // 2. Upload to Blob.
  try {
    const ct = content_type || sourceCt || 'application/pdf';
    const blob = await put(target_path, buffer, {
      access: 'public',
      contentType: ct,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return res.status(200).json({
      ok: true,
      blob_url: blob.url,
      blob_pathname: blob.pathname,
      size: buffer.length,
      content_type: ct,
    });
  } catch (e) {
    return res.status(500).json({ error: `blob put failed: ${e?.message || e}` });
  }
}
