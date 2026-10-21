# Architecture and storage

## Runtime

The application is a Node.js HTTP server with a vanilla JavaScript dashboard and SQLite persistence. There is no frontend build step. Electron embeds the server in its main process and displays the dashboard in a sandboxed renderer with Node integration disabled. The browser-only server remains supported. Runtime libraries handle WebSockets and archive extraction. CLIProxyAPI and Antigravity CLI run as managed or externally installed subprocesses.

| Component                                   | Responsibility                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `server.js`                                 | Loopback listener, dashboard/API routes, body limits, concurrency and shutdown |
| `desktop/`                                  | App lifecycle, automatic unlock, renderer isolation and external-link policy   |
| `lib/tools.js`                              | Portable detection and pinned, checksum-verified bridge installation           |
| `lib/security.js`                           | Dashboard sessions, CSRF, Host/Origin checks, secure file helpers              |
| `lib/providers.js`                          | Institutional identity validation, provider discovery and quota parsing        |
| `lib/catalog.js`                            | Refresh state, namespaces, provenance, verification gate and quota checks      |
| `lib/bridge.js`                             | CLIProxyAPI configuration, staged OAuth, admitted credentials and lifecycle    |
| `lib/gemini-tool.js`, `lib/gemini-setup.js` | Verified CLI downloads, guided terminal sign-in, cancellation and cleanup      |
| `lib/gemini-cli.js`                         | CLI identity/project checks, isolated workspace, hooks and process control     |
| `lib/proxy.js`, `lib/gemini-proxy.js`       | Request translation, forwarding, SSE and usage recording                       |
| `lib/realtime.js`                           | Session discovery, WebSocket relay and speech synthesis                        |
| `lib/media.js`                              | Multipart parsing and bounded response reads                                   |
| `lib/store.js`                              | SQLite settings, hashed app keys, encrypted SoCLaaS key and usage ledger       |
| `public/`                                   | Sources, model catalog, usage views and playground                             |
| `scripts/`, `test/`                         | Local diagnostics and mocked regression checks                                 |

## Request lifecycle

An app request passes Host/Origin and Bearer-key checks, then resolves a discovered model and verified endpoint for the current account. Stale catalogs cannot route. ChatGPT requests check current reported Codex allowance. The connector sends the request, relays its result, and records status, latency and reported tokens. It does not save the prompt or response in the usage ledger.

Model types describe tasks. Supported transport routes are determined by the connector; advertised client routes are their intersection with successful checks. Discovery can retain an unknown model type without pretending to have an implementation for it.

## Authentication boundaries

- Dashboard tokens become eight-hour HttpOnly, SameSite=Strict cookies. Mutations also require session-specific CSRF.
- App keys are randomly generated and stored as SHA-256 digests. They grant inference, not management.
- ChatGPT OAuth runs in staging. Only verified institutional identities enter the bridge's active credential directory; rejected credentials are quarantined.
- Gemini setup installs only checksum-verified binaries and creates a private, safely quoted terminal launcher. The launcher clears inherited credentials and uses the isolated workspace. Setup requires dashboard authentication and CSRF; it cannot overlap full verification. Temporary sign-in diagnostics are bounded and removed when setup finishes. Cancelling stops gateway auto-connection but does not close the external terminal or revoke provider consent.
- Gemini login stays under CLI/OS-keyring management. Fresh diagnostics must match the pinned email/project before a prompt is sent. API-key/ADC overrides are rejected.
- The CLI receives an allowlisted environment and runs in a private generated workspace with slash expansion disabled, sandboxing and deny-all tool hooks. It never runs inside the student's application repository.

These protect a personal local deployment. They are not multi-user isolation, a provider entitlement system or an external security certification.

## State

Desktop uses its OS application-data directory; the source server uses `GATEWAY_DATA_DIR`, defaulting to `data/`. State includes the database, dashboard and bridge tokens, encryption key, bridge configuration, verified OAuth files, staging/quarantine directories, managed tools and CLI workspace. POSIX directories are owner-only and sensitive files use owner read/write modes. Windows protection also depends on the user profile's inherited ACLs.

The SoCLaaS key uses AES-256-GCM with a local encryption key. This protects a database-only disclosure, not access to the entire OS account. OAuth refresh credentials remain readable by their local bridge process. The CLI and provider may retain independent history. Legacy database migration code preserves earlier usage and labels estimated historical counts separately.

`output/` contains private local diagnostics and test fixtures. Neither directory belongs in Git. All public tests use temporary state with fake identities and services.

## Current limits

- Complete subscription integration has been exercised on macOS; provider/CLI changes may break internal response contracts.
- Gemini is text-only, serializes message history and serves one inference request at a time.
- No shared credit pool, per-app budget, automatic provider fallback or public hosting support.
- No age-based verification expiry; inspect check timestamps and re-run live tests when needed.
- Realtime key revocation affects new connections; existing sessions are bounded to 15 minutes.
- Gemini website image/music/video services have no connector here.
