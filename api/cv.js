// Lazy CV fetcher — used when a hiring manager opens a candidate in the
// dashboard. The cron only collects metadata; PDF download happens on demand
// here. PDFs are cached in Blob at a predictable path so repeat opens are
// served from cache without hitting LinkupAPI again.
//
// GET /api/cv?application_id=<id>&source=<linkedin|indeed>[&indeed_blob_pathname=<path>]
//
//   200 → { ok: true, url, source, cached: bool, content_type, size }
//   400 → missing/invalid params
//   401 → bad X-Hiring-Token
//   404 → CV not available (no resume on file, or LinkupAPI returned empty)
//
// Cache layout in Blob:
//   resumes/linkedin/<application_id>.<ext>
//   resumes/indeed/<application_id>.<ext>
// addRandomSuffix:false + allowOverwrite:true → stable URL across calls.
//
// For Indeed, we still need the original webhook-payload Blob path to extract
// the base64 PDF — the dashboard passes it via indeed_blob_pathname (the
// cron stamps each roster record with this).
//
// Required env vars: HIRING_API_TOKEN, BLOB_READ_WRITE_TOKEN,
//   USAHOIST_LINKUPAPI_KEY, USAHOIST_LINKUPAPI_ACCOUNT_ID.

import { list, put } from '@vercel/blob';

export const config = {
  runtime: 'nodejs',
  // LinkupAPI get_cv is the slow path (~9s), and base64 decoding can take
  // a moment for large PDFs. Cap generously.
  maxDuration: 60,
};

const LINKUPAPI_URL = 'https://api.linkupapi.com/v2/recruiter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick(obj, ...path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function safeSlug(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'x';
}

function inferExt(contentType, filename) {
  if (filename) {
    const m = /\.([A-Za-z0-9]{2,5})$/.exec(filename);
    if (m) return '.' + m[1].toLowerCase();
  }
  if (typeof contentType === 'string') {
    if (/wordprocessingml/.test(contentType)) return '.docx';
    if (/msword/.test(contentType)) return '.doc';
    if (/pdf/.test(contentType)) return '.pdf';
  }
  return '.pdf';
}

async function findCachedCV(source, applicationId) {
  const prefix = `resumes/${source}/${safeSlug(applicationId)}`;
  const page = await list({ prefix, limit: 5 });
  const blobs = (page.blobs || []).filter((b) => {
    // Match resumes/<source>/<aid>.ext exactly (no nested paths).
    const remainder = b.pathname.slice(prefix.length);
    return remainder.startsWith('.') && !remainder.includes('/');
  });
  return blobs[0] || null;
}

// ---------------------------------------------------------------------------
// LinkedIn — call LinkupAPI get_cv to retrieve the PDF.
// ---------------------------------------------------------------------------

async function fetchLinkedInCV(applicationId) {
  const r = await fetch(LINKUPAPI_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.USAHOIST_LINKUPAPI_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      account_id: process.env.USAHOIST_LINKUPAPI_ACCOUNT_ID,
      action: 'get_cv',
      params: { application_id: String(applicationId) },
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`LinkupAPI get_cv HTTP ${r.status}: ${text.slice(0, 300)}`);
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`get_cv non-JSON: ${text.slice(0, 200)}`); }
  const cv = pick(json, 'data', 'cv') || {};
  const contentB64 = cv.content;
  if (!contentB64) {
    return { found: false, reason: 'no content in LinkupAPI get_cv response' };
  }
  const buffer = Buffer.from(contentB64, 'base64');
  const contentType = cv.content_type || 'application/pdf';
  const filename = cv.filename || '';
  return { found: true, buffer, contentType, filename };
}

// ---------------------------------------------------------------------------
// Indeed — extract the base64 PDF from the original webhook-payload Blob.
// ---------------------------------------------------------------------------

async function fetchIndeedCV(blobPathname) {
  // List under the parent prefix to find the random-suffixed blob URL.
  const lastSlash = blobPathname.lastIndexOf('/');
  const prefix = lastSlash >= 0 ? blobPathname.slice(0, lastSlash + 1) : blobPathname;
  // Match pathname exactly (the cron stores the canonical pathname; if the
  // current blob URL has a different random suffix, we still need to find it
  // via list under the prefix and match on pathname).
  const candidates = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    candidates.push(...(page.blobs || []));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  // Find by exact pathname match first; otherwise fall back to startsWith
  // since older blobs might have had different suffixes.
  let target = candidates.find((b) => b.pathname === blobPathname);
  if (!target) {
    const stem = blobPathname.replace(/\.json$/, '');
    target = candidates.find((b) => b.pathname.startsWith(stem));
  }
  if (!target) {
    return { found: false, reason: `no Blob found for pathname=${blobPathname}` };
  }

  const r = await fetch(target.url);
  if (!r.ok) return { found: false, reason: `Blob fetch HTTP ${r.status}` };
  const payload = await r.json();

  const fileObj = pick(payload, 'applicant', 'resume', 'file')
              || pick(payload, 'resume', 'file')
              || pick(payload, 'applicant', 'file');
  if (!fileObj || typeof fileObj !== 'object') {
    return { found: false, reason: 'no resume.file on Indeed payload' };
  }
  const contentB64 = fileObj.content || fileObj.contents || fileObj.data;
  if (!contentB64) {
    return { found: false, reason: 'resume.file has no content' };
  }
  const buffer = Buffer.from(contentB64, 'base64');
  const contentType = fileObj.contentType || fileObj.content_type || 'application/pdf';
  const filename = fileObj.filename || fileObj.name || '';
  return { found: true, buffer, contentType, filename };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const expected = process.env.HIRING_API_TOKEN;
  if (!expected) return res.status(500).json({ error: 'HIRING_API_TOKEN not configured' });
  if (req.headers['x-hiring-token'] !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const applicationId = String(req.query.application_id || '').trim();
  const source = String(req.query.source || '').trim().toLowerCase();
  const indeedBlobPathname = String(req.query.indeed_blob_pathname || '').trim();

  if (!applicationId) return res.status(400).json({ error: 'application_id is required' });
  if (source !== 'linkedin' && source !== 'indeed') {
    return res.status(400).json({ error: "source must be 'linkedin' or 'indeed'" });
  }
  if (source === 'indeed' && !indeedBlobPathname) {
    return res.status(400).json({ error: 'indeed_blob_pathname is required when source=indeed' });
  }

  // 1. Cache hit?
  try {
    const cached = await findCachedCV(source, applicationId);
    if (cached) {
      return res.status(200).json({
        ok: true,
        cached: true,
        source,
        url: cached.url,
        pathname: cached.pathname,
        size: cached.size,
        uploaded_at: cached.uploadedAt,
      });
    }
  } catch (e) {
    // Cache lookup failure is non-fatal; fall through to fresh fetch.
    console.warn('cv cache lookup failed:', e?.message || e);
  }

  // 2. Fetch from upstream.
  let result;
  try {
    if (source === 'linkedin') {
      result = await fetchLinkedInCV(applicationId);
    } else {
      result = await fetchIndeedCV(indeedBlobPathname);
    }
  } catch (e) {
    return res.status(502).json({ error: `upstream fetch failed: ${e?.message || e}` });
  }
  if (!result.found) {
    return res.status(404).json({ error: 'CV not available', detail: result.reason });
  }

  // 3. Upload to cache.
  const ext = inferExt(result.contentType, result.filename);
  const cachePath = `resumes/${source}/${safeSlug(applicationId)}${ext}`;
  let blob;
  try {
    blob = await put(cachePath, result.buffer, {
      access: 'public',
      contentType: result.contentType || 'application/pdf',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch (e) {
    return res.status(500).json({ error: `cache write failed: ${e?.message || e}` });
  }

  return res.status(200).json({
    ok: true,
    cached: false,
    source,
    url: blob.url,
    pathname: blob.pathname,
    content_type: result.contentType,
    size: result.buffer.length,
  });
}
