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
- The adapter command wrapper captures a session-wide trace with timestamps. Session exports include operation boundaries, available PSA context, and interrupted replies. The browser checkpoints the latest trace after operations and on disconnect or page exit. Per-reading exports keep their own scope.
- All runtime assets are packaged with the app. The service worker caches them after the first HTTPS visit. The diagnostic session needs no backend or external requests. Verify offline reopening in Bluefy itself.

## ELM327 Health

Read adapter identification and supply voltage on connection. Extract the reported version from the identification reply and display the reply separately. **Check adapter and vehicle** sends a read-only PID `$00` request and displays the actual reply and active protocol code after successful communication. Missing values are labeled individually. [ELM327 datasheet](https://www.mouser.com/datasheet/2/813/ELM327DS-2489024.pdf)

## General OBD-II

The mode selector lists `$01` through `$0A`. Reads are on demand. For parameterized services, discovery follows the support ranges advertised by the vehicle. A known identifier can also be entered manually. The parser handles CAN and legacy reply formats, decodes common values, and displays unknown encodings as hexadecimal. Adapter headers are off, so generic replies can be listed separately without attributing them to an ECU. Successful empty results, explicit unsupported replies, and unconfirmed or invalid replies have distinct messages. [ELM327 datasheet](https://www.mouser.com/datasheet/2/813/ELM327DS-2489024.pdf) · [SAE J1979](https://www.pgmfi.org/files/sae_obdii_j1979_200204.pdf)

Show descriptions for modes that change vehicle state, including `$04` (clear emissions-related diagnostic information) and `$08` (control of an onboard system or test). Opening the section or checking support only sends read requests. The requested clear action is part of the PSA ECU workflow below. [OBD-II service modes](https://www.snapon.com/DiagnosticsManuals/Help/OBDII/Content/Common/Help%20Topics/OBD/OBDII%20Service%20Modes.htm)

**Read all supported** discovers the selected mode's advertised ranges and reads each advertised data identifier sequentially, using the selected frame or sensor where applicable. The result reports each identifier's decoded data or read failure.

An explicit save stores the result, read time, mode, identifier or batch indicator, applicable frame or sensor, and protocol in local storage. The same recording wrapper captures adapter commands and their response text before diagnostic parsing for General OBD-II readings and saved PSA ECU operations. History previews or exports those exchanges as JSON. Each reading has its own versioned key so separate tabs can save independently. The offline history plots single-value Mode `$01` readings with matching PID, protocol, and units. Saved generic readings have no automatic vehicle association.

## PSA-specific diagnostics

The offline picker includes every vehicle file and variant from the pinned PSA-RE snapshot, with alternate names and project codes. Catalog-only variants include the ECU inventory where documented. Live scan routes are bundled for four C4 Picasso profiles. The generator matches ECU model definitions to each profile's documented diagnostic socket addresses. A sibling architecture record is eligible when the vehicle explicitly lists that model, the record is unique within the architecture family, and its socket addresses match. The service worker caches the catalog and its attribution. [Pinned PSA-RE revision](https://github.com/prototux/PSA-RE/tree/67f7581e7622410efdbb29c7eda3b86982b9b450)

The scanner uses 11-bit CAN at 500 kbit/s through the diagnostic port. It sends only documented physical identification reads, checks the reply address, and reassembles ISO-TP frames with the adapter's flow control. It deduplicates matching probes. An identification reply establishes that an address responded, so the operator still chooses the ECU model before decoding. The adapter returns to the general OBD-II setup after each PSA operation. [ELM327 datasheet](https://www.mouser.com/datasheet/2/813/ELM327DS-2489024.pdf)

Selected models support documented UDS or KWP-over-CAN parameter reads. A batch uses one ECU route and sends each selected read in sequence. Fields are decoded only when the response length matches the definition. Supported UDS models list active or confirmed DTCs and show the flags reported by the ECU's status-availability mask. Supported PSA KWP models show DTCs with the raw status byte. A confirmed clear first rereads the target ECU, sends a single physically addressed request, and checks the acknowledgement and follow-up DTC list separately. An uncertain result never triggers a retry.

Browser storage retains the selected vehicle and variant and any manually saved snapshots. Disconnecting preserves visible readings and invalidates live ECU verification. A single-ECU retry uses the same read-only scanner for one catalog entry and updates the visible result. A saved scan records its original run. Coverage through the vehicle gateway is pending device validation, as are fault freeze-frame reads.

**Identify ECU** reuses the documented parameter-read path for the selected model’s ECU and supplier identifiers. A scan confirms a responding CAN address and identifies candidate profiles. The app displays identity fields reported by the ECU when the selected profile can decode them. Response details use the same field decoding as the result rows and are saved with new parameter and identification snapshots.

Scans stream one result per checked ECU to the view. Stopping takes effect at an ECU boundary and restores the generic adapter configuration. The optional fault pass reads DTCs during discovery only after a unique supported model matches. Saved reports retain completed outcomes and raw exchanges. History compares scans for the same profile and matches connector labels for older scans. Fault comparisons require a successful read from the same ECU model in both scans. The vehicle picker shows offline pinout guidance from vehicle wiring references where available and architecture references otherwise.

See the [technical decisions](DECISIONS.md) and the [acceptance criteria](PROJECT_STATUS.md).
