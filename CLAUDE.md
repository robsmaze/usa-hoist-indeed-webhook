# usa-hoist-indeed-webhook — Vercel functions for the USA Hoist hiring pipeline

This repo deploys to https://usa-hoist-indeed-webhook.vercel.app and serves three concerns:

1. **`api/indeed-webhook.js`** — POST receiver Indeed calls when someone applies. Validates `INDEED_WEBHOOK_SECRET`, writes the raw payload to Vercel Blob at `indeed/{date}/{jobId}/{applicationId}.json`.
2. **`api/applications.js`** — GET endpoint the Mac-side puller calls daily. Validates `PULL_API_KEY`, lists today's blobs.
3. **`api/candidate-state.js`** — GET/PUT for the shared candidate-tracker UI (`public/candidates.html`). Validates `HIRING_API_TOKEN`, persists status/notes to Vercel KV.
4. **`api/health.js`** — GET, no auth. Pre-flight check used by the launchd puller wrapper (`run-hiring-pull.sh`). Confirms required env vars are present and Blob + KV are reachable. Returns 200 ok or 500 with named failing check.

The webhook + listing pair is one half of a daily hiring digest. The other half lives on Robby's Mac.

## Broader hiring system (so context isn't lost)

```
09:55 launchd  →  ~/usa-hoist-hiring/run-hiring-pull.sh
                    ├── pull_linkedin_applicants.py   (LinkupAPI)
                    └── pull_indeed_applicants.py     (this Vercel project)
                          writes ~/Documents/USA Hoist Hiring Data/{date}/

10:00 Cowork   →  hiring-daily-digest scheduled task
                    reads the data + jobs@usahoist.com mailbox
                    emails a graded digest to robby@usahoist.com
```

If you're picking this up, you'll want filesystem access to all of these:

- `~/usa-hoist-hiring/` — Mac puller scripts.
- `~/.usa-hoist-hiring/` — config (`config.json`, hidden dir, secrets — `chmod 600`).
- `~/Documents/USA Hoist Hiring Data/` — daily output, where launchd writes `launchd-stdout.log`.
- `~/Documents/usa-hoist-indeed-webhook/` — this repo.

## Repo layout

- `api/indeed-webhook.js` — `POST /api/indeed-webhook`, writes to Blob via `@vercel/blob.put()`.
- `api/applications.js` — `GET /api/applications?since=YYYY-MM-DD`, lists Blob via `@vercel/blob.list()`.
- `api/candidate-state.js` — `GET`/`PUT /api/candidate-state`, Vercel KV-backed.
- `public/candidates.html` — static review SPA, regenerated daily by `~/usa-hoist-hiring/regenerate_candidates_html.py`.
- `public/resumes/` — daily-regenerated copies of resume PDFs.
- `vercel.json`, `package.json` — minimal Vercel config.

## Vercel project state

- Project name: `usa-hoist-indeed-webhook` (matches GitHub `robsmaze/usa-hoist-indeed-webhook`).
- Production URL: https://usa-hoist-indeed-webhook.vercel.app
- This local clone is **not currently linked** to the Vercel project (no `.vercel/project.json`). Run `vercel link` before any `vercel env` / `vercel deploy` commands.

### Required env vars (set in Vercel project settings)

| Var | Used by | Source |
|---|---|---|
| `INDEED_WEBHOOK_SECRET` | indeed-webhook.js | manually set; matches the value Indeed sends in `X-Indeed-Webhook-Secret`. |
| `PULL_API_KEY` | applications.js | manually set; same value lives in `~/.usa-hoist-hiring/config.json` → `indeed.pull_api_key`. |
| `BLOB_READ_WRITE_TOKEN` | indeed-webhook.js, applications.js | **auto-set when Vercel Blob is attached** to the project. Requires redeploy. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | candidate-state.js | auto-set when Vercel KV is attached. |
| `HIRING_API_TOKEN` | candidate-state.js | manually set. |

**Never commit any of these.** The shared credential file is `~/.usa-hoist-hiring/config.json`. Don't paste it into chat or logs.

## Current state — handoff notes

The Cowork agent was running the daily hiring digest, found the Indeed half broken, and traced it to two layered config issues. Status as of handoff:

1. **DONE — `pull_api_key` placeholder.** `~/.usa-hoist-hiring/config.json` had the literal string `<your existing PULL_API_KEY>` for `indeed.pull_api_key`. Replaced with the real key Robby retrieved via Vercel; this value matches Vercel's `PULL_API_KEY` env var. Also populated `indeed.job_map` from the Cowork hiring-daily-digest SKILL.md:
   - `"16af8944d47e"` → `"ops-manager"`
   - `"32dcf86ada5a"` → `"ar-specialist"`
   - File permissions tightened to `0600`.

2. **OPEN — Blob token missing in production.** With auth fixed, the next pull surfaced this from Vercel:
   ```
   Vercel Blob: No token found. Either configure the BLOB_READ_WRITE_TOKEN
   environment variable, or pass a token option to your calls.
   ```
   Both `applications.js` (list) and `indeed-webhook.js` (put) use `@vercel/blob`, so if the token is missing, **the webhook itself has been failing on every Indeed POST since deploy** — meaning historical Indeed data may not be recoverable. Going forward will work once Blob is attached and a redeploy happens.

See `TASKS.md` for the open punch list.

## Common commands

After `vercel link`:

```bash
# What env vars are configured in production?
vercel env ls production

# Pull production env vars to a local file (delete after use)
vercel env pull .env.production.local --environment=production
# ... do something with it ...
rm .env.production.local

# Redeploy (required after attaching Blob/KV or changing env vars)
vercel deploy --prod

# Tail production logs while debugging
vercel logs --prod --since 5m
```

Quick smoke tests (no secret required):

```bash
# Health check — verifies all env vars are wired and Blob + KV are reachable
curl -fsS https://usa-hoist-indeed-webhook.vercel.app/api/health

# Listing endpoint — uses pull_api_key from ~/.usa-hoist-hiring/config.json
PULL_KEY="$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.usa-hoist-hiring/config.json')))['indeed']['pull_api_key'])")"
curl -fsS "https://usa-hoist-indeed-webhook.vercel.app/api/applications?since=$(date -u +%Y-%m-%d)" \
  -H "X-Pull-Api-Key: $PULL_KEY"
```

Full end-to-end (webhook ingestion path requires the secret):

```bash
# 1. The webhook secret is marked Sensitive in Vercel — `vercel env pull`
# returns it as an empty string. Read it from the dashboard:
#   Vercel → usa-hoist-indeed-webhook → Settings → Environment Variables
#   → INDEED_WEBHOOK_SECRET → Decrypt
INDEED_SECRET="<paste here>"
curl -X POST https://usa-hoist-indeed-webhook.vercel.app/api/indeed-webhook \
  -H "Content-Type: application/json" \
  -H "X-Indeed-Webhook-Secret: $INDEED_SECRET" \
  -d '{"applicationId":"smoke-001","job":{"id":"smoke-job"},"applicant":{"firstName":"Smoke","lastName":"Test"}}'
# Expect: {"ok":true,...}

# 2. Run the Mac puller (Indeed-only)
~/usa-hoist-hiring/run-hiring-pull.sh --skip-linkedin

# 3. Confirm output
ls   "$HOME/Documents/USA Hoist Hiring Data/$(date +%Y-%m-%d)/indeed/"
cat  "$HOME/Documents/USA Hoist Hiring Data/$(date +%Y-%m-%d)/indeed/run_summary.json"
```

A successful Indeed-only pull writes:

```
indeed/
  ops-manager/candidates.json + resumes/…      (job_id 16af8944d47e)
  ar-specialist/candidates.json + resumes/…    (job_id 32dcf86ada5a)
  unsorted/candidates.json                     (anything else, including the smoke-test)
  run_summary.json
```

The smoke-test record will land in `unsorted/` (its `job.id` is `smoke-job`, not in the map). That's expected and is itself a clean signal that the chain works.

## Pitfalls

- **`.vercel/` is gitignored** (see `.gitignore`) — every fresh checkout needs `vercel link` before CLI commands work.
- **Blob env var requires a redeploy.** Attaching Blob in the dashboard does *not* propagate `BLOB_READ_WRITE_TOKEN` to the running deployment until you redeploy. The CLI form `vercel blob create-store --yes -e production -e preview -e development` auto-injects the token AND prompts you to redeploy.
- **`INDEED_WEBHOOK_SECRET` and `PULL_API_KEY` are Sensitive in Vercel.** `vercel env pull` returns them as empty strings. To smoke-test the webhook ingestion path you must read them from the dashboard (Settings → Environment Variables → Decrypt). Listing path (`/api/applications`) and health (`/api/health`) don't have this issue — pull_api_key is mirrored in `~/.usa-hoist-hiring/config.json`, and health is unauthenticated.
- **`allowOverwrite: false`** on the webhook's `put()` call — if Indeed retries a duplicate, the handler treats the 409 as a no-op success. Don't flip this without thinking through replay semantics.
- **Secrets in `~/.usa-hoist-hiring/config.json`** — file is `chmod 600`. Don't commit it, don't paste it into chat.
- **Indeed "legacy" job IDs.** The Cowork SKILL.md lists them as URL slugs (`16af8944d47e`, `32dcf86ada5a`). The webhook stores blobs at `indeed/{date}/{jobId}/{applicationId}.json` using the payload's `job.id`. They *should* match — but if anything lands in `unsorted/` after the next pull, read the actual `job.id` from the blob and update `indeed.job_map` in `~/.usa-hoist-hiring/config.json`.
- **The Cowork hiring-daily-digest SKILL.md lives in Cowork's task config**, not in this repo. A mirror is at `~/Documents/USA Hoist Hiring Data/hiring-daily-digest-SKILL.md` — keep them in sync if either changes.
