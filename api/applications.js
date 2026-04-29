// List applications received from Indeed for a given day.
//
// Called by the Mac-side pull script (`pull_indeed_applicants.py`). Returns
// an index of every blob under `indeed/{since}/...` so the puller can
// download each application JSON.
//
// GET /api/applications?since=YYYY-MM-DD
//
// Required env vars:
//   PULL_API_KEY            — shared secret. The Mac script sends it in the
//                              X-Pull-Api-Key header.
//   BLOB_READ_WRITE_TOKEN   — automatic when Blob is attached to the project.

import { list } from '@vercel/blob';

export const config = {
  runtime: 'nodejs',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Auth.
  const expected = process.env.PULL_API_KEY;
  if (!expected) {
    return res.status(500).json({ error: 'PULL_API_KEY not configured' });
  }
  const provided = req.headers['x-pull-api-key'];
  if (provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Default `since` to today (UTC).
  const since = String(req.query.since || new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return res.status(400).json({ error: 'since must be YYYY-MM-DD' });
  }
  const prefix = `indeed/${since}/`;

  try {
    // List all blobs under the date prefix. `list` paginates if needed; the
    // SDK handles single-page responses cleanly for typical daily volume.
    let allBlobs = [];
    let cursor;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      allBlobs = allBlobs.concat(page.blobs || []);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    // Surface the bits the Mac puller actually needs.
    const applications = allBlobs.map((b) => ({
      pathname: b.pathname,           // e.g. indeed/2026-04-29/16af8944d47e/12345-abc.json
      url: b.url,                     // unguessable signed-style URL
      uploaded_at: b.uploadedAt,
      size: b.size,
    }));

    return res.status(200).json({
      since,
      total: applications.length,
      applications,
    });
  } catch (e) {
    console.error('applications list error:', e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
