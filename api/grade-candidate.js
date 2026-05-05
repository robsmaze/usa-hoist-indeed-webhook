// On-demand AI grading via Claude.
//
// Per-candidate "Regrade" button calls this endpoint. Reads the candidate's
// full record from /api/candidates, looks up the job's rubric from KV, and
// asks Claude to produce {grade, why} per the rubric. Stores the result on
// the manual record so it persists.
//
// Why prompt caching matters here: dozens of candidates get graded against
// the same job rubric, so the rubric block (1500-3000 tokens of must-haves,
// hard cuts, examples) is identical across many calls. Cached prefix means
// the second-and-later grade calls for the same job pay ~10% of input cost
// for that block. The candidate JSON goes after the last breakpoint so it
// doesn't invalidate the cache.
//
// POST /api/grade-candidate
//   body: { candidate_id }
//   200 → { ok, candidate_id, grade, why, cache_stats }
//   400 → invalid body
//   401 → bad X-Hiring-Token
//   404 → candidate or job not found
//   412 → job has no rubric (set one via Manage Jobs first)
//   502 → Claude API error
//
// Auth: X-Hiring-Token (same as the rest of the dashboard).
//
// Required env vars:
//   HIRING_API_TOKEN, ANTHROPIC_API_KEY, BLOB_READ_WRITE_TOKEN, KV_*

import Anthropic from '@anthropic-ai/sdk';
import { kv } from '@vercel/kv';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

const JOBS_PREFIX = 'hiring:job:';

// Grade scale — A/B/C grade-of-the-candidate, RB/R reject variants, Q unknown.
// Schema is structured-output-enforced server-side so Claude can only return
// these six values; saves us from defensive runtime checks.
const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    grade: {
      type: 'string',
      enum: ['A', 'B', 'C', 'RB', 'R', 'Q'],
      description:
        'A=top phone-screen immediately; B=solid phone-screen; C=hold (consider if A/B fall through); ' +
        'RB=reject borderline (rubric auto-disqualifier but worth a 15-min screen if circumstances unclear); ' +
        'R=clear reject (hard-cut violation, wrong domain); Q=insufficient information to grade',
    },
    why: {
      type: 'string',
      description:
        'Short reasoning, max 600 chars. Cite specific rubric criteria met or violated. ' +
        'Reference specific candidate facts (work history, location, education). ' +
        'For RB or R, name the disqualifier explicitly. May contain inline <strong>tags</strong> for emphasis.',
    },
  },
  required: ['grade', 'why'],
  additionalProperties: false,
};

// Stable across all grade calls — first cache_control breakpoint anchors here.
// Long enough on its own to clear Sonnet 4.6's 1024-token min-cacheable-prefix.
const BASE_INSTRUCTIONS = `You are grading hiring candidates against a job-specific rubric for USA Hoist Company, a manufacturer of construction hoists in Crest Hill, IL.

Your output is structured JSON: { grade, why }.

GRADE SCALE:
- A: Top tier. Phone-screen immediately. Strong evidence on the must-haves.
- B: Solid. Phone-screen. Mostly meets the rubric, no glaring red flags.
- C: Hold. Has some relevant background but missing key criteria. Consider only if A/B candidates don't pan out.
- RB: Reject borderline. Hits a rubric auto-disqualifier (e.g., job-hopping pattern, wrong specialization), but circumstances might be ambiguous — recommend a 15-min screen ONLY if the disqualifier might be circumstantial.
- R: Clear reject. Hard-cut violation (wrong degree, wrong industry, no relevant experience). No screen.
- Q: Insufficient information. The candidate record is too sparse (e.g., no work history, just a name) to apply the rubric.

GUIDELINES FOR "why" FIELD:
- 1-3 sentences, max 600 chars.
- Lead with the grade letter and a 2-3 word headline (e.g., "<strong>A — top phone screen.</strong>").
- Cite SPECIFIC rubric criteria the candidate hit or missed. Don't say "matches well" — say which criterion.
- Reference SPECIFIC candidate facts: company names, years, education, location. The reviewer should know exactly why you graded this way.
- For RB or R, NAME the disqualifier explicitly ("HARD CUT FAIL: BFA in Animation, not engineering").
- For A or B, name the strongest signal ("EXPLICIT AIA Billing experience at Alliance Glazing 2018-2023").
- Be skeptical and precise. Don't pad qualifications. If the candidate is weak, grade harshly.
- HTML-style <strong> tags are allowed for emphasis (the dashboard renders them).

CALIBRATION EXAMPLES (real candidates from prior grading):

Example 1 — Grade A (AR Specialist role):
Candidate: Tania Hernandez. AR Specialist at MYR Group Inc. (large electrical/utility construction firm, 2.5 yr).
Resume EXPLICITLY says 'Prepare and issue monthly pay applications to customers' + 'subcontractor/vendor lien waivers' + 'calling general contractors for payment update'. Bilingual Spanish.
Reasoning: <strong>A — top phone screen today.</strong> Currently AR Specialist at MYR Group Inc. (large electrical/utility construction firm, 2.5 yr). Resume EXPLICITLY says 'Prepare and issue monthly pay applications to customers' + 'subcontractor/vendor lien waivers' + 'calling general contractors for payment update'. Bilingual Spanish.

Example 2 — Grade RB (Operations Manager role):
Candidate: 30+ yrs industrial mfg, MBA + BSEE, SAP, P&L, Lean/Six Sigma, Takeda 5-yr stretch.
But: OSI Group 5/2024-12/2024 (~7mo), Fair Oaks Foods 4/2022-2/2023 (~10mo), Ocado Group 10/2021-3/2022 (~5mo). Three roles under 18 months in last 5 years.
Reasoning: <strong>Reject (borderline) — recommend 15-min phone screen.</strong> 30+ yrs industrial mfg, MBA + BSEE, SAP, P&L, Lean/Six Sigma, Takeda 5-yr stretch. RUBRIC AUTO-DISQUALIFIER: three roles under 18 months in last 5 years (OSI Group ~7mo, Fair Oaks ~10mo, Ocado ~5mo). Phone screen specifically about those three transitions — if circumstantial, upgrade to B.

Example 3 — Grade R (Revit Engineer role, hard-cut FAIL):
Candidate: BFA Animation, RIT. 3D Modeler in gaming/animation.
Reasoning: BFA Animation, RIT. 3D Modeler in gaming/animation. No engineering degree → HARD CUT FAIL. Wrong domain entirely.

Now apply the rubric below to the candidate I provide in the next message.`;

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

function compactCandidateContext(c) {
  // Keep this lean — it's the per-call input that doesn't get cached.
  return JSON.stringify({
    full_name: c.full_name,
    role: c.role,
    source: c.source,
    location: c.location,
    headline: c.headline,
    application_date: c.application_date,
    experiences: c.experiences,
    education: c.education,
    contact_phone: c.contact_phone,
    indeed_sentiment: c.indeed_sentiment,
    current_grade: c.grade,
    current_why: c.why,
  }, null, 2);
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
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const body = await readBody(req);
  if (!body || typeof body.candidate_id !== 'string') {
    return res.status(400).json({ error: 'body.candidate_id (string) is required' });
  }
  const candidateId = body.candidate_id.trim();

  const baseUrl = `https://${req.headers.host || 'usa-hoist-indeed-webhook.vercel.app'}`;

  // 1. Fetch full candidate record from the live roster (which has merged data
  // from LinkedIn auto-pull + Indeed direct + manual records).
  let candidate;
  try {
    const r = await fetch(`${baseUrl}/api/candidates`, {
      headers: { 'x-hiring-token': hiringToken },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    candidate = (data.candidates || []).find((c) => c.id === candidateId);
  } catch (e) {
    return res.status(500).json({ error: `couldn't read candidates: ${e?.message || e}` });
  }
  if (!candidate) return res.status(404).json({ error: `no candidate with id "${candidateId}"` });

  // 2. Look up job rubric.
  const job = await kv.get(JOBS_PREFIX + candidate.role_slug);
  if (!job) {
    return res.status(404).json({ error: `no job for role_slug "${candidate.role_slug}"; create one via Manage Jobs first` });
  }
  if (!job.rubric || job.rubric.trim().length < 50) {
    return res.status(412).json({
      error: `job "${candidate.role_slug}" has no rubric (or rubric < 50 chars); add one via the Manage Jobs UI before regrading`,
    });
  }

  // 3. Call Claude with adaptive thinking + structured output + prompt caching.
  // Cache breakpoints:
  //   #1 — base instructions (frozen across all grade calls forever)
  //   #2 — job rubric (frozen across all grade calls for THIS job)
  // Candidate data goes in the user message, after both breakpoints, so it
  // doesn't invalidate the cache.
  const client = new Anthropic();
  let response;
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: GRADE_SCHEMA },
      },
      system: [
        { type: 'text', text: BASE_INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `JOB: ${job.role_label}\n\nRUBRIC:\n${job.rubric}`, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: `Grade this candidate per the rubric above:\n\n${compactCandidateContext(candidate)}` },
      ],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Claude rate limit hit; try again in a moment' });
    }
    if (e instanceof Anthropic.APIError) {
      return res.status(502).json({ error: `Claude API error ${e.status}: ${e.message}` });
    }
    return res.status(500).json({ error: e?.message || String(e) });
  }

  // 4. Parse structured output. The schema enforcement happens server-side
  // so we expect a clean JSON string in the text block.
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    return res.status(500).json({ error: 'Claude returned no text block', stop_reason: response.stop_reason });
  }
  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    return res.status(500).json({
      error: 'Claude output was not valid JSON (despite output_config.format)',
      raw: textBlock.text.slice(0, 300),
    });
  }
  if (!parsed.grade || !parsed.why) {
    return res.status(500).json({ error: 'Claude output missing grade or why', parsed });
  }

  // 5. Update manual record with new grade + why. If no manual record exists
  // for this candidate yet (e.g. fresh LinkedIn pull), create one — the cron's
  // mergeManual will overlay these fields on the next refresh.
  const mrResp = await fetch(`${baseUrl}/api/manual-records`, {
    headers: { 'x-hiring-token': hiringToken },
  });
  if (!mrResp.ok) {
    return res.status(500).json({ error: `couldn't read manual-records: HTTP ${mrResp.status}` });
  }
  const records = (await mrResp.json()).records || [];

  let existing = records.find((r) => r.id === candidateId);
  if (!existing) {
    existing = {
      id: candidateId,
      role: candidate.role,
      role_slug: candidate.role_slug,
      source: candidate.source,
      full_name: candidate.full_name,
      location: candidate.location || '',
      headline: candidate.headline || '',
      application_date: candidate.application_date || '',
      cv_path: candidate.cv_path || '',
      experiences: candidate.experiences || [],
      education: candidate.education || [],
      contact_email: candidate.contact_email || '',
      contact_phone: candidate.contact_phone || '',
      indeed_application_url: candidate.indeed_application_url || '',
      indeed_legacy_id: candidate.indeed_legacy_id || '',
      indeed_sentiment: candidate.indeed_sentiment || '',
    };
    records.push(existing);
  }
  existing.grade = parsed.grade;
  existing.why = parsed.why;
  existing.graded_at = new Date().toISOString();
  existing.graded_by = 'claude-sonnet-4-6';

  const postResp = await fetch(`${baseUrl}/api/manual-records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hiring-token': hiringToken },
    body: JSON.stringify(records),
  });
  if (!postResp.ok) {
    const errBody = await postResp.text();
    return res.status(500).json({ error: `manual-records POST failed: HTTP ${postResp.status}: ${errBody.slice(0, 200)}` });
  }

  // 6. Trigger cron-refresh-roster fire-and-forget so the dashboard picks up
  // the new grade on its next 30s refresh. Don't await — already paid for the
  // grade call latency.
  fetch(`${baseUrl}/api/cron-refresh-roster`, {
    headers: { 'x-hiring-token': hiringToken },
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    candidate_id: candidateId,
    candidate_name: candidate.full_name,
    grade: parsed.grade,
    why: parsed.why,
    cache_stats: {
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens || 0,
      input_tokens: response.usage.input_tokens || 0,
      output_tokens: response.usage.output_tokens || 0,
    },
  });
}
