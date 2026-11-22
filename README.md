# AutoDiagHub

AutoDiagHub is a planned offline-first web app for vehicle diagnostics using an iPhone, the Bluefy browser, and an ELM327-compatible OBD-II adapter. The Citroën C4 Picasso is the first vehicle to validate.

## App sections

| Section | What it does |
| --- | --- |
| ELM327 Health | Check whether the adapter responds. Show its reported version, measured supply voltage where available, and the active OBD protocol after a successful vehicle connection. |
| General OBD-II | Show generic diagnostics by hexadecimal service mode. Explain each mode and display the data the vehicle returns, such as live parameters, freeze-frame data, readiness, and trouble codes. |
| PSA Diagnostics | Select a vehicle and variant from the PSA-RE catalog. Scan the expected electronic control units (ECUs) and show which respond. Open a detected ECU to read supported parameters and diagnostic trouble codes (DTCs), or clear its DTCs where the operation is verified. |

## First implementation

The static app in `dist/` implements ELM327 Health and the generic `$03` stored-code read. The PSA vehicle catalog, ECU scanning, and DTC clearing are planned features.

Bluefy connects to Bluetooth Low Energy (BLE) peripherals using Web Bluetooth. The ELM327 adapter must expose a compatible BLE GATT interface. A Bluetooth Classic-only adapter is incompatible with this connection path. [Bluefy documentation](https://bluefy.app/)

### Run locally

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

Open `http://127.0.0.1:8000/` on the same computer. Run `node --test` from the repository root to check the diagnostic flow with simulated replies.

### Publish to GitHub Pages

1. In the repository's Pages settings, set **Build and deployment → Source** to **GitHub Actions**. With **Deploy from a branch** and **/(root)** selected, GitHub publishes the repository root and the app is served at `/autodiaghub/dist/`. [AutoDiagHub Pages settings](https://github.com/pispo1/autodiaghub/settings/pages) · [GitHub Pages setup](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
2. Commit the app in `dist/` and the [deployment workflow](.github/workflows/pages.yml), then push to `main`. The workflow publishes the contents of `dist/` on each push to `main` after Pages is configured.
3. Once the deployment succeeds, open the project URL in Bluefy. [GitHub Actions runs](https://github.com/pispo1/autodiaghub/actions) · [AutoDiagHub on GitHub Pages](https://pispo1.github.io/autodiaghub/)

When updating cached app files, bump the cache version in [`dist/sw.js`](dist/sw.js) so existing installations pick up the new files.

### Test on the iPhone

1. Serve the contents of `dist/` from an HTTPS URL reachable by the iPhone and open it in Bluefy. The app is ready for an offline test once it shows **App cached**.
2. With the car parked and the ignition on, connect the adapter. Automatic detection tries BLE service UUIDs `FFF0`, `FFE0`, and Nordic UART. If necessary, enter the adapter's documented service UUID under **Adapter settings**. The service must expose an identifiable command writer and response notifier.
3. Confirm the firmware and supply voltage under **ELM327 Health**, then tap **Read stored codes**. The active protocol appears after a successful read.
4. Close the page, disable Wi-Fi and cellular data, leave Bluetooth enabled, and reopen the same URL in Bluefy. Reconnect and repeat the read.

Compatibility with the specific adapter, the C4 Picasso, and offline reopening in Bluefy still needs device testing.

## Project references

Stethos was the starting point for AutoDiagHub. It documents the same connection path through Bluefy and a BLE OBD-II adapter, and can serve as an optional compatibility check with the C4 Picasso. [Stethos app](https://s1v.github.io/Stethos/) · [English documentation](https://github.com/s1v/Stethos/blob/main/README.en.md)

PSA-RE is the reference for future PSA-specific diagnostics. Its YAML files describe vehicle variants, in-car messages and signals, and ECU diagnostic data. The relevant entries depend on the exact C4 Picasso variant. [PSA-RE repository](https://github.com/prototux/PSA-RE)

## Documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Proposed architecture and data flow |
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | Status, remaining tasks, and acceptance criteria |
| [DECISIONS.md](DECISIONS.md) | Technical decisions, rationale, and open questions |
| [AGENTS.md](AGENTS.md) | Instructions for agents working in the repository |
| [CHANGELOG.md](CHANGELOG.md) | Change history |
