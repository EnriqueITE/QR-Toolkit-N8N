# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Bound PNG and Base64 data URL input before decoding and cap aggregate compressed image data to prevent worker memory exhaustion.

## [0.1.0] - 2026-07-19

### Added

- Initial QR Toolkit community node for n8n.
- Local QR Model 2 encoding for UTF-8 byte content with versions 1-40.
- L, M, Q, and H error-correction levels with automatic version and mask selection.
- PNG, SVG, and Base64 PNG data URL output.
- Configurable width, margin, dark color, light color, binary property name, and file name.
- Native n8n binary metadata, item linking, expression support, and sequential multi-item processing.
- Automated validation and provenance-backed npm publishing workflows.
- Local PNG QR decoding with binary-property and Base64 data URL inputs.
- QR reading for numeric, alphanumeric, and byte payloads, including UTF-8 ECI data.
- Scoped npm package identity under `@cyberace/n8n-nodes-qr`.

[Unreleased]: https://github.com/EnriqueITE/QR-Toolkit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/EnriqueITE/QR-Toolkit/releases/tag/v0.1.0
