This update fixes Mac installers that macOS reported as **damaged** because bundle signing was skipped. Version 2.2.1 applies a valid ad-hoc signature and verifies both signature integrity and dashboard startup from the actual DMG before publishing.

Quit older gateway instances, replace the app in Applications, then open it. Existing connections and usage are kept. The app is still not Developer ID signed or notarized; macOS may require its normal per-app approval for an unidentified developer.

The one-click feature remains in **Models → Verify all models**:

- Checks every supported model/endpoint with short prompts and bundled tiny audio/image inputs. No prompt or file upload is needed.
- Shows progress and individual results; supports cancellation and dashboard reloads. Unsupported or stale models are reported as skipped.
- Runs one request at a time without retries and pauses a source after authentication, quota or service-availability errors.
- Uses a 32-token SoCLaaS text output cap and the lowest advertised ChatGPT reasoning level. CLI services control their own output limits. Media checks also consume allowance.
- Successful endpoint checks become available to apps immediately. Failed minimal requests may reflect temporary errors or insufficient output budget; they do not establish subscription exclusion.

See [verification details](https://github.com/mysterious-joker/nus-soc-ai-gateway/blob/main/docs/verification.md#one-click-full-verification) for exact probe coverage and limits. Automated checks use synthetic providers and do not spend your allowance.

Install this update over your existing desktop app to retain its connections and usage history.

Desktop features:

- Native installers for Apple Silicon/Intel Macs, Windows x64 and Linux x64. Desktop users do not need Node, npm or Homebrew.
- Automatic service startup and dashboard unlock; private persistent data and controlled external sign-in links.
- Pinned SHA-256-verified CLIProxyAPI setup for ChatGPT and portable tool detection.
- Guided setup, in-dashboard endpoint verification, app-key instructions and an OpenAPI-backed API reference.
- Cross-platform builds and synthetic startup checks, preserving authentication and quota protections.

**Installation notes:** Mac apps use ad-hoc signatures and are not notarized; Windows installers are unsigned. Gemini requires a separate Antigravity CLI installation and enabled school subscription; its integration is not enabled on Windows. The complete live subscription workflow has been checked on Apple Silicon macOS. Build checks do not verify institutional entitlements on other systems.

See the [setup guide](https://github.com/mysterious-joker/nus-soc-ai-gateway/blob/main/docs/setup.md) for installation, migration and troubleshooting. Download your architecture and use SHA256SUMS.txt to verify files. Existing browser-only installations still work with npm start and npm run open.
