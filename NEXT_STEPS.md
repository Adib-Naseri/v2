# Rewrite progress — 2026-10-24

## Done in this first pass

- Publicly inspected the user's Nova setup at `https://l73.ir/install` and its unauthenticated status endpoint. It reports `KV=true`, `D1=true`, D1 primary, admin configured, and Cron disabled.
- Re-read Nova's deployment guide and reconciled it with the live setup page. The repo guide describes Cloudflare-managed Worker deployment; the live install page describes a static UI/API split. Exact bot behavior for custom code still needs confirmation.
- Started a separate modular rewrite under `v2/rebuild/`; did not modify or deploy the blocked Pages project.
- Removed hard-coded SOCKS endpoints and any Cloudflare account credentials.
- Implemented a D1 data model, session-cookie admin APIs, shared path settings, per-user quotas, same-plan re-enable, user link generation, SOCKS5 TCP forwarding, candidate scanning, and five HTTPS egress checkers.
- Source-list fetches and egress checkers use the selected SOCKS tunnel; destination DNS names are sent through SOCKS. No user-data destination is fetched directly from the Worker.
- Added `ENABLE_CRON=0` by default and an optional scheduled scan, matching the live Nova install's Cron-off state.
- Added six unit tests. `npm run check` passes.
- Installed dependencies from the HTTPS-pinned lockfile, ran Wrangler 4.152.0 under a temporary Node 22 executable, and completed `deploy --dry-run`: bundle was 862.93 KiB (365.03 KiB gzip), D1 binding and `ENABLE_CRON=0` were recognized. This was a local dry-run only; no Cloudflare API was called.
- Ran the Worker in local `workerd` with local D1. This found and fixed a schema initialization error (multi-statement `exec`) and a custom-scheme URI construction error. Local API checks then passed for login, create/list user, disable, re-enable with usage reset, and shared-path updates. No VLESS WebSocket/SOCKS egress round-trip was tested.

## Still incomplete / must not deploy

- After the user reiterated deployment authorization, I made one read-only Cloudflare token verification request to `/user/tokens/verify`. The supplied token returned HTTP 401. No account inventory, resource creation, configuration change, or deployment request was made. The token may be invalid, expired, revoked, or not a Cloudflare API token; do not paste another token in chat.
- The code is a local first pass. No `workerd` runtime test, VLESS client round-trip, Cloudflare test deployment, D1 provisioning test, quota concurrency test, or live health scan has been run.
- TLS-over-SOCKS needs special care: native `socket.startTls()` in the prior code could not reliably set the destination SNI/identity. The new draft pins an unaudited TLS/WASM dependency as a candidate workaround; audit and edge test it before trusting health results.
- The live Nova page says Pages hosts the static UI and a Worker handles API, while the repo deployment guide says one Worker. Determine the actual bot deployment model before finalizing packaging.
- Existing UUIDs are listed privately under `ops/known-users.json`, but their old usage/expiry/limit state is not known. Do not import/cut over until reconciled.
- Do not try to use another account to bypass the Pages 8000119 block. The user intends to create a new account for a supported install; deployment must stop if Cloudflare places any restriction on that account.
