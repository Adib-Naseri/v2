# Security / release gate

Status: **BLOCKED — local rewrite only; do not deploy or cut over**

## Release blockers

- The Cloudflare Pages project from the previous attempt remains blocked with error 8000119. No further Pages deploy/domain changes are authorized until Cloudflare's review is complete.
- Public inspection confirms Nova is reachable at `https://l73.ir/install`; `https://l73.ir/install/status` reports KV and D1 connected, D1 primary, admin configured, and Cron disabled. `https://l73.ir/` serves Cloudflare Speed Test, `/admin` serves nginx, `/panel` is a 404, and `https://ws.l73.ir/panel` is the earlier V1 panel. This is a public-page check only, not access to the Cloudflare account or the Telegram bot's private deployment record.
- `workers-tls` is pinned to commit `48d5488cd362d362b92b1d90622e9e3ea1c4e7ac`; its README states it has not been independently audited. No live TLS-over-SOCKS test has been run.
- No configured clean SOCKS endpoint exists in the rewrite. The previously supplied endpoint that intercepted TLS must not be reused.
- Wrangler local `deploy --dry-run` bundles successfully under Node 22; the Worker also runs locally against D1 and passes basic admin/user lifecycle requests. This does not call Cloudflare, provision remote D1, or prove VLESS transport/quota correctness. The available system Node 20 is too old for the installed Wrangler 4.152; use Node 22+ for later CLI work.
- A second Cloudflare token was pasted into chat after the prior warning. A single read-only `/user/tokens/verify` call returned HTTP 401; no account operations were performed. Treat the token as exposed and revoke it before any future deployment.
- The old seeded UUIDs are noted privately but not imported, because their usage/expiry state has not been verified.
- No admin password, Cloudflare token, or account password is stored in this tree.

## Account safety gate

Do not create additional test projects, deploy diagnostic Workers, repeatedly redeploy after an abuse/block error, attach `safe.adib.na.am`, or use another account to bypass a Cloudflare restriction. If using a supported deployment flow, keep the service description accurate and use one controlled deployment after the account owner confirms the platform's approval and has a rollback plan.
