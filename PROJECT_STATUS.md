# Project status

**Current phase** · First implementation. ELM327 Health and the generic stored-code read passed synthetic tests. Chrome reopened the cached app and repeated a scan with simulated Bluetooth while offline. Device testing in Bluefy is pending.

## Remaining work

- [ ] Identify the ELM327 adapter model and confirm it exposes BLE. Record the C4 Picasso model year and engine, and the iOS and Bluefy versions used for testing.
- [ ] Verify that a minimal HTTPS page can connect to the adapter from Bluefy. Confirm the adapter's GATT service and its command and response characteristics.
- [ ] Verify that the same page can be closed and reopened in Bluefy with Wi-Fi and cellular data disabled and Bluetooth still enabled after initial setup.
- [x] Implement ELM327 Health and the first generic stored-code read. Exercise both with synthetic replies.
- [ ] Run a read on the parked C4 Picasso, repeat it offline, and document the setup and testing results in the [README](README.md).

## General OBD-II and PSA diagnostics

- [ ] Expand General OBD-II to show mode descriptions, support status, and returned data by service.
- [ ] Bundle the PSA-RE vehicle list and match the C4 Picasso's generation, model year, and engine to its catalog variant. [PSA-RE vehicle list](https://github.com/prototux/PSA-RE/tree/master/cars)
- [ ] Scan the selected variant's expected ECUs and check what the adapter can reach through the OBD-II port.
- [ ] Implement parameter and DTC reads for detected ECUs with verified definitions.
- [ ] Implement confirmed, per-ECU DTC clearing for supported targets and verify the outcome with a follow-up read.

## Prototype acceptance criteria

- Bluefy connects to the confirmed BLE adapter from the app on the iPhone.
- ELM327 Health shows the adapter's reported version and distinguishes adapter responsiveness from successful vehicle communication.
- The app performs a stored-code read on the C4 Picasso and displays the codes or a successful empty result.
- Synthetic tests cover replies with codes, successful empty replies, and invalid replies. A disconnected adapter produces a connection error.
- After the initial HTTPS visit and caching, the app reopens in Bluefy and completes a diagnostic read with Wi-Fi and cellular data disabled and Bluetooth enabled.

## Full app acceptance criteria

- General OBD-II shows mode descriptions and returned data, with distinct states for unsupported, empty, and failed or unconfirmed reads. Its support checks leave diagnostic records intact.
- PSA vehicle selection works offline. The scan lists confirmed responders separately from expected ECUs that did not reply or could not be reached.
- A detected ECU with verified definitions supports parameter and DTC reads. For a verified clear operation, cancelling sends no clear request, and confirming sends one to the displayed target and triggers a follow-up read.
