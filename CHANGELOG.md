# Changelog

## 2.3.2 — 2026-10-22

- Extend ChatGPT Chat Completions and Responses to a bounded 600-second total deadline, including streamed output. Clients should allow at least 630 seconds.
- Align HTTP header/body transport deadlines and built-in verification clients so they do not cut off long requests prematurely.
- Preserve disconnect cancellation, failure accounting and existing limits for other providers and media. No automatic retries are added.
- Add regressions for delayed completion, exact deadline enforcement, partial-stream timeouts, disconnects and multipart upload compatibility.

## 2.3.1 — 2026-10-22

- Reject empty or whitespace-only Gemini results instead of returning a successful completion.
- Allow 300 seconds for Gemini CLI generation and 315 seconds for its wrapper; full verification and smoke clients allow 330 seconds.
- Return safe machine-readable empty-response, timeout and upstream-failure codes. Streaming failures never emit a successful completion, and the usage ledger records the failure.
- Add regressions for blank output, partial-stream failure, diagnostic redaction and exact deadline enforcement.

## 2.3.0 — 2026-10-22

- Added **Connect Gemini**: prepares a checksum-verified official CLI when needed, reuses a saved school session, or opens guided sign-in and connects automatically.
- Added setup progress, cancellation, timeout, private diagnostic cleanup and protection against simultaneous full verification.
- Preserved exact school-domain checks, keyring-based subscription authentication, isolated workspace restrictions and rejection of API-key/ADC overrides.
- Added eight onboarding regression tests, desktop checks for the connection button and official CLI download/startup checks on supported build targets.
- Updated setup, architecture and third-party documentation. Gemini remains available on macOS/Linux; Windows integration is not enabled.

## 2.2.1 — 2026-10-21

- Fix invalid Mac bundle signatures that caused the downloaded app to be reported as damaged. Apply ad-hoc signing after packaging; Developer ID signing and notarization remain unavailable.
- Verify signature integrity and launch the actual app inside each Mac DMG in CI before publishing.
- Check that the Models tab exposes **Verify all models** in desktop smoke tests.
- Document replacing old Mac builds and quitting older running instances before opening an update.

## 2.2.0 — 2026-10-21

- Add **Verify all models** to check every detected model's supported endpoints in one click, with progress, per-endpoint results and cancellation.
- Use short prompts, the lowest advertised ChatGPT reasoning level, a 32-token SoCLaaS output cap and bundled tiny media fixtures. Share speech/realtime generation evidence to avoid duplicate requests.
- Run checks sequentially without retries; pause a source on authentication, quota or service-availability errors. Preserve dashboard authentication, CSRF, quota checks and usage accounting.
- Keep batch progress across dashboard reloads; cancel on lock or shutdown and block source changes during a run. Unsupported or stale models remain explicitly skipped.
- Document probe coverage, CLI token-limit restrictions and interpretation of failed minimal requests. Add synthetic integration coverage and portable fixture tests.

## 2.1.2 — 2026-10-21

- Show all detected models in the dashboard by default, including untested and unavailable entries with their status.
- Add a direct Verify action for untested, supported models and distinguish detected counts from verified app access.
- Preserve the requirement for successful endpoint checks before exposing models to app API keys.

## 2.1.1 — 2026-10-21

- Fix reopening a locked dashboard from a token link without a full page reload.
- Cover lock/reopen in the desktop smoke test. First published desktop installers include this correction; the 2.1.0 release workflow was stopped before publication.

## 2.1.0 — 2026-10-21

- Desktop application with bundled runtime, automatic service lifecycle and dashboard unlock.
- Pinned, checksum-verified ChatGPT tool setup and portable executable/browser discovery.
- Guided onboarding, endpoint verification in the Playground and clearer app-key setup.
- Installer builds and synthetic desktop checks for macOS, Linux and Windows.
- Platform coverage, migration, release and third-party component documentation.

- User-friendly local API reference with copyable requests, response examples, required fields and provider restrictions.
- Downloadable OpenAPI 3.1 client contract with CI validation and route coverage checks.

## 2.0.0 — 2026-10-19

Initial public release as **NUS SoC AI Gateway**.

- Local dashboard and API for ChatGPT Edu, Gemini Enterprise CLI and SoCLaaS.
- Institutional identity validation, separate dashboard/app authentication and local credential storage.
- Dynamic model discovery with source provenance and account-scoped endpoint verification.
- Text streaming, embeddings, image generation/editing, speech recognition, speech synthesis and realtime audio where supported by the connected source.
- Provider-reported usage, available quota views, and explicit unavailable-balance states.
- Repeatable opt-in live diagnostics, mocked regression tests and CI.
- Setup, API, architecture, verification, contribution and security documentation.
