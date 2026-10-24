# Private Gateway V2 (local rewrite)

**Status: experimental, not production-ready.** This repository is the newest local rewrite prepared for the user's Cloudflare deployment. It has not been deployed to any Cloudflare account. The code is a starting point for the user or another agent to review, test, and improve—not a promise of working VLESS egress.

The service is a personal, administrator-managed VLESS-over-WebSocket TCP relay. It sends client destination connections through a single globally selected SOCKS5 endpoint. Read this file before deploying; several important release gates remain open.

## At a glance

- **Runtime:** one Cloudflare Worker, D1 database, optional 15-minute Cron trigger. Wrangler also builds and uploads the pinned TLS helper and CA bundle.
- **Public host:** starts on the Worker `workers.dev` hostname. Do not attach `safe.adib.na.am` until local/edge tests pass and domain/account ownership is confirmed.
- **Admin UI:** `/`, `/admin`, or `/panel` on the Worker hostname.
- **Shared client path:** `/ws` initially; one global path for every user.
- **Users:** unique VLESS UUID per user; admin copies a single VLESS link. There is no subscription service or subscription endpoint.
- **Exit:** one global SOCKS5 selection, with failover for new connections to another verified candidate.
- **Accounting:** per-user upload plus download bytes combined; configurable validity in days and traffic limit in GB. Expiry/limit exhaustion disables the user; admin re-enable resets usage and starts a new period using the saved plan.
- **Transport support:** TCP only. DNS-over-TCP can pass through the SOCKS tunnel. UDP is **not** implemented.

## What is implemented

- D1 tables are initialized idempotently on first request.
- Admin password is a Worker secret (`ADMIN_PASSWORD`); there is no default password. Admin sessions are signed, HttpOnly, Secure, SameSite cookies. Login attempts are rate-limited in D1.
- Admin endpoints manage users, global path, candidate list, selected global exit, and five HTTPS egress-IP checks.
- VLESS handshake parsing supports IPv4, IPv6, and domain destination addresses. The destination hostname is sent in SOCKS5 CONNECT, so the Worker does not resolve the client's destination directly.
- The data plane opens TCP only to the selected SOCKS endpoint, then asks that endpoint to connect to the destination. On connect failure it tries the next verified candidate for a **new** connection. Existing TCP sessions cannot migrate to another proxy.
- The scanner downloads candidate lists through the active SOCKS endpoint, tests candidates through their own SOCKS tunnels, and marks one healthy only when at least three of five independent HTTPS IP services agree.
- Candidate inputs are restricted to public IPv4 SOCKS endpoints without credentials. The administrator must supply and test an initial endpoint before source-list discovery can work.
- `ENABLE_CRON` is `0` by default. Manual scans are available in the panel. Set it to `1` only after testing and review.

## Important limitations and unresolved risks

1. **No real VLESS end-to-end test has passed.** There has been no live client → Worker → SOCKS → destination round trip. No clean initial SOCKS endpoint is configured in this repository.
2. **TLS-over-SOCKS depends on `workers-tls`.** It is pinned to source commit `48d5488cd362d362b92b1d90622e9e3ea1c4e7ac`; its maintainers say the project has not been independently audited. Review the code, transitive dependencies, licenses, WASM artifact, and failure behavior before trusting its health results or using it in production.
3. **Trust roots need maintenance.** `src/roots.pem` is a Mozilla-derived CA bundle downloaded from curl on 2026-10-24. `src/ROOTS_NOTICE.md` records its source. Update it only from a reviewed source; never retrieve trust roots dynamically at runtime.
4. **D1 quota accounting is not load-tested.** The code updates the database for each WebSocket message/chunk. Concurrent connections, large frames, cap boundaries, expiry races, and D1 write limits still need tests.
5. **Cron is configured but disabled by default.** A schedule is registered; the handler returns without scanning unless `ENABLE_CRON=1`.
6. **No subscription or UDP/DNS-over-UDP support.** Do not advertise those capabilities.
7. **Existing user state is not imported.** The two earlier V2 UUIDs were preserved in an ignored local migration file, not in this repository archive. Their old usage, duration, and expiry were not verified. Reconcile the old state before importing or cutting over. Do not place real UUIDs in a public GitHub repo; treat them as credentials.
8. **Cloudflare deployment approval is not encoded in the code.** The owner reported receiving support approval for the new account. Confirm that approval and the allowed deployment route directly with Cloudflare; a successful Nova install does not by itself validate this separate codebase.

## Prerequisites

- Node.js **22 or newer** (Wrangler 4.152.0).
- npm and Git.
- A Cloudflare account whose owner has confirmed that this workload and deployment path are permitted.
- A D1 database created in that account.
- A clean public IPv4 SOCKS5 endpoint, supplied by the administrator after deployment.
- A unique admin password of at least 14 characters, set only as a Worker secret.

## Local checks

From the repository root:

```sh
npm ci
npm run check
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

The tests cover protocol-header parsing, SOCKS address encoding, path/plan validation, UUID formatting, and link construction. A local `workerd` run additionally exercised login, create/list user, disable, re-enable/reset, and global path updates against local D1. **Neither test path verifies live VLESS traffic, remote D1 provisioning, TLS-over-SOCKS, or Cloudflare edge behavior.**

For local admin testing, create a `.dev.vars` file containing a throwaway `ADMIN_PASSWORD` (never a real production password), run `npm run dev`, and remove the file afterward. `.dev.vars` is ignored by Git.

## Cloudflare deployment (manual Wrangler route)

These are preparation instructions, not a claim that deployment has been tested. Do not put an account password or API token in this repository, a committed file, or an AI chat. Prefer `npx wrangler login` in the account owner's terminal. If using an API token locally, make it least-privilege and provide it through a local environment variable/secret manager, never commit or paste it.

1. **Create a private GitHub repository** and push this source. Before making it public, choose a license and confirm that any third-party dependency and CA-bundle notices are acceptable.
2. Install Node 22+, then run `npm ci` and `npm run check`.
3. Authenticate from the account owner's terminal using the Cloudflare-supported login flow. Confirm the account selected is the intended one.
4. Create the D1 database:
   ```sh
   npx wrangler d1 create private-gateway-v2
   ```
   Copy the returned `database_id` into `wrangler.jsonc` under the existing `d1_databases` binding, along with `database_name: "private-gateway-v2"`. Do not commit account credentials. The database ID is configuration, not a secret.
5. Review the Wrangler config, run the local dry-run, then deploy once to the temporary `workers.dev` hostname:
   ```sh
   npx wrangler deploy --dry-run --outdir .wrangler/dry-run
   npx wrangler deploy
   ```
6. Set the admin secret after the Worker exists:
   ```sh
   npx wrangler secret put ADMIN_PASSWORD
   ```
   Use a unique random password, not the Cloudflare login password. Confirm `/` loads and admin sign-in works.
7. In the panel, add a clean public IPv4 SOCKS5 endpoint. The add action performs five HTTPS IP checks through it; do not proceed unless at least three independent services agree. Never reuse an endpoint known to intercept TLS.
8. Verify the egress IP, manually scan candidates, select a healthy candidate, then test a VLESS client end-to-end (upload and download, HTTPS certificate validation, DNS via TCP, quota cap, expiry, disable/re-enable, failover). Record logs/version IDs and the candidate's observed exit IP.
9. Enable periodic scans only after manual tests pass. Set `ENABLE_CRON=1` in the Worker configuration and redeploy; confirm the scheduled handler executes as expected.
10. **Only after all gates pass**, attach the desired custom domain (for example `safe.adib.na.am`) using Cloudflare's supported Worker custom-domain flow. Confirm DNS/zone ownership and check for an existing Pages or Worker route conflict first. Do not attach a production domain to an unverified Worker.

If Cloudflare returns an abuse/block/restriction response at any step, stop. Do not create replacement projects/accounts to get around it; use Cloudflare's review/appeal process.

## Data model and user operations

The admin API is same-origin and protected by the signed session cookie. Main endpoints:

- `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `GET/POST /api/settings` (one shared path)
- `GET/POST /api/users`; `POST /api/users/:uuid/disable`; `POST /api/users/:uuid/enable`; `DELETE /api/users/:uuid`
- `GET /api/proxies`; `POST /api/proxies/add`; `POST /api/proxies/select`; `POST /api/proxies/scan`
- `GET /api/check-ip`

For migration, `POST /api/users` accepts an administrator-supplied UUID and plan. That preserves the identifier but starts a new period with zero usage; it does **not** restore old quota/expiry history. Import only after reconciling state. A template with dummy data is at `ops/known-users.example.json`.

## Repository contents

- `src/index.js` — Worker routes, admin API, D1 operations, scheduled handler.
- `src/transport.js` — VLESS-over-WebSocket parser/relay and SOCKS5 TCP handshake.
- `src/proxy-health.js` — SOCKS-routed TLS checks, IP consensus, list discovery, failover state.
- `src/core.js` — protocol parsing, validation, plan and link helpers.
- `src/schema.js` — D1 schema initialization.
- `src/ui.js` — inline admin UI.
- `src/roots.pem`, `src/ROOTS_NOTICE.md` — TLS trust bundle and provenance note.
- `test/core.test.js` — pure unit tests.
- `wrangler.jsonc`, `package.json`, `package-lock.json` — pinned build/runtime setup.
- `SECURITY_REVIEW.md`, `NEXT_STEPS.md` — release gates and current status.
- `ops/known-users.example.json` — dummy migration schema only; no live UUIDs.

## Security checklist

- [ ] Rotate any Cloudflare API tokens or passwords that were pasted into chat; never commit credentials.
- [ ] Keep real UUIDs, D1 exports, `.dev.vars`, and operational logs private.
- [ ] Review the TLS helper before using it to decide an exit is safe.
- [ ] Confirm the selected SOCKS endpoint has no TLS interception and stable egress.
- [ ] Verify no client destination traffic is sent through a direct `fetch()` fallback.
- [ ] Confirm the account owner has permission for the intended workload and the deployment is within Cloudflare's terms.
- [ ] Do not perform cutover until egress, quota, expiry, failover, and all existing UUIDs are verified.
