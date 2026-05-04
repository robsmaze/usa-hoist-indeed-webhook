# Open work — usa-hoist-indeed-webhook

Status: `[x]` done, `[ ]` open, `[~]` in progress, `[?]` follow-up.

## Done — 2026-05-04 unblock

- [x] Replace placeholder in `~/.usa-hoist-hiring/config.json` with real `PULL_API_KEY`.
- [x] Populate `indeed.job_map` with ops-manager (`16af8944d47e`) and ar-specialist (`32dcf86ada5a`).
- [x] `chmod 600 ~/.usa-hoist-hiring/config.json`.
- [x] `vercel link` — bound to `usa-hoist/usa-hoist-indeed-webhook`.
- [x] `vercel env ls production` — confirmed `BLOB_READ_WRITE_TOKEN` was missing.
- [x] **Created and connected new public Blob store** `usa-hoist-indeed-webhook-blob` (store_5aM05cCc1YV35OkG) via `vercel blob create-store --access public --yes -e production -e preview -e development`. Auto-injected `BLOB_READ_WRITE_TOKEN` into all environments.
- [x] **Added `/api/health` endpoint** (no auth) — verifies all required env vars are present and probes Blob + KV reachability. Returns 200 ok or 500 with named failing check.
- [x] **Wired pre-flight health check into `~/usa-hoist-hiring/run-hiring-pull.sh`** — Indeed pull aborts with exit 3 if health check fails. Skip with `--skip-health` if needed.
- [x] `vercel deploy --prod` — dpl_DaC5ZWymk5jYXDMRjQdje7brAVjC, READY.
- [x] Smoke-tested `/api/health` — `{"ok":true,"checks":{"env":{...all true},"blob":"ok","kv":"ok"}}`.
- [x] Smoke-tested `/api/applications?since=YYYY-MM-DD` with real `PULL_API_KEY` — returned `{"total":0,"applications":[]}`. Auth + Blob list + date filter all working.
- [x] Ran `~/usa-hoist-hiring/run-hiring-pull.sh --skip-linkedin` end-to-end. Pre-flight green, listing returned 0, `run_summary.json` written cleanly.

## Open — verify ingestion path

- [ ] **Webhook ingestion smoke test is blocked.** `INDEED_WEBHOOK_SECRET` is marked Sensitive in Vercel, so `vercel env pull` returns it as an empty string. The CLAUDE.md curl recipe relied on pulling the secret — it won't work. Two options to verify the `POST /api/indeed-webhook` → Blob `put()` path:
  1. **Recommended**: wait for Indeed's first real POST tomorrow. The build chain (same `BLOB_READ_WRITE_TOKEN`, same `@vercel/blob` SDK) is exercised by both `list()` and `put()`, so a green listing is strong indirect evidence the put will work.
  2. **Active test**: copy the secret from the Vercel dashboard (Settings → Environment Variables → INDEED_WEBHOOK_SECRET → Decrypt) into a shell var, then run the curl from CLAUDE.md.
- [ ] After tomorrow's 10AM digest run, confirm:
  - `total_applications` non-zero in `~/Documents/USA Hoist Hiring Data/{YYYY-MM-DD}/indeed/run_summary.json`.
  - Bucket partitioning correct — anything in `unsorted/` means a `job.id` not in the map; add it to `~/.usa-hoist-hiring/config.json` → `indeed.job_map` and re-pull.
  - AR Specialist applications are graded in the digest, not just counted.

## Follow-ups (post-MVP)

- [?] **Commit untracked production files.** `api/health.js`, `.gitignore`, `CLAUDE.md`, and `TASKS.md` are all untracked in the GitHub repo. The current production deployment was pushed via `vercel deploy --prod` and contains `health.js`, but if git auto-deploy is enabled and someone pushes `main`, the deployment will revert to a tree without `health.js` and the pre-flight check will start 404'ing.
- [?] **Historical Indeed data.** All Indeed POSTs from 2026-04-29 (deploy date) through 2026-05-04 (Blob attached) returned 500. Indeed retries a few times then drops. Those applications likely live only on the Indeed Employer dashboard now. Decide whether to scrape the dashboard for one-time backfill or move on.
- [?] **Outlook MCP not authenticated** in the Cowork environment, so the digest can't email itself — it currently saves to a file. Re-auth interactively from a regular Cowork chat (not a scheduled-task run).
- [?] **Privacy hardening of Blob storage.** The current store is public-access with `addRandomSuffix: true` (security-through-obscurity). For applicant PII (names, contact info, resume PDFs), private-with-signed-URLs would be stronger. Requires:
  - Switch to a private Blob store (`vercel blob create-store --access private`).
  - Update `api/applications.js` to return signed URLs (`@vercel/blob` `head()` + signed URL helper) instead of raw `b.url`.
  - Update `pull_indeed_applicants.py` to fetch via signed URLs.
- [?] **Review `allowOverwrite: false` semantics** — if Indeed retries with a *mutated* payload (rare, but possible if applicant edits their app), today we keep the first record. Verify that's still right; if not, key blobs by `applicationId + edit_version`.
- [?] **Drift check** — production `hiring-daily-digest-SKILL.md` lives in Cowork's task config; mirror at `~/Documents/USA Hoist Hiring Data/hiring-daily-digest-SKILL.md`. Add a sanity check.
- [?] **Zombie blob store.** `usa-hoist-indeed-webhook-n1-blob` (store_Yurak8asgho7nS4j) is unconnected to any project and has 2 mystery 244B test blobs from 2026-04-29 we couldn't list (no token in scope). Safe to delete via `vercel blob empty-store` (after re-linking) → `vercel blob delete-store store_Yurak8asgho7nS4j --yes`.
