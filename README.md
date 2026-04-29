# USA Hoist — Indeed Webhook + Shared Hiring Tracker (Vercel)

Two things in one Vercel project:

1. **Indeed Application Data webhook receiver** — Indeed POSTs applications here, we park them in Vercel Blob, and the Mac-side puller fetches them daily.
2. **Shared candidate review tool** — `candidates.html` is a small web app served from `public/` that lets you and your two co-hiring-managers see the same candidates, mark statuses, and leave notes. State is stored in Vercel KV via `/api/candidate-state`.

## What's inside

- `api/indeed-webhook.js` — `POST /api/indeed-webhook`. Receives Indeed application data (validated against `INDEED_WEBHOOK_SECRET`), writes raw JSON to Vercel Blob at `indeed/{YYYY-MM-DD}/{jobId}/{applicationId}.json`.
- `api/applications.js` — `GET /api/applications?since=YYYY-MM-DD`. Authed by `PULL_API_KEY` header. Lists every blob received that day for the Mac puller.
- `api/candidate-state.js` — `GET` and `PUT /api/candidate-state`. Authed by `HIRING_API_TOKEN` header. KV-backed shared status + notes for each candidate, stamped with editor + timestamp.
- `public/candidates.html` — the shared review tool (regenerated daily by the Mac script `regenerate_candidates_html.py`).
- `public/resumes/` — resume PDFs (also regenerated daily).
- `package.json`, `vercel.json`, `.env.example`, `.gitignore`.

## One-time deploy

1. **Install Vercel CLI** if you don't have it:
   ```bash
   npm i -g vercel
   ```
2. **From this directory:**
   ```bash
   vercel login           # if not logged in
   vercel link            # create a new project (accept defaults)
   vercel env add INDEED_WEBHOOK_SECRET production    # paste a 32-byte random hex
   vercel env add PULL_API_KEY production             # paste a different 32-byte random hex
   vercel deploy --prod
   ```
   Generate good secrets with: `openssl rand -hex 32`

3. **Add Vercel Blob** to the project (one-time):
   - Go to Vercel dashboard → your project → **Storage** → **Create Database** → **Blob**.
   - Vercel will inject `BLOB_READ_WRITE_TOKEN` into the project automatically.
   - Hit **Redeploy** so the function picks up the new env var.

4. **Save the deployed URL** — Vercel prints something like `https://usa-hoist-indeed-webhook.vercel.app`. The webhook endpoint is `<that URL>/api/indeed-webhook`.

5. **Smoke-test the webhook** with curl:
   ```bash
   curl -X POST https://YOUR-URL.vercel.app/api/indeed-webhook \
     -H "Content-Type: application/json" \
     -H "X-Indeed-Webhook-Secret: <YOUR_INDEED_WEBHOOK_SECRET>" \
     -d '{"applicationId":"smoke-test-001","job":{"id":"test-job","title":"Smoke Test"},"applicant":{"firstName":"Smoke","lastName":"Test","email":"smoke@test.com"}}'
   ```
   Expect: `{"ok":true,"applicationId":"smoke-test-001",...}`

6. **Smoke-test the pull endpoint:**
   ```bash
   curl https://YOUR-URL.vercel.app/api/applications \
     -H "X-Pull-Api-Key: <YOUR_PULL_API_KEY>"
   ```
   Expect: a JSON envelope with the smoke-test application listed.

## Tier 2 setup (after the basic webhook is live)

Adds the shared candidate-tracker UI on top of the webhook receiver.

### 1. Add Vercel KV

In the Vercel dashboard for this project:
- **Storage** → **Create Database** → **KV**
- Name it `hiring-state` and connect to this project
- Vercel auto-injects `KV_REST_API_URL` + `KV_REST_API_TOKEN` env vars

### 2. Set the hiring-API token

```bash
# from your terminal in the repo
openssl rand -hex 32   # generate a third secret
```

In the Vercel dashboard → Project Settings → Environment Variables:
- Add `HIRING_API_TOKEN` = the value above (Production environment)

### 3. Enable Deployment Protection

Project Settings → **Deployment Protection** → **Standard Protection** (or **Password Protection**). Pick a password you'll share with the two other hiring managers. Without this, anyone with the URL could browse resumes — don't skip it.

### 4. Redeploy

Project → Deployments → top deployment → `…` → **Redeploy** so KV bindings + the new env var are picked up.

### 5. First daily refresh

On your Mac, run the regenerator (which lives in the local helper bundle):

```bash
~/usa-hoist-hiring/regenerate_candidates_html.py
```

It reads today's pulled data + your manual records, writes `public/candidates.html` and copies PDFs into `public/resumes/`, commits, and pushes. Vercel auto-deploys.

### 6. Share with the other hiring managers

Send each of them:
- The URL: `https://usa-hoist-indeed-webhook-n1ak.vercel.app/candidates.html`
- The Vercel deployment-protection password (so they can get past the auth wall)
- The `HIRING_API_TOKEN` value (they paste it once on first load — stored in their browser only)

On first visit they'll see a setup modal asking for their name and the API token. After that, the app loads and every status/notes change syncs through the API to KV. Each edit shows "Last edited by X at HH:MM" so you all see who screened whom.

## Indeed-side configuration

This is the part that requires Indeed account work. Two paths depending on what your account has access to:

### Path A — Indeed Apply (simplest, available to most employers)

If your jobs use **Indeed Apply** (the "Apply on Indeed" button), Indeed can be configured to POST application data to a third-party URL on submission. Needs Indeed support to flip on:

- Email Indeed support (or your account rep) and request **Indeed Apply Application Data delivery to a custom URL**.
- Provide:
  - **Endpoint URL:** `https://YOUR-URL.vercel.app/api/indeed-webhook`
  - **Authentication header:** `X-Indeed-Webhook-Secret: <YOUR_INDEED_WEBHOOK_SECRET>`
  - The Indeed job IDs you want to enable (Operations Manager, Revit Engineer, AR Specialist)
- Indeed sends a test application; verify it lands in Blob via the pull endpoint smoke test above.

### Path B — Job Sync API (requires partner status)

If you've integrated with the **Job Sync API** (typically through an ATS or as an Indeed integration partner), the application URL is configured per-job in the XML feed:

```xml
<job>
  <referenceNumber>YOUR-JOB-ID</referenceNumber>
  <indeed-apply-data>
    <indeed-apply-postUrl>https://YOUR-URL.vercel.app/api/indeed-webhook</indeed-apply-postUrl>
    <indeed-apply-postSecret>YOUR_INDEED_WEBHOOK_SECRET</indeed-apply-postSecret>
  </indeed-apply-data>
  ...
</job>
```

See: https://docs.indeed.com/indeed-apply/application-data and https://docs.indeed.com/job-sync-api/job-sync-api-guide

## Mac-side setup

After the webhook is live, update `~/.usa-hoist-hiring/config.json` (see `usa-hoist-hiring-local/config.json.example`) with the `indeed` block:

```json
{
  "indeed": {
    "vercel_url": "https://YOUR-URL.vercel.app",
    "pull_api_key": "<YOUR_PULL_API_KEY>",
    "job_map": {
      "<indeed-job-id-for-ops-mgr>":   "ops-manager",
      "<indeed-job-id-for-revit>":     "revit-engineer",
      "<indeed-job-id-for-ar>":        "ar-specialist"
    }
  }
}
```

You'll get the Indeed job IDs once Indeed configures the webhook for each job — or look them up in the URL of each posting on the Indeed Employer dashboard.

Then daily:
```bash
~/usa-hoist-hiring/run-hiring-pull.sh   # pulls LinkedIn + Indeed in one shot
```

## Cost

Both Vercel Hobby and Vercel Pro have generous limits. For 50–200 applications/day:

- Function invocations: well under any free tier.
- Vercel Blob storage: typical resume PDF is 100KB–2MB. 100 applications/day × 1MB × 30 days ≈ 3GB/month. Pro includes 1GB, additional GB-months are pennies.
- Bandwidth: minimal (only the Mac pulls, once a day).

## Security notes

- `INDEED_WEBHOOK_SECRET` and `PULL_API_KEY` should be 32-byte random hex (not anything memorable). Generate with `openssl rand -hex 32`.
- Vercel Blob URLs include a random suffix that makes them effectively unguessable, but they are technically public. Don't share them outside the digest workflow.
- The pull endpoint requires `X-Pull-Api-Key` so listing isn't trivial — but if the Mac script's config file leaks, the indexable list of today's blobs leaks too. Treat `~/.usa-hoist-hiring/config.json` as a credential file (`chmod 600`).
- All applicant data lives in your Vercel project. Rotate the Blob store and secrets when you no longer need historical data.

## Troubleshooting

- **Webhook returns 401** → `X-Indeed-Webhook-Secret` header missing or wrong. Check Vercel logs.
- **Webhook returns 500 with "BLOB_READ_WRITE_TOKEN not configured"** → Blob store not attached. Add it in Vercel → Storage and redeploy.
- **Pull returns empty** → No Indeed applications received yet today, or Indeed-side config not active. Smoke-test by POSTing a test application yourself (see above).
- **Vercel function times out (>60s)** → A very large resume came through. The 60s `maxDuration` should cover ~10MB resumes. If you see this, we'll add streaming.
