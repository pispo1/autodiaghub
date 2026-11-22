# Architecture

The prototype is a static web app loaded over HTTPS in Bluefy on the iPhone. The page handles the Bluetooth connection and decodes diagnostic results locally. A service worker caches the app for offline reopening. [Service worker guide](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)

## Proposed data flow

```mermaid
flowchart LR
    A[Web app in Bluefy] <-->|Web Bluetooth| B[ELM327-compatible BLE adapter]
    B <-->|OBD-II| C[Citroën C4 Picasso]
```

- A user-initiated connection opens the adapter's BLE GATT service. Use the service and characteristic UUIDs for the exact adapter model, then confirm they work in Bluefy. [Web Bluetooth documentation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API)
- The three sections share a single adapter connection. Serialize requests so replies from health checks, generic diagnostics, and PSA diagnostics can be matched to the correct request. Parse replies independently of BLE so the diagnostic layer can be tested with synthetic responses.
- All runtime assets are packaged with the app. The service worker caches them after the first HTTPS visit. The diagnostic session needs no backend or external requests. Verify offline reopening in Bluefy itself.

## ELM327 Health

Check BLE connectivity and adapter command response separately from communication with the vehicle. Show the adapter's reported identity and firmware version, its voltage reading when available, and the selected vehicle protocol after successful OBD communication. Treat the version string as self-reported and show which checks actually passed. [ELM327 datasheet](https://www.mouser.com/datasheet/2/813/ELM327DS-2489024.pdf)

## General OBD-II

Start with the stored-code read (mode `$03`). Organize generic diagnostics by service mode and show supported data within each mode. Use supported-PID responses where applicable and otherwise record the outcome of the relevant read. Keep a successful empty result, an explicit unsupported response, and an undetermined result such as a timeout distinct. Track the responding ECU when the adapter exposes it. [ELM327 datasheet](https://www.mouser.com/datasheet/2/813/ELM327DS-2489024.pdf)

Show descriptions for modes that change vehicle state, including `$04` (clear emissions-related diagnostic information) and `$08` (control of an onboard system or test). Opening the section or checking support only sends read requests. The requested clear action is part of the PSA ECU workflow below. [OBD-II service modes](https://www.snapon.com/DiagnosticsManuals/Help/OBDII/Content/Common/Help%20Topics/OBD/OBDII%20Service%20Modes.htm)

## PSA-specific diagnostics

1. Select a vehicle and variant from a bundled PSA-RE catalog. Use the variant to identify candidate ECUs and their documented diagnostic protocols. [PSA-RE repository layout](https://github.com/prototux/PSA-RE#repository-layout)
2. Scan those candidates using read-only identification requests. Show which ECUs replied and which received no response or could not be reached through the adapter. A catalog entry describes what may be fitted. A reply establishes what was detected in this session.
3. For a detected ECU, show parameters with their units where defined and read its DTCs. Decode replies using the matching ECU definition.
4. Offer DTC clearing for an individually selected ECU only when the operation and its scope have been verified for that ECU. Show the target and what data the operation can erase, require confirmation, then reread the codes. If the connection drops or the result cannot be verified, report it as unconfirmed.

Bundle the vehicle catalog and relevant ECU definitions with the app so vehicle selection, scanning, and supported diagnostics can run offline.

See the [technical decisions](DECISIONS.md) and the [acceptance criteria](PROJECT_STATUS.md).
