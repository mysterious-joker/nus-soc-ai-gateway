# Third-party components

NUS SoC AI Gateway is an independent project under the MIT license. It is not endorsed by NUS, OpenAI, Google, or the maintainers of CLIProxyAPI.

- **Electron** (MIT) supplies the desktop runtime, including Chromium and Node.js. Runtime license and Chromium notices are included in the desktop distribution. See [Electron licenses](https://github.com/electron/electron/blob/main/LICENSE).
- **CLIProxyAPI** (MIT), maintained by router-for-me, bridges ChatGPT subscription sessions. The gateway downloads a pinned release from its [official repository](https://github.com/router-for-me/CLIProxyAPI), verifies the archive against a reviewed SHA-256 digest, and retains its license alongside the installed executable. It runs as a separate local process.
- **Google Antigravity CLI** is installed separately from Google's official distribution and governed by Google's terms. This repository does not redistribute it. Your account must have access to the institutional CLI subscription.
- JavaScript runtime dependencies include **ws**, **tar**, and **yauzl**, with their transitive dependencies. Their license files ship inside the application archive. Exact versions and integrity hashes are recorded in `package-lock.json`.

The build uses a `global-agent` 4.1.3 override to remove the vulnerable legacy logger pulled in by the desktop builder's downloader. Build and smoke tests exercise the resulting dependency tree. Review this override when updating electron-builder.
