# Project status

**Current phase** · ELM327 Health, General OBD-II, and PSA Diagnostics are implemented. Synthetic tests cover scan outcomes, parameter decoding, and UDS and PSA KWP trouble-code reads and clears. Device testing in Bluefy is pending.

## Remaining work

- [ ] Identify the ELM327 adapter model and confirm it exposes BLE. Record the C4 Picasso model year and engine, and the iOS and Bluefy versions used for testing.
- [ ] Verify that a minimal HTTPS page can connect to the adapter from Bluefy. Confirm the adapter's GATT service and its command and response characteristics.
- [ ] Verify that the same page can be closed and reopened in Bluefy with Wi-Fi and cellular data disabled and Bluetooth still enabled after initial setup.
- [x] Implement ELM327 Health and the first generic stored-code read. Exercise both with synthetic replies.
- [x] Display the reported firmware number, supply voltage, protocol code, and actual PID `$00` response in the health check.
- [ ] Run a read on the parked C4 Picasso, repeat it offline, and document the setup and testing results in the [README](README.md).

## General OBD-II and PSA diagnostics

- [x] Expand General OBD-II to show mode descriptions, support status, and returned data by service.
- [x] Save selected General OBD-II readings locally and review them offline, with trends for comparable live readings.
- [x] Bundle four C4 Picasso profiles and their matched diagnostic definitions from a pinned PSA-RE revision.
- [x] Include all 155 variants from the pinned PSA-RE vehicle catalog and label live scan coverage in the offline picker.
- [x] Implement ECU scanning for documented diagnostic routes, parameter reads, and active or confirmed UDS DTC reads.
- [x] Add searchable ECU parameters, batch reads, readable UDS status flags, and locally saved ECU snapshots.
- [x] Restore the selected vehicle and variant from browser storage.
- [x] Implement and simulate documented per-ECU DTC reads and confirmed clearing for UDS and PSA KWP.
- [ ] Match the target C4 Picasso to a bundled profile and verify its ECU reachability and read results in Bluefy.
- [ ] Verify which UDS ECU models support fault freeze-frame reads and how their records are decoded.
- [ ] Verify per-ECU DTC reads, clear acknowledgements, and follow-up results on the target vehicle.

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
