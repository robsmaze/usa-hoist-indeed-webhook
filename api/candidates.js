// Live candidate roster.
//
// Returns the most recent unified roster snapshot the dashboard renders.
// The snapshot is written by `POST /api/snapshot`, today by the Mac-side
// regenerator and (Phase 2) by a Vercel cron that aggregates Indeed Blob +
// LinkedIn directly.
//
// Shape mirrors `window.__HIRING_DATA__` from the prior static-bake era:
//   {
//     candidates: [ { id, role, role_slug, source, grade, full_name, ... }, ... ],
//     generated_at: "<ISO timestamp>",
//     data_window: "YYYY-MM-DD"  // date the snapshot was computed for
//   }
//
// GET /api/candidates
//   200 → snapshot JSON
//   404 → no snapshot uploaded yet (front-end falls back to baked data)
//   401 → missing/wrong X-Hiring-Token
//
// Required env vars:
//   HIRING_API_TOKEN       — same shared secret the rest of the dashboard uses
//   BLOB_READ_WRITE_TOKEN  — auto-injected when Blob is attached to the project

import { list } from '@vercel/blob';

export const config = {
  runtime: 'nodejs',
};

const SNAPSHOT_PATH_PREFIX = 'hiring/roster';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Auth — same X-Hiring-Token shared by the dashboard.
  const expected = process.env.HIRING_API_TOKEN;
  if (!expected) {
    return res.status(500).json({ error: 'HIRING_API_TOKEN not configured' });
  }
  if (req.headers['x-hiring-token'] !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    // The snapshot writer uses `addRandomSuffix: true` (every Blob write does
    // when the SDK can't reuse a name). So we list under the prefix and pick
    // the most recently uploaded blob.
    const page = await list({ prefix: SNAPSHOT_PATH_PREFIX, limit: 100 });
    const blobs = (page.blobs || []).sort((a, b) =>
      new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    );
    if (blobs.length === 0) {
      return res.status(404).json({
        error: 'no roster snapshot has been uploaded yet',
        hint: 'POST a snapshot to /api/snapshot first',
      });
    }

    const latest = blobs[0];
    const r = await fetch(latest.url);
    if (!r.ok) {
      return res.status(502).json({ error: `blob fetch failed: HTTP ${r.status}` });
    }
    const body = await r.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Snapshot-Uploaded-At', latest.uploadedAt);
    res.setHeader('X-Snapshot-Pathname', latest.pathname);
    return res.status(200).send(body);
  } catch (e) {
    console.error('candidates list error:', e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
