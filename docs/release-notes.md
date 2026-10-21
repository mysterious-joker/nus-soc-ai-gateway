Desktop setup for NUS SoC AI Gateway: download, open, connect a source, test a model, and copy the connection details into your app.

- Native installers for Apple Silicon/Intel Macs, Windows x64 and Linux x64. Desktop users do not need Node, npm or Homebrew.
- Automatic service startup and dashboard unlock; private persistent data and controlled external sign-in links.
- Pinned SHA-256-verified CLIProxyAPI setup for ChatGPT and portable tool detection.
- Guided setup, in-dashboard endpoint verification, app-key instructions and an OpenAPI-backed API reference.
- Cross-platform builds and synthetic startup checks, preserving authentication and quota protections.

**Installation notes:** these first desktop builds are unsigned and macOS builds are not notarized. Gemini requires a separate Antigravity CLI installation and enabled school subscription; its integration is not enabled on Windows. The complete live subscription workflow has been checked on Apple Silicon macOS. Build checks do not verify institutional entitlements on other systems.

See the [setup guide](https://github.com/mysterious-joker/nus-soc-ai-gateway/blob/main/docs/setup.md) for installation, migration and troubleshooting. Download your architecture and use SHA256SUMS.txt to verify files. Existing browser-only installations still work with npm start and npm run open.
