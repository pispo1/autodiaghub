# Agent instructions

- Read [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md), [PROJECT_STATUS.md](PROJECT_STATUS.md), and [DECISIONS.md](DECISIONS.md) before changing the integration.
- Verify adapter UUIDs and BLE behavior against the exact adapter model. Treat Bluefy offline and vehicle compatibility as unverified until tested on the target devices.
- Keep the first vehicle workflow read-only and process diagnostic results locally. Treat Stethos as an optional reference.
- Keep support checks and ECU scans read-only. Send a clear request only after explicit confirmation for a detected ECU with a verified clear operation, then check the result with a follow-up read.
- For PSA-specific diagnostics, verify definitions against the PSA-RE entries for the exact vehicle architecture and ECU. Record the upstream revision for any definitions bundled with the app. [PSA-RE repository](https://github.com/prototux/PSA-RE)
- Use synthetic samples in automated tests. Keep credentials, full vehicle identification numbers (VINs), and customer data out of the repository.
- When changing the diagnostic flow, verify the applicable cases in [PROJECT_STATUS.md](PROJECT_STATUS.md) and report which ones you checked.
- When an integration decision changes, update [DECISIONS.md](DECISIONS.md) with the rationale and revise [ARCHITECTURE.md](ARCHITECTURE.md) as needed.
- Update [PROJECT_STATUS.md](PROJECT_STATUS.md) as work progresses and [CHANGELOG.md](CHANGELOG.md) for changes that affect project users.
