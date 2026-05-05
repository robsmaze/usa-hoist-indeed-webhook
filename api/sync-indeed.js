// Manual Indeed sync — pull every applicant for every active Indeed-linked job
// using the cookies the user pasted via /api/indeed-cookies.
//
// Why this exists: Indeed Employer's bearer JWT expires in ~1 hour, so a daily
// Vercel Cron can't reliably hold authenticated state. Instead the user
// triggers this endpoint manually from the dashboard whenever they want fresh
// data; cookies stay good as long as Robby pasted them recently.
//
// POST /api/sync-indeed → { ok, jobs_synced, candidates_imported,
//                           resumes_uploaded, resumes_failed, elapsed_ms,
//                           per_job: [...], errors }
// Auth: shared X-Hiring-Token header.
//
// Steps:
//   1. Read cookies from KV; refuse with 412 if absent or stale.
//   2. Read jobs from KV; pick those with status=active and indeed_legacy_id.
//   3. Call FindRCPMatches once (returns candidates across all jobs).
//   4. Filter to our active-Indeed jobs by job legacyId; normalize records.
//   5. For each candidate with a resume URL, hit /api/import-resume to fetch+stash the PDF.
//   6. Merge into existing manual_records (preserve existing grade + why).
//   7. POST merged manual records.
//   8. Trigger /api/cron-refresh-roster so the dashboard picks it up.

import { kv } from '@vercel/kv';

export const config = {
  runtime: 'nodejs',
  maxDuration: 300,
};

const COOKIES_KEY = 'hiring:indeed:cookies';
const JOBS_PREFIX = 'hiring:job:';
const INDEED_GRAPHQL = 'https://apis.indeed.com/graphql?co=US&locale=en-US';
const INDEED_API_KEY = '0f2b0de1b8ff96890172eeeba0816aaab662605e3efebbc0450745798c4b35ae'; // public client key from employers.indeed.com bundle
const SENTIMENT_TO_GRADE = { YES: 'B', MAYBE: 'C', NO: 'R', UNSET: 'Q' };
// Verbatim "active+paused, all dispositions, sort by date desc" payload that
// worked during this session's reverse-engineering. The proctorGroups string
// matters — orchestration-service rejects requests without it.
const FIND_RCP_MATCHES_BODY = JSON.stringify({
  operationName: 'FindRCPMatches',
  variables: {
    input: {
      clientSurfaceName: 'candidate-list-page',
      defaultStrategyId: 'U20GF',
      limit: 100,
      context: {
        surfaceContext: [
          { contextKey: 'HOSTED_JOB_POST_STATUS', contextPayload: 'ACTIVE' },
          { contextKey: 'HOSTED_JOB_POST_STATUS', contextPayload: 'PAUSED' },
          { contextKey: 'DISPOSITION', contextPayload: 'NEW' },
          { contextKey: 'DISPOSITION', contextPayload: 'PENDING' },
          { contextKey: 'DISPOSITION', contextPayload: 'PHONE_SCREENED' },
          { contextKey: 'DISPOSITION', contextPayload: 'INTERVIEWED' },
          { contextKey: 'DISPOSITION', contextPayload: 'OFFER_MADE' },
          { contextKey: 'DISPOSITION', contextPayload: 'REVIEWED' },
          { contextKey: 'CREATEDAFTER', contextPayload: '1714798800000' },
          { contextKey: 'SORT_BY', contextPayload: 'APPLY_DATE' },
          { contextKey: 'SORT_ORDER', contextPayload: 'DESCENDING' },
        ],
      },
      identifiers: { jobIdentifiers: {} },
      proctorGroups: '#F1:unified_pipeline_sourcing_and_candidates1,#A28:modxp_cerberus_hide_old_candidates_tst2',
      offset: 0,
    },
  },
  query: 'query FindRCPMatches($input: OrchestrationMatchesInput!) { findRCPMatches(input: $input) { rcpRequestId overallMatchCount matchConnection { pageInfo { hasNextPage } matches { candidateSubmission { id __typename data { __typename submissionUuid created profile { name { displayName } location { country location } contact { phoneNumber } } job { node { id jobData { title id ... on HostedJobPost { legacyId } } } } resume { __typename ... on CandidatePdfResume { id downloadUrl } ... on CandidateHtmlFile { id downloadUrl } ... on CandidateTxtFile { id downloadUrl } } sentiments: feedback(first: 1, input: {filter: {feedbackType: INTEREST_LEVEL}}) { feedback { __typename ... on EmployerCandidateSentiment { interestLevel } ... on EmployerCandidateFeedback { interestLevel } } } notes: feedback(input: {filter: {feedbackType: COMMENT}}) { feedback { __typename ... on EmployerCandidateComment { feedbackText created } ... on EmployerCandidateFeedback { feedbackText created } } } ... on LegacyCandidateSubmission { legacyID } ... on EmployerGeneratedCandidateSubmission { legacyID } ... on IndeedApplyCandidateSubmission { legacyID } ... on HiddenIndeedApplyCandidateSubmission { legacyID } ... on HiddenEmployerGeneratedCandidateSubmission { legacyID } } } } } } }',
});

function authOk(req) {
  const expected = process.env.HIRING_API_TOKEN;
  if (!expected) return false;
  return req.headers['x-hiring-token'] === expected;
}

function pick(obj, ...path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

async function listActiveIndeedJobs() {
  let cursor = 0;
  const keys = [];
  do {
    const [next, batch] = await kv.scan(cursor, { match: JOBS_PREFIX + '*', count: 200 });
    keys.push(...batch);
    cursor = Number(next) || 0;
  } while (cursor !== 0);
  if (keys.length === 0) return [];
  const values = await kv.mget(...keys);
  return values.filter((j) => j && j.status === 'active' && j.indeed_legacy_id);
}

async function callFindRCPMatches(cookies) {
  const r = await fetch(INDEED_GRAPHQL, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'content-type': 'application/json',
      'cookie': cookies,
      'indeed-api-key': INDEED_API_KEY,
      'indeed-client-sub-app': 'unified-pipeline-modules',
      'indeed-client-sub-app-component': './UnifiedPipelinePageLayout',
      'origin': 'https://employers.indeed.com',
      'referer': 'https://employers.indeed.com/',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
    body: FIND_RCP_MATCHES_BODY,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`FindRCPMatches HTTP ${r.status}: ${text.slice(0, 300)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`non-JSON response: ${text.slice(0, 300)}`); }
  if (json.errors) {
    const msgs = (json.errors || []).map((e) => e.message).join('; ');
    throw new Error(`Indeed GraphQL errors: ${msgs}`);
  }
  return json?.data?.findRCPMatches?.matchConnection?.matches || [];
}

function normalizeIndeedMatch(m, jobsByLegacyId) {
  const cs = m.candidateSubmission || {};
  const data = cs.data || {};
  const jobNode = (data.job || {}).node || {};
  const jd = jobNode.jobData || {};
  const legacyJob = jd.legacyId;
  const job = jobsByLegacyId[legacyJob];
  if (!job) return null; // skip candidates for jobs we don't track
  const profile = data.profile || {};
  const sentiments = ((data.sentiments || {}).feedback) || [];
  const interest = sentiments.find((f) => f.interestLevel)?.interestLevel || 'UNSET';
  const notesArr = ((data.notes || {}).feedback) || [];
  const employerNotes = notesArr.map((n) => n.feedbackText).filter(Boolean).join(' | ');
  const resume = data.resume || {};
  const legacyId = data.legacyID || '';
  const created = data.created;
  const applied = created ? new Date(created).toISOString().slice(0, 10) : '';
  return {
    id: `${job.role_slug}:${legacyId}`,
    role: job.role_label,
    role_slug: job.role_slug,
    source: 'Indeed',
    grade: SENTIMENT_TO_GRADE[interest] || 'Q',
    full_name: pick(profile, 'name', 'displayName') || 'Unknown',
    location: pick(profile, 'location', 'location') || '',
    application_date: applied,
    headline: '',
    why: employerNotes,
    cv_path: '',
    experiences: [],
    education: [],
    contact_email: '',
    contact_phone: pick(profile, 'contact', 'phoneNumber') || '',
    indeed_application_url: legacyId ? `https://employers.indeed.com/c/job-app/${legacyId}?from=candidate-list-page` : '',
    indeed_legacy_id: legacyId,
    indeed_sentiment: interest,
    _resume_download_url: resume.downloadUrl || '',
    _resume_typename: resume.__typename || '',
  };
}

async function importResume(baseUrl, hiringToken, cookies, candidate) {
  if (!candidate._resume_download_url || !candidate.indeed_legacy_id) return null;
  const r = await fetch(`${baseUrl}/api/import-resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hiring-token': hiringToken },
    body: JSON.stringify({
      source_url: candidate._resume_download_url,
      cookie: cookies,
      target_path: `resumes/indeed/${candidate.indeed_legacy_id}.pdf`,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const j = await r.json();
  return j.blob_url || null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hiring-Token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const hiringToken = process.env.HIRING_API_TOKEN;
  if (!hiringToken) return res.status(500).json({ error: 'HIRING_API_TOKEN not configured' });
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });

  const t0 = Date.now();
  const baseUrl = `https://${req.headers.host || 'usa-hoist-indeed-webhook.vercel.app'}`;
  const errors = [];

  // 1. Cookies
  const cookieRec = await kv.get(COOKIES_KEY);
  const now = Math.floor(Date.now() / 1000);
  if (!cookieRec || !cookieRec.cookies) {
    return res.status(412).json({ error: 'no Indeed cookies stored — paste them via /api/indeed-cookies first' });
  }
  if (!cookieRec.jwt_exp || cookieRec.jwt_exp <= now) {
    return res.status(412).json({ error: 'stored Indeed cookies have expired bearer — re-paste fresh cookies' });
  }

  // 2. Jobs
  const jobs = await listActiveIndeedJobs();
  if (jobs.length === 0) {
    return res.status(200).json({
      ok: true, jobs_synced: 0, candidates_imported: 0, resumes_uploaded: 0,
      resumes_failed: 0, per_job: [], elapsed_ms: Date.now() - t0,
      note: 'no active jobs with indeed_legacy_id — nothing to sync',
    });
  }
  const jobsByLegacyId = {};
  for (const j of jobs) jobsByLegacyId[j.indeed_legacy_id] = j;

  // 3. Pull all candidates from Indeed
  let matches;
  try {
    matches = await callFindRCPMatches(cookieRec.cookies);
  } catch (e) {
    return res.status(502).json({ error: `Indeed fetch failed: ${e.message}` });
  }

  // 4. Normalize, filtered to our jobs
  const newRecords = [];
  for (const m of matches) {
    const r = normalizeIndeedMatch(m, jobsByLegacyId);
    if (r) newRecords.push(r);
  }

  // 5. Upload resumes (parallel, bounded)
  let uploaded = 0, failed = 0;
  const concurrency = 5;
  const queue = [...newRecords];
  async function worker() {
    while (queue.length > 0) {
      const c = queue.shift();
      if (!c) return;
      try {
        const url = await importResume(baseUrl, hiringToken, cookieRec.cookies, c);
        if (url) { c.cv_path = url; uploaded++; }
      } catch (e) {
        failed++;
        errors.push({ candidate: c.full_name, error: e.message?.slice(0, 200) });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // 6. Read existing manual_records and merge.
  const existingResp = await fetch(`${baseUrl}/api/manual-records`, {
    headers: { 'x-hiring-token': hiringToken },
  });
  if (!existingResp.ok) {
    return res.status(500).json({ error: `couldn't read manual-records: HTTP ${existingResp.status}` });
  }
  const existing = (await existingResp.json()).records || [];

  // Build map by id for fast lookup. PRESERVE existing grade + why if already
  // set by Robby. Always overwrite phone/location/sentiment/cv_path/etc with
  // freshest data.
  const newById = new Map();
  for (const r of newRecords) {
    const stripped = {};
    for (const [k, v] of Object.entries(r)) if (!k.startsWith('_')) stripped[k] = v;
    newById.set(r.id, stripped);
  }
  const merged = [];
  const seenNew = new Set();
  for (const e of existing) {
    if (!e.id) { merged.push(e); continue; }
    const fresh = newById.get(e.id);
    if (!fresh) { merged.push(e); continue; }
    seenNew.add(e.id);
    // Preserve existing grade if user has set anything other than Q (untouched).
    const gradeFromUser = e.grade && e.grade !== 'Q';
    merged.push({
      ...fresh,
      grade: gradeFromUser ? e.grade : fresh.grade,
      why: e.why || fresh.why || '',  // keep manual rationale
    });
  }
  for (const r of newRecords) {
    if (!seenNew.has(r.id)) {
      const stripped = {};
      for (const [k, v] of Object.entries(r)) if (!k.startsWith('_')) stripped[k] = v;
      merged.push(stripped);
    }
  }

  // 7. POST merged
  const postResp = await fetch(`${baseUrl}/api/manual-records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hiring-token': hiringToken },
    body: JSON.stringify(merged),
  });
  if (!postResp.ok) {
    const body = await postResp.text();
    return res.status(500).json({ error: `manual-records POST failed: HTTP ${postResp.status}: ${body.slice(0, 200)}` });
  }

  // 8. Trigger cron-refresh-roster (fire-and-forget — but await briefly so
  // the response includes the refreshed counts).
  let cronCounts = null;
  try {
    const cronResp = await fetch(`${baseUrl}/api/cron-refresh-roster`, {
      headers: { 'x-hiring-token': hiringToken },
    });
    if (cronResp.ok) cronCounts = (await cronResp.json()).counts;
  } catch (e) {
    errors.push({ stage: 'cron-refresh-roster', error: e.message });
  }

  // Per-job summary
  const perJob = {};
  for (const j of jobs) perJob[j.role_slug] = { role_label: j.role_label, candidates: 0, with_pdf: 0 };
  for (const r of newRecords) {
    if (perJob[r.role_slug]) {
      perJob[r.role_slug].candidates += 1;
      if (r.cv_path) perJob[r.role_slug].with_pdf += 1;
    }
  }

  return res.status(200).json({
    ok: true,
    jobs_synced: jobs.length,
    candidates_imported: newRecords.length,
    resumes_uploaded: uploaded,
    resumes_failed: failed,
    per_job: Object.values(perJob).map((j) => ({ ...j })),
    cron_counts: cronCounts,
    errors: errors.slice(0, 10),
    elapsed_ms: Date.now() - t0,
  });
}
