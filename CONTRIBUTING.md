# Contributing

Thank you for helping improve QR Toolkit. Contributions should keep the node small, auditable, local-only, and compatible with n8n community-node requirements.

## Before opening an issue

- Search existing issues and confirm that the behavior is not already documented.
- Include the n8n version, Node.js version, QR Toolkit version, output format, error-correction level, and a minimal content example.
- Do not include secrets, credentials, personal data, or sensitive QR content.
- For scanning problems, state which scanner was used and whether the default colors and four-module margin reproduce the issue.

## Development setup

Use Node.js 24.15.0 or later in the 24.x line to install the locked development tools. The n8n CLI depends on a native module that requires Node.js 24. This requirement applies to developing the node, not to installing the published package.

```bash
npm ci
npm run dev
```

CI also installs the packed node into a separate consumer project with Node.js 22 and a compatible `n8n-workflow` peer. It generates a QR and reads its content back without installing the development tools in that project.

Keep the node interface, source comments intended for users, errors, tests, and documentation in English.

## Design constraints

- Do not add runtime dependencies.
- Do not access environment variables, credentials, the network, or the file system.
- Do not execute commands, use `eval`, add telemetry, or introduce obfuscated/generated source that cannot be audited.
- Preserve incoming JSON and binary data, item linking, expression behavior, and `Continue On Fail` behavior.
- Keep SVG output geometry-only; encoded content must never be inserted into markup.
- Maintain QR Model 2 compatibility and test every error-correction level when changing the encoder.
- Avoid breaking parameter names or output fields. If a breaking change is unavoidable, discuss it in an issue first and document the migration.

## Quality checks

Run the same checks used in CI before opening a pull request:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run verify
npm pack --dry-run
npm audit --audit-level=high
```

Add focused tests for behavior changes. Encoder changes should cover known QR vectors or round-trip decoding, boundary capacities, relevant QR versions, all affected error-correction levels, and renderer output where applicable.

## Pull requests

- Keep each pull request focused on one change.
- Explain the user-visible behavior and the reason for the change.
- Include tests and update README or changelog content when behavior changes.
- Confirm that the package still has no runtime dependencies.
- Do not commit generated tarballs, coverage output, local n8n data, editor settings, or secrets.
- Allow maintainers to request changes needed for n8n UX, verification, security, or compatibility requirements.

By contributing, you agree that your contribution is licensed under the MIT License in [LICENSE.md](LICENSE.md).
