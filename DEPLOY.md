# Deployment runbook — workers.dev only (first deploy)

**Scope agreed for this deploy:** new Cloudflare account with approval on file ·
one controlled deploy to `*.workers.dev` · `ENABLE_CRON=0` · **no custom domain yet** ·
no clean SOCKS5 endpoint yet (panel works, VLESS traffic will not until one is added).

> ⚠ **Stop rule:** if Cloudflare returns any abuse / block / restriction error
> (e.g. `8000119`) at any step, **stop**. Do not retry with new projects or
> accounts to get around it — use Cloudflare's review/appeal process.
> See `SECURITY_REVIEW.md`.
>
> 🔑 **Never** paste your Cloudflare password or a long-lived API token into
> chat, Git, or any committed file. Use `wrangler login` (browser OAuth) in
> your own terminal, or authorize the GitHub integration in the dashboard.
>
> 🔓 **This GitHub repo is currently PUBLIC.** Make it private before adding
> anything sensitive: `Settings → Danger Zone → Change visibility → Private`.
> Real user UUIDs are credentials — never commit them. (`ops/known-users.json`
> is now git-ignored; only the dummy `ops/known-users.example.json` is tracked.)

---

## Option A (recommended): deploy from your own PC with Wrangler

Prerequisites: Node.js **22+**, npm, Git. Check with `node --version`.

```sh
# 1. Get the code
git clone https://github.com/Adib-Naseri/v2.git
cd v2

# 2. Install + verify locally (6 unit tests, no Cloudflare calls)
npm ci
npm run check

# 3. Log in to the NEW approved account (opens your browser)
npx wrangler login
npx wrangler whoami          # ← confirm the email/account is the intended one

# 4. Dry-run bundle check (expect ~863 KiB / ~365 KiB gzip, env.DB + ENABLE_CRON)
npx wrangler deploy --dry-run --outdir .wrangler/dry-run

# 5. One controlled deploy. Wrangler 4.152 auto-provisions the D1 database
#    named `private-gateway-v2` from the ID-less binding in wrangler.jsonc,
#    then deploys the Worker to *.workers.dev.
npx wrangler deploy

# 6. Set the admin password as a Worker secret (14+ chars, unique random,
#    NOT your Cloudflare password). You will be prompted to type it.
npx wrangler secret put ADMIN_PASSWORD
```

Notes for step 5:

- If Wrangler asks to create the D1 database, confirm. It may write a
  `database_id` back into your local `wrangler.jsonc` — that ID is
  configuration (not a secret), but **don't commit it**; keeping the repo
  ID-less lets the same code deploy to another account later. Revert with
  `git checkout -- wrangler.jsonc` after deploying.
- Alternative (explicit D1): `npx wrangler d1 create private-gateway-v2`,
  paste the printed `database_id` into `wrangler.jsonc` locally, then deploy.
- No D1 migrations are needed — the Worker creates its tables idempotently
  on first request (`src/schema.js`).

### Verify after deploy

Wrangler prints your URL, e.g. `https://private-gateway-v2.<subdomain>.workers.dev`.

1. Open `/` → the login page should load.
2. Sign in with the `ADMIN_PASSWORD` you just set → the panel should open.
3. Confirm the shared path is `/ws` and Cron is **off** (`ENABLE_CRON=0`).
4. Do **not** attach `safe.adib.na.am` yet.

### After you have a clean SOCKS5 endpoint

In the panel → **Proxy candidates** → add `socks5://<public-ipv4>:<port>`.
It is only usable if **≥3 of 5** HTTPS IP checkers agree on the exit IP.
Never reuse an endpoint known to intercept TLS. Then test a real VLESS
client end-to-end (upload/download, cert validation, DNS-over-TCP, quota,
expiry, disable/re-enable, failover) **before** enabling Cron
(`ENABLE_CRON=1` + redeploy) or adding a custom domain.

### Rollback / teardown

- Remove the deployment: Cloudflare dashboard → Workers & Pages →
  `private-gateway-v2` → Settings → Delete (and delete the
  `private-gateway-v2` D1 database if you want a clean slate).
- Rotate `ADMIN_PASSWORD` any time with `npx wrangler secret put ADMIN_PASSWORD`.

---

## Option B: Cloudflare dashboard Git integration (Workers Builds)

1. Merge this branch's PR into `main` on GitHub (and make the repo private).
2. Cloudflare dashboard (new approved account) → **Workers & Pages →
   Create → Import a repository** → connect GitHub → select `Adib-Naseri/v2`.
3. Build settings: build command `npm ci`, deploy command `npm run deploy`
   (runs `wrangler deploy`). Root directory: `/`.
4. The ID-less D1 binding auto-provisions `private-gateway-v2` on first build.
5. After the first deploy succeeds, set the **secret** `ADMIN_PASSWORD`
   (14+ chars) in the Worker's Settings → Variables and Secrets, encrypted.
   `ENABLE_CRON` stays `0` from `wrangler.jsonc`.
6. Verify exactly as in Option A. Still **no custom domain** this round.

---

## Option C: GitHub Actions (manual, from this repo)

Workflow: `.github/workflows/deploy.yml` — **manual only** (`workflow_dispatch`,
never on push/PR), deploys only from `main`, and requires you to tick a
confirmation box on every run. GitHub-hosted runners *can* reach Cloudflare's
API, so no local Wrangler login is needed.

### One-time setup (you do this yourself — never share values in chat)

1. **Make the repo private** first (Settings → Danger Zone → Change
   visibility → Private). A pipeline that can deploy to your Cloudflare
   account does not belong in a public repo.
2. **Create a scoped API token** in the new approved Cloudflare account:
   My Profile → API Tokens → Create Token → start from the
   *"Edit Cloudflare Workers"* template, **add `D1: Edit`** (for first-run
   auto-provisioning), scope it to **only that one account** — e.g.
   `Workers Scripts: Edit`, `D1: Edit`. No Zone/DNS permissions are needed
   (workers.dev only). Never use the Global API Key or your account password;
   revoke/rotate the token if it is ever exposed.
3. **Add the credentials to GitHub**: repo → Settings → Secrets and variables
   → Actions.
   - **Secrets** tab (encrypted): `CLOUDFLARE_API_TOKEN` = the token above;
     `ADMIN_PASSWORD` = unique random 14+ character panel password
     *(optional — only needed if you tick the password step when running)*.
     Credentials go in **Secrets, never in Variables** (Variables are plain text).
   - **Variables** tab (plain-text configuration): `CLOUDFLARE_ACCOUNT_ID` =
     your Account ID (Cloudflare dashboard → Workers & Pages, right sidebar).
     The workflow also accepts it as a Secret of the same name as a fallback.
4. (Optional hardening) Settings → Environments → `production` → add yourself
   as *Required approver*. The workflow references this environment, so runs
   pause for your approval. Manual-only triggering is the baseline control.

### Run it

1. Merge the workflow PR into `main` first (the workflow refuses other branches).
2. GitHub → **Actions** → **Deploy to Cloudflare Workers** → **Run workflow**
   → branch `main` → tick **Deploy … to *.workers.dev?** → tick
   **Also set ADMIN_PASSWORD…** only the first time or when rotating it → Run.
3. The run does: `npm ci` → `npm run check` (fails = no deploy) → bundle
   `--dry-run` → `wrangler deploy` (creates D1 `private-gateway-v2` on first
   run, `ENABLE_CRON` stays `0`, no custom domain) → optional
   `wrangler secret put ADMIN_PASSWORD --name private-gateway-v2`
   (value passed via env + stdin, requires 14+ characters).
4. The run summary shows the `workers.dev` URL / Version ID. Verify exactly
   as in Option A. **If Cloudflare returns a block/restriction error, STOP** —
   do not re-run or rotate accounts; use review/appeal.

---

## Sandbox note (why this runbook exists)

The AI sandbox used to prepare this repo can only reach GitHub / npm / PyPI —
`api.cloudflare.com` and `dash.cloudflare.com` are unreachable from it
(`wrangler login --device` fails with `fetch failed`). So the deploy itself
must run from your terminal (Option A), Cloudflare's builders (Option B),
or GitHub-hosted runners (Option C).
Everything that can be verified offline was verified: `npm run check`
(6/6 tests) and `wrangler deploy --dry-run` (862.93 KiB / 365.03 KiB gzip).
