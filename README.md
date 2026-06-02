# @intelligentfarming/chirpstack-join-watcher

Listens to ChirpStack's MQTT gateway uplinks, picks out LoRaWAN JoinRequests, and tells you what vendor each unknown device probably came from. Useful when a device shows up that isn't provisioned yet and you want to know who made it before deciding how to onboard it.

Vendor identification uses the IEEE OUI registry against the DevEUI's top bytes (MA-L 24-bit, MA-M 28-bit, and MA-S 36-bit allocations — the last one is what most LoRaWAN device makers actually use). You can also supply a `join-euis.json`-style override map keyed by JoinEUI, which wins over the OUI lookup when it matches.

Full API reference: [docs/api-doc.md](docs/api-doc.md). Regenerate with `npm run docs`.

## Install

```sh
npm install @intelligentfarming/chirpstack-join-watcher
```

Written in TypeScript, compiled to CommonJS, ships type definitions and runtime-accessible string enums (same pattern as `@intelligentfarming/ttn-to-chirpstack`).

## Usage

```ts
import {
  watch, analyze, handleGatewayUplink, updateOuis, cachePath,
  VendorSource, MType,
} from '@intelligentfarming/chirpstack-join-watcher';

// Connect to ChirpStack and listen for join requests on every gateway.
const w = watch({ url: 'mqtt://localhost:1883' });
w.on('connect', () => console.log('subscribed'));
w.on('join', e => {
  console.log(`${e.gatewayId}: ${e.candidate.devEui} — ${e.candidate.vendor?.name ?? 'unknown vendor'}`);
});
w.on('error', console.error);
// await w.stop(); when shutting down

// Or, if you receive ChirpStack events from somewhere other than MQTT
// (webhook, gRPC stream, message queue), feed them through the same pipeline:
const event = handleGatewayUplink('gateway/gw-01/event/up', mqttPayloadString);

// Or analyze a raw PHYPayload (hex, base64, or Buffer):
const candidate = analyze('00<...23 bytes of LoRaWAN JoinRequest...>');
```

### Override map (`join-euis.json`)

If you know the JoinEUI ranges your private deployment uses, pass an override map. It wins over the IEEE OUI lookup, which lets you label devices the registry doesn't know about (e.g. a private MA-S sub-block or an internal test deployment).

```json
{
  "AABBCCDDEEFF0011": { "id": "mycorp", "name": "My private deployment" },
  "70B3D57ED0000000": { "id": "thethingsindustries", "name": "The Things Industries" }
}
```

```ts
import joinEuis from './join-euis.json';

watch({ url: 'mqtt://localhost:1883', joinEuiMap: joinEuis });
// or
watch({ url: 'mqtt://localhost:1883', joinEuiMapPath: './join-euis.json' });
```

## What's actually in the payload

ChirpStack v4 publishes gateway uplinks to `gateway/<gateway-id>/event/up` as JSON. The `phyPayload` field is the raw LoRaWAN frame, base64-encoded. This module:

1. Subscribes to `gateway/+/event/up` by default (override with `topic`).
2. Decodes the base64 PHYPayload.
3. Filters for `MType == 0` (JoinRequest).
4. Reads the JoinEUI (8 bytes, little-endian on the wire) and DevEUI (8 bytes, little-endian).
5. Looks up the DevEUI's top 24/28/36-bit prefix in the IEEE OUI registry. Longest match wins, so MA-S sub-allocations override the broader MA-L registration they sit under.
6. If a `joinEuiMap` matches the JoinEUI, that takes precedence.

## OUI snapshot and updates

A snapshot of the IEEE registry ships with the package (~1.8 MB JSON, ~52,000 entries pulled from `oui.csv`, `mam.csv`, and `oui36.csv`). To refresh at runtime without re-installing:

```ts
await updateOuis();   // downloads all three IEEE files, writes the cache, takes a few seconds
```

The cache lives outside `node_modules` so this works inside long-running containers without write-permission issues. Path resolution: `$JOIN_WATCHER_CACHE` → `$XDG_CACHE_HOME/chirpstack-join-watcher` → `~/.cache/chirpstack-join-watcher`. `cachePath()` returns the resolved location.

To bake a new snapshot into the package itself (maintainer task):

```sh
npm run build-ouis    # downloads from IEEE and writes data/ouis.json
```

## Tests

```sh
npm test
```
