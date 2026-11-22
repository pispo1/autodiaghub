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

**Status** · Reference identified. The vehicle variant and adapter coverage are pending.

Use PSA-RE to map the vehicle variant to its network and ECU definitions. Start with the entries relevant to the first PSA-specific read once that operation is selected. [PSA-RE repository](https://github.com/prototux/PSA-RE)

## D-006. Require confirmation for per-ECU DTC clearing

**Status** · Planned feature. Coverage depends on ECU and adapter verification.

Keep discovery and reads independent of clearing. The clear action names the detected ECU and states the scope of the operation. Reread its DTCs after the operation to verify the outcome.

## Open decisions

| Decision | Information needed |
| --- | --- |
| BLE adapter profile | Exact adapter model and verified GATT service and characteristic UUIDs |
| Offline delivery | Bluefy cache and reopening test on the target iPhone |
| First PSA-specific read | Exact C4 Picasso variant, relevant PSA-RE entries, and verified adapter access |
