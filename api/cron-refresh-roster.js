// Daily cron: aggregate LinkedIn (LinkupAPI) + Indeed (Blob) + manual records
// into a unified roster snapshot the dashboard reads from /api/candidates.
//
// This replaces the Mac-side `~/usa-hoist-hiring/run-hiring-pull.sh` flow
// for the metadata roster. Resume PDFs are NOT pulled here (Phase 2b lazy
// /api/cv); cv_path is left empty for cron-pulled records — the dashboard
// already handles that gracefully.
//
// Triggered by Vercel Cron (see vercel.json) at 14:55 UTC daily — that's
// 9:55 AM Central Daylight Time, matching the previous launchd timing.
//
// Manual invocation for testing:
//   curl -fsS https://usa-hoist-indeed-webhook.vercel.app/api/cron-refresh-roster \
//     -H "X-Hiring-Token: $HIRING_API_TOKEN"
//
// Required env vars:
//   USAHOIST_LINKUPAPI_KEY, USAHOIST_LINKUPAPI_ACCOUNT_ID
//   PULL_API_KEY (used to read /api/applications internally)
//   HIRING_API_TOKEN (manual invocation auth)
//   BLOB_READ_WRITE_TOKEN (auto, when Blob is attached)
//   CRON_SECRET (auto-injected by Vercel when a cron is configured)

import { list, put } from '@vercel/blob';

export const config = {
  runtime: 'nodejs',
  // Pulls are sequential per role for LinkupAPI; cap generously.
  maxDuration: 300,
};

// ---------------------------------------------------------------------------
// Configuration — keep in sync with `~/usa-hoist-hiring/config.json`.
// LinkedIn job IDs come from LinkupAPI's job_id field; Indeed job IDs are
// the legacy ID Indeed sends in the webhook payload.
// ---------------------------------------------------------------------------

const ROLES = {
  'ops-manager':    { label: 'Operations Manager', linkedin_job_id: '4405169091', indeed_job_id: '16af8944d47e' },
  'revit-engineer': { label: 'Revit Engineer',     linkedin_job_id: '4405148912', indeed_job_id: null },
  'ar-specialist':  { label: 'AR Specialist',      linkedin_job_id: null,         indeed_job_id: '32dcf86ada5a' },
};

const INDEED_LOOKBACK_DAYS = 30;
const LINKUPAPI_URL = 'https://api.linkupapi.com/v2/recruiter';
const LINKUPAPI_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function pick(obj, ...path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// LinkupAPI client
// ---------------------------------------------------------------------------

async function linkupPost(action, params) {
  const r = await fetch(LINKUPAPI_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.USAHOIST_LINKUPAPI_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      account_id: process.env.USAHOIST_LINKUPAPI_ACCOUNT_ID,
      action,
      params,
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`LinkupAPI ${action} HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`LinkupAPI ${action} non-JSON response: ${text.slice(0, 200)}`);
  }
}

async function linkupGetAllCandidates(jobId) {
  const all = [];
  let offset = 0;
  while (true) {
    const resp = await linkupPost('get_candidates', { job_id: jobId, count: LINKUPAPI_PAGE_SIZE, offset });
    const data = resp?.data || {};
    const candidates = data.candidates || [];
    all.push(...candidates);
    const pagination = data.pagination || {};
    if (!pagination.has_more) break;
    if (typeof pagination.next_offset !== 'number') break;
    offset = pagination.next_offset;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Indeed Blob reader — fetches raw payloads from indeed/{date}/.../*.json
// stored by /api/indeed-webhook over the last N days.
// ---------------------------------------------------------------------------

async function readIndeedBlobs(lookbackDays) {
  // List under the broad `indeed/` prefix and filter client-side by date.
  // Blob list paginates; iterate.
  const cutoff = new Date(Date.now() - lookbackDays * 86400000);
  const all = [];
  let cursor;
  do {
    const page = await list({ prefix: 'indeed/', cursor, limit: 1000 });
    for (const b of (page.blobs || [])) {
      // Pathname format: indeed/YYYY-MM-DD/<jobId>/<appId>-<rand>.json
      const m = /^indeed\/(\d{4}-\d{2}-\d{2})\//.exec(b.pathname);
      if (!m) continue;
      const date = new Date(m[1] + 'T00:00:00Z');
      if (date < cutoff) continue;
      all.push(b);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  // Fetch and parse each blob in parallel, but bounded.
  const payloads = [];
  const BATCH = 20;
  for (let i = 0; i < all.length; i += BATCH) {
    const slice = all.slice(i, i + BATCH);
    const results = await Promise.allSettled(slice.map(async (b) => {
      const r = await fetch(b.url);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${b.pathname}`);
      const json = await r.json();
      return { pathname: b.pathname, url: b.url, payload: json };
    }));
    for (const res of results) {
      if (res.status === 'fulfilled') payloads.push(res.value);
    }
  }
  return payloads;
}

// ---------------------------------------------------------------------------
// Manual records reader — pulls from `hiring/manual-records.json` Blob.
// ---------------------------------------------------------------------------

async function readManualRecords() {
  const page = await list({ prefix: 'hiring/manual-records', limit: 50 });
  const blobs = (page.blobs || []).sort((a, b) =>
    new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  );
  if (blobs.length === 0) return [];
  const r = await fetch(blobs[0].url);
  if (!r.ok) return [];
  const text = await r.text();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : (parsed.records || []);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Normalizers — produce the dashboard-shape record from each source.
// ---------------------------------------------------------------------------

function normalizeLinkedIn(c, roleSlug, roleLabel) {
  const aid = c.application_id;
  if (!aid) return null;
  const fullName = c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Unknown';
  return {
    id: `${roleSlug}:${aid}`,
    role: roleLabel,
    role_slug: roleSlug,
    source: 'LinkedIn',
    grade: 'Q',
    full_name: fullName,
    location: c.location || '',
    headline: c.headline || '',
    application_date: (c.application_date || '').split(' ')[0],
    cv_path: '',         // Phase 2b: lazy-loaded via /api/cv
    experiences: c.experiences || [],
    education: c.education || [],
    contact_email: '',   // get_cv only, fetched lazily
    contact_phone: '',
    why: '',
    profile_url: c.profile_url || '',
  };
}

function normalizeIndeed(payload, roleSlug, roleLabel, blobPathname) {
  const aid = pick(payload, 'applicationId') || pick(payload, 'application', 'id') || pick(payload, 'applicant', 'id') || pick(payload, 'id');
  if (!aid) return null;
  const first = pick(payload, 'applicant', 'firstName') || pick(payload, 'applicant', 'name', 'first') || '';
  const last  = pick(payload, 'applicant', 'lastName')  || pick(payload, 'applicant', 'name', 'last')  || '';
  const fullName = pick(payload, 'applicant', 'fullName') || pick(payload, 'applicant', 'name', 'full') || `${first} ${last}`.trim() || 'Unknown';
  const headline = pick(payload, 'applicant', 'headline') || pick(payload, 'job', 'title') || '';
  let location = pick(payload, 'applicant', 'location') || pick(payload, 'applicant', 'personalDetails', 'location') || '';
  if (location && typeof location === 'object') {
    location = [location.city, location.state, location.country].filter(Boolean).join(', ');
  }
  const positions = pick(payload, 'applicant', 'resume', 'indeedResumeJson', 'positions')
                 || pick(payload, 'applicant', 'resume', 'positions')
                 || pick(payload, 'applicant', 'positions') || [];
  const experiences = positions.map((p) => ({
    title: p.title || p.jobTitle || '',
    company: p.company || p.companyName || '',
    company_url: p.companyUrl || '',
    date_range: p.dateRange || `${p.startDate || ''} - ${p.endDate || 'Present'}`.trim(),
    description: p.description || p.responsibilities || '',
  }));
  const educations = pick(payload, 'applicant', 'resume', 'indeedResumeJson', 'educations')
                  || pick(payload, 'applicant', 'resume', 'educations')
                  || pick(payload, 'applicant', 'educations') || [];
  const education = educations.map((e) => ({
    school: e.school || e.institution || '',
    school_url: e.schoolUrl || '',
    degree: e.degree || '',
    field: e.field || e.fieldOfStudy || '',
    years: e.years || `${e.startDate || ''} - ${e.endDate || ''}`.trim(' -'),
  }));
  return {
    id: `${roleSlug}:${aid}`,
    role: roleLabel,
    role_slug: roleSlug,
    source: 'Indeed',
    grade: 'Q',
    full_name: fullName,
    location: typeof location === 'string' ? location : '',
    headline,
    application_date: (pick(payload, 'appliedAt') || pick(payload, 'application', 'appliedAt') || '').split(' ')[0],
    cv_path: '',         // Phase 2b: lazy-loaded via /api/cv from the blob payload's base64
    experiences,
    education,
    contact_email: pick(payload, 'applicant', 'email') || pick(payload, 'applicant', 'personalDetails', 'email') || '',
    contact_phone: pick(payload, 'applicant', 'phone') || pick(payload, 'applicant', 'personalDetails', 'phone') || '',
    why: '',
    indeed_blob_pathname: blobPathname,
  };
}

// ---------------------------------------------------------------------------
// Manual record merge — apply field overrides from manual records by id.
// Standalone manual records (no matching auto-pulled record) are added as-is.
// Mirrors merge_manual() in the Mac regenerator.
// ---------------------------------------------------------------------------

function mergeManual(records, manual) {
  const byId = new Map(records.filter((r) => r.id).map((r) => [r.id, r]));
  for (const m of manual) {
    const mid = m.id;
    if (!mid) continue;
    if (byId.has(mid)) {
      const existing = byId.get(mid);
      for (const [k, v] of Object.entries(m)) {
        if (k === 'id' || v == null) continue;
        existing[k] = v;
      }
    } else {
      byId.set(mid, {
        id: mid,
        role: m.role || 'Operations Manager',
        role_slug: m.role_slug || '',
        source: m.source || 'Manual',
        grade: m.grade || 'Q',
        full_name: m.full_name || 'Unknown',
        location: m.location || '',
        headline: m.headline || '',
        application_date: m.application_date || '',
        cv_path: m.cv_path || '',
        experiences: m.experiences || [],
        education: m.education || [],
        contact_email: m.contact_email || '',
        contact_phone: m.contact_phone || '',
        why: m.why || '',
      });
    }
  }
  const gradeRank = { A: 0, B: 1, C: 2, RB: 3, R: 4, Q: 5 };
  return Array.from(byId.values()).sort((a, b) => {
    const ga = gradeRank[a.grade] ?? 9;
    const gb = gradeRank[b.grade] ?? 9;
    if (ga !== gb) return ga - gb;
    return (a.full_name || '').toLowerCase().localeCompare((b.full_name || '').toLowerCase());
  });
}

// ---------------------------------------------------------------------------
// Auth — Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` automatically.
// Manual invocation falls back to X-Hiring-Token.
// ---------------------------------------------------------------------------

function authorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;
  const hiring = process.env.HIRING_API_TOKEN;
  if (hiring && req.headers['x-hiring-token'] === hiring) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const t0 = Date.now();
  const stats = {
    linkedin: { roles: {}, total: 0, errors: [] },
    indeed:   { blobs: 0, parsed: 0, errors: [] },
    manual:   { count: 0 },
  };

  // 1. LinkedIn — sequential per role; LinkupAPI is slow and we don't want to
  // double our rate-limit footprint by parallelizing.
  const liRecords = [];
  for (const [slug, role] of Object.entries(ROLES)) {
    if (!role.linkedin_job_id) continue;
    try {
      const candidates = await linkupGetAllCandidates(role.linkedin_job_id);
      stats.linkedin.roles[slug] = candidates.length;
      stats.linkedin.total += candidates.length;
      for (const c of candidates) {
        const rec = normalizeLinkedIn(c, slug, role.label);
        if (rec) liRecords.push(rec);
      }
    } catch (e) {
      stats.linkedin.errors.push({ role: slug, error: e?.message || String(e) });
    }
  }

  // 2. Indeed (Blob) and 3. Manual — fetch in parallel; both are cheap I/O.
  let indeedBlobs = [];
  let manual = [];
  try {
    [indeedBlobs, manual] = await Promise.all([
      readIndeedBlobs(INDEED_LOOKBACK_DAYS),
      readManualRecords(),
    ]);
  } catch (e) {
    return res.status(500).json({ error: `aggregation step failed: ${e?.message || e}`, stats });
  }

  stats.indeed.blobs = indeedBlobs.length;
  stats.manual.count = manual.length;

  const indRecords = [];
  for (const { payload, pathname } of indeedBlobs) {
    // Map Indeed job ID → role slug via ROLES.
    const indeedJobId = String(pick(payload, 'job', 'id') || pick(payload, 'jobId') || '');
    let roleSlug = null, roleLabel = null;
    for (const [slug, role] of Object.entries(ROLES)) {
      if (role.indeed_job_id && role.indeed_job_id === indeedJobId) {
        roleSlug = slug; roleLabel = role.label; break;
      }
    }
    if (!roleSlug) continue; // unsorted — skip, like the Mac regenerator does
    const rec = normalizeIndeed(payload, roleSlug, roleLabel, pathname);
    if (rec) {
      indRecords.push(rec);
      stats.indeed.parsed += 1;
    }
  }

  // 4. Merge manual overrides + add standalone manual entries.
  const merged = mergeManual([...liRecords, ...indRecords], manual);

  // 5. Write the unified roster snapshot to Blob — same path /api/candidates reads.
  const today = isoDate(new Date());
  const payload = {
    candidates: merged,
    api_base_url: '',
    generated_at: new Date().toISOString(),
    data_window: today,
  };
  const json = JSON.stringify(payload);
  let snapshotResult;
  try {
    snapshotResult = await put('hiring/roster.json', json, {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: true,
      allowOverwrite: true,
    });
  } catch (e) {
    return res.status(500).json({ error: `snapshot put failed: ${e?.message || e}`, stats });
  }

  return res.status(200).json({
    ok: true,
    elapsed_ms: Date.now() - t0,
    counts: {
      linkedin: stats.linkedin.total,
      indeed_parsed: stats.indeed.parsed,
      indeed_blobs_scanned: stats.indeed.blobs,
      manual: stats.manual.count,
      merged: merged.length,
    },
    stats,
    snapshot: {
      pathname: snapshotResult.pathname,
      url: snapshotResult.url,
      size: json.length,
    },
  });
}
