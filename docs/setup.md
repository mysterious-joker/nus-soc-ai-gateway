# Setup and troubleshooting

## Install the desktop app

Download from [GitHub Releases](https://github.com/mysterious-joker/nus-soc-ai-gateway/releases/latest). Each release includes SHA256SUMS.txt to check download integrity.

| Computer          | Download                                 | Install                                                                  |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| Apple Silicon Mac | mac-arm64.dmg                            | Drag the app to Applications and open it.                                |
| Intel Mac         | mac-x64.dmg                              | Drag the app to Applications and open it.                                |
| Windows x64       | win-x64.exe                              | Run the per-user installer; no administrator access required.            |
| Linux x64         | linux-x86_64.AppImage or linux-amd64.deb | Make the AppImage executable and open it, or install the Debian package. |

These first desktop builds are **unsigned and not notarized**. macOS and Windows may warn about an unidentified publisher. Use your operating system's supported per-app approval flow only if you trust this repository and release. Do not disable system-wide protection. Managed school devices may require administrator approval; running from source remains an alternative.

Desktop users do not need Node, npm, Git or Homebrew. Open the app to start the service and unlock the dashboard. Closing the window or choosing Quit stops its gateway and bridge. Reopen it to resume. The Gateway menu opens the dashboard, API reference and local data folder; Help links to updates and support. Updates are manual: download and install the new release. There is no background updater or telemetry.

The app tries port 4000 and chooses a free port if occupied. Copy the **API base URL** from Sources when configuring clients. The private bridge gets its own free port. Both listeners bind to 127.0.0.1.

## Platform coverage

| Capability                          | macOS                     | Linux                          | Windows                       |
| ----------------------------------- | ------------------------- | ------------------------------ | ----------------------------- |
| Desktop and local API               | Build and startup checks  | Build and startup checks       | Build and startup checks      |
| Managed ChatGPT tool                | Pinned download           | Pinned download                | Pinned download               |
| Complete live subscription workflow | Verified on Apple Silicon | Needs real-account validation  | Needs real-account validation |
| Gemini CLI connector                | Enabled                   | Enabled; needs live validation | Not enabled                   |

Windows Gemini integration is disabled because its execution hooks and process-group termination currently depend on POSIX behavior. ChatGPT and SoCLaaS can be configured independently. Account access still depends on institutional permissions and network/VPN requirements.

## Connect sources

### ChatGPT Edu

Under **Connection tools**, choose **Prepare ChatGPT connection** if the tool is missing. The gateway downloads CLIProxyAPI **8.0.25** from its official GitHub release, verifies it against a SHA-256 digest embedded in the app, and extracts only the executable and license into its private data folder. A checksum failure installs nothing. No package manager or privileged installation is needed.

Choose browser or device login in Sources and complete sign-in with your exact `@u.nus.edu` account and institutional workspace. The gateway checks the identity token's signature, issuer, audience, expiry and verified-email claim before admitting credentials.

Tools are detected in this order: explicit CPA_BIN, managed download, PATH, common installation locations. An invalid explicit override does not silently select another executable. External installations should use the compatible v8 release. Homebrew is only one possible installation location.

### Gemini Enterprise

Install [Antigravity CLI using Google's guide](https://antigravity.google/docs/getting-started?tab=cli). Run `agy`, sign in with your `@comp.nus.edu.sg` account, and select the school subscription project made available to you. Confirm `agy models` works, return to the gateway, choose **Check again**, then **Connect CLI session**. A Gemini website login alone does not establish this CLI session.

The connector was checked with CLI 1.4.2 and depends on its structured output, identity diagnostics and execution hooks. It detects AGY_BIN, PATH and ~/.local/bin/agy. Provider updates can require adapter changes.

The gateway pins the reported email and project before sending prompts, rejects API-key/ADC overrides, uses an isolated workspace and requires deny-all tool execution hooks. It does not extract keyring credentials. Changing the CLI account/project requires reconnecting in Sources. Disconnecting the gateway leaves the independent CLI login intact.

### SoCLaaS

Enter your own key from the [SoCLaaS portal](https://soclaas-portal.comp.nus.edu.sg/). The gateway validates it against the fixed official model endpoint before replacing a working key. No additional software, OAuth client or email claim is required.

## Verify and connect an app

Choose **Test a model** in setup or **Test a discovered model** in Models. In the Playground, enable **Include discovered models and verify this endpoint**, select a model and send a small request. Speech recognition requires an audio file; image editing requires a reference image. Verification consumes provider allowance and enables only the endpoint that returned a valid response. Advanced endpoint/bulk checks are documented in [verification](verification.md).

Create one app key per application under **App API keys** in Sources. Choose an OpenAI-compatible provider in your client, paste the displayed API base URL and new key, and select an exact model ID from Models. The API reference is linked in the header and Gateway menu.

Keys are shown once, stored as hashes and revocable. App keys can use verified inference routes but cannot administer the gateway. Per-app budgets/model scopes are not implemented. Keep the gateway running while clients use it.

## Run from source

Install Node.js 22.13+ and npm; .nvmrc selects Node 24. Run `npm ci`, then `npm run desktop`. For a browser-only service, run `npm start` and `npm run open` in a second terminal.

The launcher passes the dashboard token in a URL fragment. The page removes it and exchanges it for an eight-hour HttpOnly session cookie. For manual unlock, use the local dashboard-token file. Never paste it into issues or screenshots. Desktop Gateway → Open dashboard unlocks the app again. Locking invalidates the current session; restarting invalidates all sessions. App keys are separate.

These environment settings apply to the browser-only server. Desktop owns its ports/data directory; executable overrides apply to desktop launches that inherit them. There is no automatic .env loader.

| Variable         | Default             | Purpose                             |
| ---------------- | ------------------- | ----------------------------------- |
| PORT             | 4000                | Dashboard and API port              |
| CPA_PORT         | 8317                | Private bridge port                 |
| CPA_BIN          | Automatic detection | Explicit CLIProxyAPI executable     |
| AGY_BIN          | Automatic detection | Explicit Antigravity executable     |
| GATEWAY_DATA_DIR | Project's data/     | Private state; use an absolute path |

On Linux, `npm run open` needs xdg-open and a graphical browser session. You can also open the local URL manually. Never expose either service through a public tunnel or port forwarding.

## Data, migration and backups

Desktop stores data in its operating-system application-data directory, under NUS SoC AI Gateway/gateway. Use **Gateway → Show local data folder** for the exact location. The browser-only server uses the project's data/ unless configured otherwise. Installing desktop does not move, delete or silently import an existing source profile.

To migrate: quit both gateways, back up both folders privately, then copy the **entire contents** of source data/ into the desktop gateway/ folder. Preserve the database, encryption key and tokens together. Restart and check Sources. Gemini still uses the independent OS-keyring login. Keep the backup until all connections work. Never merge live folders or individual databases.

Stop the gateway before backups. Losing the encryption key prevents recovery of the SoCLaaS key. To reset, quit and move the data folder to a private backup; next start creates fresh state. This does not revoke provider sessions; use provider/CLI controls for that.

## Troubleshooting

| Symptom                    | Recovery                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| ChatGPT tool missing       | Use Prepare ChatGPT connection; check internet access and executable overrides.                  |
| Checksum/download failed   | Retry on a trusted network; report app version and OS if it persists. Never bypass verification. |
| Empty model list           | Connect a source, then explicitly test a discovered model. Refresh only discovers metadata.      |
| HTTP 401                   | Use a current gateway app key; reconnect expired provider credentials.                           |
| HTTP 403 for a model       | Check this endpoint passed verification for the current account.                                 |
| HTTP 429                   | Check quota/reset time. Gemini permits one active inference request.                             |
| Stale catalog or HTTP 503  | Refresh Sources and check connection-tool status.                                                |
| CLI identity/hook failure  | Check account/project and CLI compatibility; do not disable checks.                              |
| OAuth callback port busy   | Close competing sign-in attempts and retry.                                                      |
| An app cannot connect      | Keep the gateway open and copy its current URL from Sources.                                     |
| Gemini balance unavailable | Check /usage in the CLI. The connector does not expose that balance.                             |
| Desktop will not start     | Check OS installation approval, competing instances and data-folder write access.                |
