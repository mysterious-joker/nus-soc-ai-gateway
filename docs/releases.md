# Release engineering

## Local checks

Use Node 24 and the committed lockfile:

```sh
npm ci
npm run check
npm run format:check
npm test
npm audit
npm run test:desktop
npm run build:desktop
```

Desktop smoke uses a temporary empty profile, starts the real HTTP server and renderer, checks automatic unlock, lock/reopen, token-fragment removal and absence of Node globals, then quits and removes its state. It does not sign into providers or generate content. Headless Linux runners use Xvfb; CI's --no-sandbox flag is not part of production launch configuration.

The icon is generated from the project's geometric mark by `node scripts/icon.js`. Packaging uses an explicit source allowlist: private data, reports, tests, development scripts and Git state are excluded. Runtime dependencies and licenses are included. Run the packaged application with --smoke-test before release where practical.

## CI and publishing

Core CI checks Node 22 and 24. Desktop CI runs tests and startup checks on Windows x64, Linux x64, macOS arm64 and macOS x64, then uploads native installers. Three subprocess fixtures are POSIX-only and skipped on Windows; Gemini integration is disabled there.

Update package.json, package-lock.json, CHANGELOG.md and docs/release-notes.md; push commits and wait for checks; then push a matching vX.Y.Z tag. The desktop workflow rebuilds all platforms and publishes only after the entire matrix succeeds. Releases include SHA256SUMS.txt. Actions are pinned to commit hashes; only the release job has repository write permission.

Version 2.1.1 installers are unsigned and macOS builds are not notarized. Signing certificates and real institutional accounts are unavailable in CI. Do not describe build/startup checks as live subscription verification. Signing should be configured through protected CI secrets in a later release.

## Updating connection tools

CLIProxyAPI release names, version and SHA-256 digests live in lib/tools.js. Obtain upstream digests, inspect binary/license layout, update the manifest and tests, and test a real download. The installer does not execute remote shell scripts or extract arbitrary archive paths. Antigravity remains a separate official installation.

Review npm audit and compatibility notes when updating dependencies. The desktop Gemini deny hook uses Electron's bundled Node runtime via ELECTRON_RUN_AS_NODE; disabling that fuse requires replacing and re-verifying the hook runtime.
