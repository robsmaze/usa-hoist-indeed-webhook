// Diagnostic probe: does Vercel's Node.js runtime reach LinkupAPI?
//
// LinkupAPI sits behind Cloudflare. The Mac-side puller explicitly uses
// `curl` via subprocess because Python urllib was blocked with HTTP 403 +
// Cloudflare error 1010. Vercel's Node fetch may or may not get blocked
// the same way — this probe exists so we can find out *before* building
// out a cron architecture that relies on it.
//
// GET /api/_diag/linkupapi-probe?job_id=<id>
//   Auth: X-Hiring-Token header (same as the rest of the dashboard).
//   Returns:
//     {
//       ok: boolean,
//       http_status: number,
//       cloudflare_ray: string | null,
//       server_header: string | null,
//       elapsed_ms: number,
//       sample: <first 500 chars of response body>,
//       parsed: { candidate_count, has_pagination } | null
//     }
//
// Required env vars:
//   HIRING_API_TOKEN, USAHOIST_LINKUPAPI_KEY, USAHOIST_LINKUPAPI_ACCOUNT_ID
//
// Once Phase 2 ships, this stays as a diagnostic — it's cheap, it's gated,
// and the next time something breaks the launchd-pulled-now-cron-pulled
// LinkedIn flow, this is the first thing to hit.

export const config = { runtime: 'nodejs' };

const LINKUPAPI_URL = 'https://api.linkupapi.com/v2/recruiter';

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

  const apiKey = process.env.USAHOIST_LINKUPAPI_KEY;
  const accountId = process.env.USAHOIST_LINKUPAPI_ACCOUNT_ID;
  if (!apiKey || !accountId) {
    return res.status(500).json({
      error: 'USAHOIST_LINKUPAPI_KEY and USAHOIST_LINKUPAPI_ACCOUNT_ID must be set',
      hint: 'vercel env add USAHOIST_LINKUPAPI_KEY production',
    });
  }

  const jobId = String(req.query.job_id || '4405169091'); // ops-manager default
  const t0 = Date.now();
  let httpStatus = 0;
  let cfRay = null;
  let serverHeader = null;
  let body = '';
  let parseError = null;
  let parsed = null;

  try {
    const r = await fetch(LINKUPAPI_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        account_id: accountId,
        action: 'get_candidates',
        params: { job_id: jobId, count: 1, offset: 0 },
      }),
    });
    httpStatus = r.status;
    cfRay = r.headers.get('cf-ray');
    serverHeader = r.headers.get('server');
    body = await r.text();
    if (r.ok) {
      try {
        const j = JSON.parse(body);
        const candidates = (j?.data?.candidates) || [];
        parsed = {
          candidate_count: candidates.length,
          has_pagination: Boolean(j?.data?.pagination),
          first_candidate_keys: candidates[0] ? Object.keys(candidates[0]).slice(0, 10) : [],
        };
      } catch (e) {
        parseError = e?.message || String(e);
      }
    }
  } catch (e) {
    return res.status(502).json({
      ok: false,
      stage: 'fetch',
      error: e?.message || String(e),
      elapsed_ms: Date.now() - t0,
    });
  }

  return res.status(200).json({
    ok: httpStatus === 200 && parsed !== null,
    http_status: httpStatus,
    cloudflare_ray: cfRay,
    server_header: serverHeader,
    elapsed_ms: Date.now() - t0,
    parse_error: parseError,
    sample: body.slice(0, 500),
    parsed,
  });
}
