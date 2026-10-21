Gemini setup now starts with **Sources → Connect Gemini**.

- Prepares Google’s official CLI automatically when missing, with a pinned SHA-512-verified download. No Homebrew or shell commands are required.
- Reuses an existing school login immediately. Otherwise, opens a terminal for Google sign-in and first-run prompts, then connects and discovers models automatically.
- Shows progress and supports cancellation. Exact `@comp.nus.edu.sg` checks, subscription-session authentication and tool restrictions remain enforced.
- Keeps the one-click **Models → Verify all models** feature and existing connections, usage history and app keys.

Saved-login connection was checked through the dashboard on Apple Silicon using the managed CLI: 14 Gemini model entries were discovered without an inference request. New-account consent remains an interactive Google flow; its orchestration is covered by synthetic tests. Fifty regression tests pass locally. Release builds also check desktop startup, the connection controls, verified tool downloads and Mac DMG signatures/startup.

Install this update over the existing app, after quitting it, to retain your local data. For your Apple Silicon Mac, choose **nus-soc-ai-gateway-2.3.0-mac-arm64.dmg**. Other assets cover Intel Mac, Linux x64 and Windows x64.

**Platform notes:** Guided Gemini setup supports macOS and Linux with a graphical terminal; Windows Gemini integration is not enabled. Your school account must have CLI subscription access. Fresh sign-in may require selecting the institutional subscription and completing first-run prompts. Cancel setup stops gateway auto-connection; close the external sign-in terminal separately. The gateway does not use a Google developer API key or Vertex fallback.

Mac apps are ad-hoc signed but not notarized; Windows installers are unsigned. Managed devices may need administrator approval. No system-wide security changes are required. Version 2.2.1’s Mac signature fix is included.

See the [setup guide](https://github.com/mysterious-joker/nus-soc-ai-gateway/blob/main/docs/setup.md) for sign-in, migration and troubleshooting. SHA256SUMS.txt contains installer checksums. Browser-only source installations remain supported.
