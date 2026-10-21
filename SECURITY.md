# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/mysterious-joker/nus-soc-ai-gateway/security/advisories/new). Do not open a public issue containing credentials, personal account details, provider responses or an exploit involving a live institutional account.

Include the affected commit, Node/CLI versions, impact and a minimal reproduction using synthetic data. This is a community project without a guaranteed response SLA. Security fixes target the current `main` branch.

## Deployment boundary

Run one gateway per student on a trusted local computer. Both services bind to loopback. Do not share app keys, forward ports, expose public tunnels, or use it as a multi-user service. A compromised OS account can read local credentials; file permissions and database encryption do not protect against that threat.

The application separates dashboard and app credentials, checks Host/Origin, uses CSRF for dashboard mutations, and serves a restrictive Content Security Policy. Provider-controlled labels use DOM text APIs. Uploads and upstream results have size/time limits. Authentication checks have mocked regression coverage; this is not an independent security audit.

## Sensitive files

Desktop uses a sandboxed, context-isolated renderer with Node integration disabled. External navigation is restricted to approved authentication, setup and project links. Managed bridge downloads must match pinned SHA-256 digests before extraction. Desktop releases are currently unsigned and not notarized; download only from this repository's releases and follow the installation notes. Data in the OS application-data directory is just as sensitive as source-mode `data/`.

Never commit or attach `data/`, `output/`, `.playwright-cli/`, `.env` files, OAuth JSON, databases, keyring exports, or dashboard URLs containing tokens. `.gitignore` covers default runtime paths; if you customize `GATEWAY_DATA_DIR`, keep it outside the repository. Reports can contain school project metadata even when they contain no secrets.

App keys are shown once and stored as hashes. Revoking a key blocks new requests, but does not cancel already-running requests or open realtime sessions. Stop the server to terminate active connections immediately. If provider credentials leak, revoke them at the provider as well as removing local state.

## Safe development

Use mocked services and synthetic identities for CI. Do not introduce user-controlled upstream hosts, log raw provider errors/credentials, weaken institutional checks, or remove CLI execution hooks to make a test pass. Live checks require explicit opt-in and consume allowance. Review dependency advisories with `npm audit`.
