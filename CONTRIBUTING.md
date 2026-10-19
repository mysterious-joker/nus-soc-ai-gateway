# Contributing

Contributions that make institutional AI access easier to understand and use are welcome: reproducible bug fixes, connector compatibility, accessibility, documentation and focused tests.

## Development

Use Node.js 22.13+ (Node 24 is selected by `.nvmrc`). Clone your fork and run:

```sh
npm ci
npm run check
npm run format:check
npm test
```

Run `npm run format` before committing. Core tests use fake providers and temporary directories; no school credentials or installed provider CLIs are needed. CI runs these checks on Node 22 and 24. The full live workflow is currently tested on macOS.

## Pull requests

Keep changes focused. Explain the user-visible problem, the resulting behavior, and how it was tested. Add a regression test for behavior/security changes. Never hardcode personal model access, project IDs, accounts or balances. Keep discovery metadata separate from verified request access and preserve explicit unsupported-capability errors.

New connectors should document authentication, discovery, supported endpoints, quota behavior, credential storage and failure modes. Use official provider documentation where available. Do not add fallback billing paths or silently substitute models.

## Issues and test evidence

Report your OS, Node version, connector versions and sanitized reproduction steps. Use synthetic prompts/files. Remove names, emails, project identifiers, keys, cookies and tokens from reports and screenshots. Do not upload runtime folders. Report security issues privately using [SECURITY.md](SECURITY.md).

Live verification is optional and must be run explicitly on accounts you are authorized to use. It consumes allowance and must not run in pull-request CI. A catalog listing alone is not proof that inference works.

Be respectful and constructive. By contributing, you agree that your contributions are distributed under the project's [MIT license](LICENSE).
