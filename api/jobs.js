// Jobs CRUD — the dashboard's reusable job-postings registry.
//
// Replaces the old hardcoded ROLES const in cron-refresh-roster.js. Each open
// (or closed) job posting at USA Hoist becomes a record here. Adding a new
// hire is now: paste the role label + Indeed legacy ID + LinkedIn job ID
// through the dashboard's "Manage Jobs" modal — no code change.
//
// API:
//   GET    /api/jobs                  → { jobs: [...] }
//   POST   /api/jobs    body: <job>   → { ok, job }
//   PUT    /api/jobs    body: <job with role_slug> → { ok, job }
//   DELETE /api/jobs?role_slug=x      → { ok, archived: <role_slug> }
//
// Auth: shared X-Hiring-Token header (same secret the dashboard uses).
//
// Storage: Vercel KV. Key per job: hiring:job:<role_slug>. On the first GET
// against an empty KV, the endpoint seeds the three currently-active jobs
// (ops-manager, revit-engineer, ar-specialist) so existing setups upgrade
// transparently. After that, edits go through this endpoint only.

import { kv } from '@vercel/kv';

export const config = {
  runtime: 'nodejs',
};

const KEY_PREFIX = 'hiring:job:';
const VALID_STATUSES = new Set(['active', 'paused', 'closed']);
const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;

// Seed data — equivalent to the ROLES const previously in cron-refresh-roster.js,
// extended with the Revit Engineer Indeed legacy ID we discovered today via
// FindEmployerJobs. Used only on first read of an empty KV.
const SEED_JOBS = [
  { role_slug: 'ops-manager',    role_label: 'Operations Manager', status: 'active',
    indeed_legacy_id: '16af8944d47e', linkedin_job_id: '4405169091', rubric: '' },
  { role_slug: 'revit-engineer', role_label: 'Revit Engineer',     status: 'active',
    indeed_legacy_id: '9979b554c476', linkedin_job_id: '4405148912', rubric: '' },
  { role_slug: 'ar-specialist',  role_label: 'AR Specialist',      status: 'active',
    indeed_legacy_id: '32dcf86ada5a', linkedin_job_id: null,        rubric: '' },
];

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

// Read every job out of KV. Returns array sorted: active first, then paused,
// then closed; within each group alphabetical by label.
async function listJobs() {
  let cursor = 0;
  const keys = [];
  do {
    const [next, batch] = await kv.scan(cursor, { match: KEY_PREFIX + '*', count: 200 });
    keys.push(...batch);
    cursor = Number(next) || 0;
  } while (cursor !== 0);
  if (keys.length === 0) return [];
  const values = await kv.mget(...keys);
  const jobs = values.filter(Boolean);
  const order = { active: 0, paused: 1, closed: 2 };
  return jobs.sort((a, b) => {
    const oa = order[a.status] ?? 9, ob = order[b.status] ?? 9;
    if (oa !== ob) return oa - ob;
    return (a.role_label || '').localeCompare(b.role_label || '');
  });
}

async function ensureSeeded() {
  const existing = await listJobs();
  if (existing.length > 0) return existing;
  const now = new Date().toISOString();
  for (const seed of SEED_JOBS) {
    await kv.set(KEY_PREFIX + seed.role_slug, {
      ...seed,
      created_at: now,
      closed_at: null,
    });
  }
  return await listJobs();
}

function validateJobInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object') return 'expected JSON body';
  if (!partial || body.role_slug !== undefined) {
    if (typeof body.role_slug !== 'string' || !SLUG_RE.test(body.role_slug)) {
      return 'role_slug must match /^[a-z][a-z0-9-]{1,40}$/';
    }
  }
  if (!partial || body.role_label !== undefined) {
    if (typeof body.role_label !== 'string' || body.role_label.length < 2 || body.role_label.length > 80) {
      return 'role_label must be 2-80 chars';
    }
  }
  if (body.status !== undefined && !VALID_STATUSES.has(body.status)) {
    return `status must be one of: ${[...VALID_STATUSES].join(', ')}`;
  }
  for (const k of ['indeed_legacy_id', 'linkedin_job_id']) {
    if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') {
      return `${k} must be a string or null`;
    }
  }
  if (body.rubric !== undefined && typeof body.rubric !== 'string') {
    return 'rubric must be a string';
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hiring-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!process.env.HIRING_API_TOKEN) {
    return res.status(500).json({ error: 'HIRING_API_TOKEN not configured' });
  }
  if (!authOk(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // GET — list, with auto-seed on empty.
  if (req.method === 'GET') {
    try {
      const jobs = await ensureSeeded();
      return res.status(200).json({ jobs });
    } catch (e) {
      console.error('jobs GET error:', e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  }

  // POST — create.
  if (req.method === 'POST') {
    const body = await readBody(req);
    const err = validateJobInput(body);
    if (err) return res.status(400).json({ error: err });
    try {
      const existing = await kv.get(KEY_PREFIX + body.role_slug);
      if (existing) return res.status(409).json({ error: `role_slug "${body.role_slug}" already exists; use PUT to update` });
      const now = new Date().toISOString();
      const job = {
        role_slug: body.role_slug,
        role_label: body.role_label,
        status: body.status || 'active',
        indeed_legacy_id: body.indeed_legacy_id || null,
        linkedin_job_id: body.linkedin_job_id || null,
        rubric: body.rubric || '',
        created_at: now,
        closed_at: null,
      };
      await kv.set(KEY_PREFIX + body.role_slug, job);
      return res.status(200).json({ ok: true, job });
    } catch (e) {
      console.error('jobs POST error:', e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  }

  // PUT — update an existing job. Identify by role_slug in body.
  if (req.method === 'PUT') {
    const body = await readBody(req);
    if (!body || !body.role_slug) return res.status(400).json({ error: 'role_slug is required' });
    const err = validateJobInput(body, { partial: true });
    if (err) return res.status(400).json({ error: err });
    try {
      const existing = await kv.get(KEY_PREFIX + body.role_slug);
      if (!existing) return res.status(404).json({ error: `no job with role_slug "${body.role_slug}"` });
      const next = { ...existing };
      for (const k of ['role_label', 'status', 'indeed_legacy_id', 'linkedin_job_id', 'rubric']) {
        if (body[k] !== undefined) next[k] = body[k];
      }
      // Stamp closed_at when transitioning to closed.
      if (existing.status !== 'closed' && next.status === 'closed') {
        next.closed_at = new Date().toISOString();
      }
      if (existing.status === 'closed' && next.status !== 'closed') {
        next.closed_at = null;
      }
      await kv.set(KEY_PREFIX + body.role_slug, next);
      return res.status(200).json({ ok: true, job: next });
    } catch (e) {
      console.error('jobs PUT error:', e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  }

  // DELETE — soft archive (status → closed). Hard delete would orphan
  // candidate records, so we never actually remove the KV row.
  if (req.method === 'DELETE') {
    const role_slug = String(req.query.role_slug || '').trim();
    if (!role_slug) return res.status(400).json({ error: 'role_slug query param is required' });
    try {
      const existing = await kv.get(KEY_PREFIX + role_slug);
      if (!existing) return res.status(404).json({ error: `no job with role_slug "${role_slug}"` });
      const next = { ...existing, status: 'closed', closed_at: new Date().toISOString() };
      await kv.set(KEY_PREFIX + role_slug, next);
      return res.status(200).json({ ok: true, archived: role_slug, job: next });
    } catch (e) {
      console.error('jobs DELETE error:', e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  }

  res.setHeader('Allow', 'GET, POST, PUT, DELETE, OPTIONS');
  return res.status(405).json({ error: 'method not allowed' });
}
