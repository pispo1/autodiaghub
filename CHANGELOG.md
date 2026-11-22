# Changelog

## Unreleased

### Added

- Initial AutoDiagHub documentation covering the proposed architecture, project status, technical decisions, and agent instructions.
- Static diagnostics app with BLE adapter discovery, ELM327 health checks, a read-only generic stored-code scan, and offline caching.
- GitHub Actions workflow to publish the static app to GitHub Pages.
- General OBD-II mode browser with support discovery, live and freeze-frame values, monitor test results, vehicle information, and stored, pending, and permanent trouble codes.
- Local reading history with manual saves, mode filtering, deletion, and trends for comparable live values.
- Offline PSA-RE catalog for the C4 Picasso with read-only ECU scanning, parameter reads, and active or confirmed UDS trouble-code reads.
- Searchable ECU parameters, batch reads, readable UDS fault status flags, and locally saved ECU snapshots.
- **Refresh app** control to update the offline app files while preserving saved readings.
- Remembered PSA vehicle and variant selection and documented per-ECU DTC reads and confirmed clearing for UDS and PSA KWP models.
- Actual ELM327 Health values, including a dedicated firmware version and an on-demand check for the active protocol and vehicle reply.
- Searchable offline picker for the complete pinned PSA-RE vehicle catalog, with live scan coverage labeled by variant.

### Changed

- Defined the first milestone as offline-capable, read-only diagnostics for a Citroën C4 Picasso using Bluefy on iPhone and an ELM327-compatible BLE adapter.
- Documented Stethos as the project's starting point and an optional reference.
- Identified PSA-RE as the reference for PSA-specific messages and ECU diagnostic data.
- Defined the three app sections and the requirements for generic mode reporting, PSA ECU discovery, parameter reads, and confirmed per-ECU DTC clearing.
