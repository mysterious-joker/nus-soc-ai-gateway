# Setup and troubleshooting

## Requirements

- Node.js 22.13 or newer, including built-in SQLite, and npm. `.nvmrc` selects Node 24.
- macOS for the tested complete workflow, including the `open` launcher and CLI keyring session. Core tests run on Linux in CI; end-to-end Linux and Windows subscription support are not claimed.
- Your own enabled institutional access for each connected source. An email domain alone does not establish service entitlement.
- Network access to provider services. Follow institutional guidance for campus-network or VPN requirements.

Install CLIProxyAPI using its [upstream instructions](https://github.com/router-for-me/CLIProxyAPI). The gateway uses v8 configuration; live integration was checked with 8.0.25. It detects `/opt/homebrew/bin/cliproxyapi`, then falls back to `cliproxyapi` on PATH. Set `CPA_BIN` for another location. Let the gateway start its own bridge; another instance on port 8317 will conflict.

For Gemini, install and sign in to [Antigravity CLI](https://antigravity.google/docs/cli/) as instructed by Google and your institution. The connector was checked with CLI 1.4.2 and depends on its structured output, startup diagnostics and execution hooks. It expects `~/.local/bin/agy` unless `AGY_BIN` is set. Provider updates can require adapter changes.

## Start and unlock

```sh
npm ci
npm start
```

Run `npm run open` in a second terminal in this folder. The launcher passes the owner-only dashboard token in a URL fragment; the page removes it immediately and exchanges it for an eight-hour HttpOnly session cookie.

For manual unlock, visit `http://localhost:4000` and use the contents of `data/dashboard-token` locally. Do not paste the token into issues or screenshots. Locking the dashboard invalidates the current session. Restarting invalidates all dashboard sessions. App keys are separate.

## Connect sources

### ChatGPT Edu

Choose browser or device login in Sources and complete sign-in with your exact `@u.nus.edu` account and institutional workspace. The gateway checks the identity token's signature, issuer, audience, expiry and verified-email claim before admitting credentials to the bridge. A web login does not itself prove access to every model or feature.

### Gemini Enterprise

Run `agy`, sign in with your `@comp.nus.edu.sg` account, and select the school subscription project made available to you. Confirm `agy models` works, then choose **Connect CLI session** in Sources.

The gateway pins the reported email and project and checks them before sending prompts. It rejects API-key/ADC overrides, uses an isolated workspace and requires deny-all tool execution hooks. It does not extract credentials from the OS keyring. Signing into the Gemini website alone does not establish this CLI service session.

After changing the CLI account or project, reconnect it in Sources. Disconnecting the gateway leaves your independent CLI login intact.

### SoCLaaS

Enter your own key from the [SoCLaaS service](https://soclaas-api.comp.nus.edu.sg/). The gateway validates it against the fixed official model endpoint before replacing a working key. No OAuth client or email claim is required.

## Verify and use

New models need a successful request check before app keys can use them. Enable **Show excluded and untested entries** in Models to inspect IDs, then follow [verification](verification.md). Refreshing discovers metadata; it does not generate content or fabricate success.

Create one app key per local application. Keys are shown once, stored as hashes and revocable in Sources. All app keys can access verified inference routes; none can administer the gateway. Per-app budgets and model scopes are not implemented.

## Configuration

Export these process environment variables before both the server and related scripts. There is no automatic `.env` loader.

| Variable           | Default                        | Purpose                                        |
| ------------------ | ------------------------------ | ---------------------------------------------- |
| `PORT`             | `4000`                         | Dashboard and client API port                  |
| `CPA_PORT`         | `8317`                         | Private bridge port                            |
| `CPA_BIN`          | Homebrew path or `cliproxyapi` | Bridge executable                              |
| `AGY_BIN`          | `~/.local/bin/agy`             | Antigravity executable                         |
| `GATEWAY_DATA_DIR` | Project's `data/`              | Private persistent state; use an absolute path |

Both listeners bind to `127.0.0.1`. Do not expose them through a public tunnel or port forwarding.

## Troubleshooting

| Symptom                       | What to check                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| Empty `/v1/models`            | Inspect untested entries and run explicit verification.                                       |
| HTTP 401                      | Use a current gateway app key; reconnect a provider if its credentials expired.               |
| HTTP 403 for a model          | Inspect whether this endpoint has passed verification.                                        |
| HTTP 429                      | Check provider quota/reset time. Gemini also allows only one active inference request.        |
| Stale catalog or HTTP 503     | Refresh Sources successfully and check bridge/CLI installation.                               |
| CLI identity/hook check fails | Check the selected school account/project and CLI compatibility. Do not disable these checks. |
| OAuth callback port busy      | Close competing sign-in attempts and retry.                                                   |
| Gateway ports occupied        | Stop the previous instance or set unused `PORT` and `CPA_PORT` values.                        |
| Gemini balance unavailable    | Check `/usage` in the CLI. This balance is not exposed in the dashboard.                      |
| Folder moved while running    | Stop the server before moving it, then restart from the new location.                         |

## Backups and reset

Stop the gateway before backing up `data/`. Preserve the encryption key together with the database; losing it prevents recovery of the stored SoCLaaS key. Never upload backups.

To reset, stop the gateway and move `data/` to a private backup location. Starting again creates new local credentials and requires reconnecting. This does not revoke provider sessions or sign the independent CLI out; use provider/CLI account controls for that.
