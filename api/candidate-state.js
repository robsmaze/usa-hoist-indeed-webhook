// Shared candidate-state endpoint.
//
// Stores per-candidate hiring decisions (status + notes) in Vercel KV so all
// hiring managers see the same state. Each write is stamped with the editor's
// name and a timestamp so we can show who phone-screened whom.
//
// API:
//   GET  /api/candidate-state
//        → returns { state: { "<application_id>": {status, notes, editor, updated_at}, ... } }
//
//   PUT  /api/candidate-state
//        body: { application_id, status?, notes?, editor }
//        → returns the updated record
//
// Auth: shared header X-Hiring-Token matched against HIRING_API_TOKEN env var.
//       This is the same secret all three hiring managers paste into the HTML
//       app on first load. Same trust level as the Vercel deployment-protection
//       password — three trusted people, password-shared.
//
// Required env vars:
//   HIRING_API_TOKEN     — shared secret all hiring managers use
//   KV_REST_API_URL      — auto-injected when Vercel KV is attached
//   KV_REST_API_TOKEN    — auto-injected when Vercel KV is attached

import { kv } from '@vercel/kv';

export const config = {
  runtime: 'nodejs',
};

const KEY_PREFIX = 'hiring:state:';
const VALID_STATUSES = new Set([
  'new', 'phone-screen', 'interview', 'offer', 'hired', 'pass', 'hold'
]);

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
  return null;
}

export default async function handler(req, res) {
  // Allow simple browser fetches. Same-origin in prod, but be permissive
  // in case someone opens the static HTML locally for testing.
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hiring-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!process.env.HIRING_API_TOKEN) {
    return res.status(500).json({ error: 'HIRING_API_TOKEN not configured on the server' });
  }
  if (!authOk(req)) {
    return res.status(401).json({ error: 'unauthorized — missing or wrong X-Hiring-Token' });
  }

  if (req.method === 'GET') {
    try {
      // Single-candidate fetch.
      const id = req.query.application_id;
      if (id) {
        const rec = (await kv.get(KEY_PREFIX + String(id))) || null;
        return res.status(200).json({ application_id: id, record: rec });
      }
      // All-candidates fetch — small dataset (<200 candidates), so a scan is fine.
      const out = {};
      let cursor = 0;
      do {
        const [nextCursor, keys] = await kv.scan(cursor, {
          match: KEY_PREFIX + '*',
          count: 200,
        });
        cursor = Number(nextCursor) || 0;
        if (keys.length > 0) {
          const values = await kv.mget(...keys);
          keys.forEach((k, i) => {
            const id = k.slice(KEY_PREFIX.length);
            if (values[i]) out[id] = values[i];
          });
        }
      } while (cursor !== 0);
      return res.status(200).json({ state: out });
    } catch (e) {
      console.error('GET candidate-state error:', e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  }

  if (req.method === 'PUT') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'expected JSON body' });
    }
    const id = String(body.application_id || '').trim();
    if (!id) return res.status(400).json({ error: 'application_id is required' });
    const editor = String(body.editor || '').trim() || 'unknown';

    if (body.status !== undefined && !VALID_STATUSES.has(body.status)) {
      return res.status(400).json({ error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` });
    }

    try {
      const key = KEY_PREFIX + id;
      const existing = (await kv.get(key)) || {};
      const next = {
        status: body.status !== undefined ? body.status : (existing.status || 'new'),
        notes:  body.notes  !== undefined ? body.notes  : (existing.notes  || ''),
        editor,
        updated_at: new Date().toISOString(),
      };
      await kv.set(key, next);
      return res.status(200).json({ application_id: id, record: next });
    } catch (e) {
      console.error('PUT candidate-state error:', e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  }

  res.setHeader('Allow', 'GET, PUT, OPTIONS');
  return res.status(405).json({ error: 'method not allowed' });
}
