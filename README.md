# AutoDiagHub

AutoDiagHub is a planned offline-first web app for vehicle diagnostics using an iPhone, the Bluefy browser, and an ELM327-compatible OBD-II adapter. The Citroën C4 Picasso is the first vehicle to validate.

## App sections

| Section | What it does |
| --- | --- |
| ELM327 Health | Check whether the adapter responds. Show its reported version, measured supply voltage where available, and the active OBD protocol after a successful vehicle connection. |
| General OBD-II | Show generic diagnostics by hexadecimal service mode. Explain each mode and display the data the vehicle returns, such as live parameters, freeze-frame data, readiness, and trouble codes. |
| PSA Diagnostics | Select a vehicle and variant from the PSA-RE catalog. Scan the expected electronic control units (ECUs) and show which respond. Open a detected ECU to read supported parameters and diagnostic trouble codes (DTCs), or clear its DTCs where the operation is verified. |

## Current implementation

The static app in `dist/` implements ELM327 Health, General OBD-II, and PSA Diagnostics with per-ECU trouble-code reads and confirmed clearing on supported models.

In **General OBD-II**, choose a service mode and start a read. For parameterized modes, use **Find supported IDs** to list the identifiers the vehicle reports, or enter a known hexadecimal ID. For freeze-frame data, choose a frame number. Common parameters are decoded with units, and data without a decoder is shown as hexadecimal. Modes `$04` and `$08` provide descriptions only.

Select **Save reading** after a successful read to keep a timestamped copy in this browser's local storage. Open **Saved readings** to review it offline, filter by mode, or delete it. For comparable live readings, history shows a trend once two or more samples are saved. Readings stay in the browser that saved them and are removed if its site data is cleared.

### PSA Diagnostics

1. Open **PSA Diagnostics** and use **Find a vehicle** to search by make, model, alternate name, or project code. The offline catalog includes 155 variants from all 118 vehicle files in the pinned PSA-RE snapshot. The app restores your selection in the same browser.
2. Variants marked **Catalog only** show the ECU inventory where PSA-RE provides one. **Scan available** applies to the four bundled C4 Picasso profiles. For these profiles, connect the adapter with the car parked and tap **Scan ECUs**. The app reports identification replies, rejected requests, and no replies separately.
3. Select a responding ECU and confirm its model from the candidates in the catalog. Search by parameter name or ID, select the values you want, and tap **Read selected parameters**. The app reads them in sequence and shows the result or error for each. Supported UDS models show active or confirmed DTCs with status flags, and supported PSA KWP models show DTCs with their raw status byte.
4. Tap **Save ECU snapshot** to keep the results with the vehicle, variant, and ECU model. Find them offline under **Saved readings → PSA ECU snapshots**.
5. After a successful DTC read, select **Clear ECU DTCs** if the selected model documents clearing. The confirmation names the ECU and explains which data may be erased. The app sends one clear request and rereads that ECU to report the result.

ECU fault freeze-frame reads and hardware verification of per-ECU DTC operations are pending.

The [bundled PSA-RE catalog](dist/psa/NOTICE.txt) is generated with [`scripts/build-psa-catalog.rb`](scripts/build-psa-catalog.rb) from the [pinned PSA-RE revision](https://github.com/prototux/PSA-RE/tree/67f7581e7622410efdbb29c7eda3b86982b9b450). To regenerate it, pass the local PSA-RE checkout and its full revision to the script.

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

In Bluefy, tap **Refresh app** beside **App cached** while online to download the latest published files and reload. If the download fails, you can keep using the cached version. Saved readings and ECU snapshots remain available.

### Test on the iPhone

1. Serve the contents of `dist/` from an HTTPS URL reachable by the iPhone and open it in Bluefy. The app is ready for an offline test once it shows **App cached**.
2. With the car parked and the ignition on, connect the adapter. Automatic detection tries BLE service UUIDs `FFF0`, `FFE0`, and Nordic UART. If necessary, enter the adapter's documented service UUID under **Adapter settings**. The service must expose an identifiable command writer and response notifier.
3. Under **ELM327 Health**, tap **Check adapter and vehicle** to see the reported firmware version, identification reply, supply voltage, active protocol and protocol code, and the raw OBD-II PID `$00` reply. Then select **$03 · Stored trouble codes** and tap **Read stored trouble codes**.
4. Close the page, disable Wi-Fi and cellular data, leave Bluetooth enabled, and reopen the same URL in Bluefy. Reconnect and repeat the read.

Compatibility with the specific adapter, the C4 Picasso, and offline reopening in Bluefy still needs device testing.

## Project references

Stethos was the starting point for AutoDiagHub. It documents the same connection path through Bluefy and a BLE OBD-II adapter, and can serve as an optional compatibility check with the C4 Picasso. [Stethos app](https://s1v.github.io/Stethos/) · [English documentation](https://github.com/s1v/Stethos/blob/main/README.en.md)

PSA-RE provides the vehicle and ECU definitions for PSA Diagnostics. It also documents in-car messages and signals. [PSA-RE repository](https://github.com/prototux/PSA-RE)

## Documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Proposed architecture and data flow |
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | Status, remaining tasks, and acceptance criteria |
| [DECISIONS.md](DECISIONS.md) | Technical decisions, rationale, and open questions |
| [AGENTS.md](AGENTS.md) | Instructions for agents working in the repository |
| [CHANGELOG.md](CHANGELOG.md) | Change history |
