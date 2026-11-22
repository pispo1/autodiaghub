# Technical decisions

## D-001. Use Bluefy and Web Bluetooth on iPhone

**Status** · Project direction. Adapter compatibility pending.

Bluefy gives a web page access to BLE peripherals. Confirm that the specific ELM327 adapter exposes a usable GATT interface before building the diagnostic workflow. [Bluefy documentation](https://bluefy.app/)

## D-002. Keep the app and diagnostic processing local

**Status** · Project direction. Offline reopening pending verification.

Serve a static app over HTTPS and test service worker caching in Bluefy. Once cached, the app should reopen offline and process vehicle replies locally. [Service worker guide](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)

## D-003. Validate adapter health and one generic OBD-II read first

**Status** · Proposed first milestone.

Adapter checks and a read-only stored-code request verify the connection from iPhone to vehicle before expanding generic mode coverage and implementing the PSA workflow. Keep response parsing independent of BLE so it can be tested with synthetic data.

## D-004. Treat Stethos as an optional reference

**Status** · Project direction.

Stethos inspired the project and documents a Bluefy-to-BLE adapter workflow that can be used to check the hardware setup. AutoDiagHub owns its connection and diagnostic flow. [Stethos English documentation](https://github.com/s1v/Stethos/blob/main/README.en.md)

## D-005. Use PSA-RE as the PSA message reference

**Status** · Full PSA-RE vehicle catalog bundled. Live scan routes cover four C4 Picasso profiles. Hardware validation is pending.

Use pinned PSA-RE data for vehicle and ECU browsing offline. Enable live scans for profiles with bundled diagnostic routes. Scans use documented identification requests. [Pinned PSA-RE revision](https://github.com/prototux/PSA-RE/tree/67f7581e7622410efdbb29c7eda3b86982b9b450)

## D-006. Require confirmation for per-ECU DTC clearing

**Status** · Implemented for documented UDS and PSA KWP targets. Hardware verification is pending.

Keep discovery and reads independent of clearing. The clear action names the detected ECU and states the scope of the operation. Confirm the target with a fresh read, send one clear request, and reread its DTCs. Report missing acknowledgement or follow-up data as an uncertain outcome.

## Open decisions

| Decision | Information needed |
| --- | --- |
| BLE adapter profile | Exact adapter model and verified GATT service and characteristic UUIDs |
| Offline delivery | Bluefy cache and reopening test on the target iPhone |
| First PSA-specific read | Exact C4 Picasso variant, relevant PSA-RE entries, and verified adapter access |
