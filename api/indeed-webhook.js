// Indeed Application Data webhook receiver.
//
// Indeed POSTs a JSON application payload here when someone applies to one of
// our jobs. We validate the shared secret, store the raw payload in Vercel
// Blob keyed by date + applicationId, and return 200.
//
// The Mac-side pull script (`pull_indeed_applicants.py`) lists today's blobs
// via `/api/applications` and downloads each one for the daily digest.
//
// Required env vars (set in Vercel project settings):
//   INDEED_WEBHOOK_SECRET    — shared secret. Indeed sends it in the
//                              X-Indeed-Webhook-Secret header (or change the
//                              header name below to whatever Indeed configures).
//   BLOB_READ_WRITE_TOKEN    — set automatically when you add a Blob store
//                              to the project. No manual config.

import { put } from '@vercel/blob';

export const config = {
  runtime: 'nodejs',
  // Allow up to 60s in case Indeed sends a large base64 resume and
  // we're decoding it. Default is 10s on Hobby, 60s on Pro.
  maxDuration: 60,
};

// Pull a stable applicationId out of whatever shape Indeed sends. The
// Application Data spec nests this under different keys depending on the
// integration version, so we're forgiving.
function pickApplicationId(body) {
  return (
    body?.applicationId ||
    body?.application?.id ||
    body?.applicant?.id ||
    body?.id ||
    `unknown-${Date.now()}`
  );
}

// Pull the job ID Indeed knows the posting by, so the local digest can
// route applications to the right role bucket.
function pickJobId(body) {
  return (
    body?.job?.id ||
    body?.jobId ||
    body?.job?.referenceNumber ||
    'unknown-job'
  );
}

// Sanitize a string into a filesystem-safe slug.
function slug(s) {
  return String(s).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80) || 'x';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Auth — fail closed if the secret env var isn't set so we don't
  // silently accept anything.
  const expected = process.env.INDEED_WEBHOOK_SECRET;
  if (!expected) {
    return res.status(500).json({ error: 'INDEED_WEBHOOK_SECRET not configured' });
  }
  const provided = req.headers['x-indeed-webhook-secret'];
  if (provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Read the body. Vercel parses JSON automatically when content-type is
  // application/json; if Indeed sends application/x-www-form-urlencoded or
  // similar we fall back to raw.
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      // leave as string
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'expected JSON body' });
  }

  const applicationId = String(pickApplicationId(body));
  const jobId = String(pickJobId(body));
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const pathname = `indeed/${today}/${slug(jobId)}/${slug(applicationId)}.json`;

  try {
    const blob = await put(pathname, JSON.stringify(body), {
      access: 'public', // unguessable random suffix on URL acts as gate
      contentType: 'application/json',
      addRandomSuffix: true,
      // Don't overwrite if the same applicationId comes in twice — Indeed
      // sometimes retries. Keep the first record.
      allowOverwrite: false,
    });

    return res.status(200).json({
      ok: true,
      applicationId,
      jobId,
      pathname,
      blob_url: blob.url,
      received_at: new Date().toISOString(),
    });
  } catch (e) {
    // If the file already exists (allowOverwrite: false + duplicate POST),
    // treat that as a no-op success so Indeed stops retrying.
    const msg = e && e.message ? e.message : String(e);
    if (/already exists/i.test(msg) || /409/.test(msg)) {
      return res.status(200).json({
        ok: true,
        deduplicated: true,
        applicationId,
        jobId,
        pathname,
      });
    }
    console.error('indeed-webhook error:', e);
    return res.status(500).json({ error: msg });
  }
}
