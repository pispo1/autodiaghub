# Changelog

## Unreleased

### Added

- Initial AutoDiagHub documentation covering the proposed architecture, project status, technical decisions, and agent instructions.
- Static diagnostics app with BLE adapter discovery, ELM327 health checks, a read-only generic stored-code scan, and offline caching.
- GitHub Actions workflow to publish the static app to GitHub Pages.

### Changed

- Defined the first milestone as offline-capable, read-only diagnostics for a Citroën C4 Picasso using Bluefy on iPhone and an ELM327-compatible BLE adapter.
- Documented Stethos as the project's starting point and an optional reference.
- Identified PSA-RE as the reference for PSA-specific messages and ECU diagnostic data.
- Defined the three app sections and the requirements for generic mode reporting, PSA ECU discovery, parameter reads, and confirmed per-ECU DTC clearing.
