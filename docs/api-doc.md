# @intelligentfarming/chirpstack-join-watcher

Listen to ChirpStack join requests and identify the likely vendor of an
unknown device from its DevEUI's IEEE OUI (with optional JoinEUI overrides).

Two entry points:
- [analyze](#analyze) — pure function that parses a LoRaWAN PHYPayload and
  returns a candidate vendor. Transport-agnostic.
- [watch](#watch) — opens an MQTT connection to a ChirpStack broker, filters
  gateway uplink events for JoinRequests, and emits each candidate.

## Enumerations

### MType

LoRaWAN message type from the MHDR. JoinRequest is the only one this module cares about.

#### Enumeration Members

##### CONFIRMED\_DATA\_DOWN

> **CONFIRMED\_DATA\_DOWN**: `5`

##### CONFIRMED\_DATA\_UP

> **CONFIRMED\_DATA\_UP**: `4`

##### JOIN\_ACCEPT

> **JOIN\_ACCEPT**: `1`

##### JOIN\_REQUEST

> **JOIN\_REQUEST**: `0`

##### PROPRIETARY

> **PROPRIETARY**: `7`

##### REJOIN\_REQUEST

> **REJOIN\_REQUEST**: `6`

##### UNCONFIRMED\_DATA\_DOWN

> **UNCONFIRMED\_DATA\_DOWN**: `3`

##### UNCONFIRMED\_DATA\_UP

> **UNCONFIRMED\_DATA\_UP**: `2`

***

### VendorSource

Source of a vendor match.

#### Enumeration Members

##### JOIN\_EUI

> **JOIN\_EUI**: `"joinEui"`

Matched against the user-supplied JoinEUI map.

##### OUI

> **OUI**: `"oui"`

Matched against the IEEE OUI registry on the DevEUI's top 3 bytes.

## Interfaces

### AnalyzeOptions

Options for [analyze](#analyze).

#### Extended by

- [`WatchOptions`](#watchoptions)

#### Properties

##### joinEuiMap?

> `optional` **joinEuiMap?**: [`JoinEuiMap`](#joineuimap-2)

Inline JoinEUI → vendor map. Wins over `joinEuiMapPath` and OUI matching.

##### joinEuiMapPath?

> `optional` **joinEuiMapPath?**: `string`

Path to a JSON file containing a [JoinEuiMap](#joineuimap-2). Read on first analyze() call and cached.

***

### JoinCandidate

What [analyze](#analyze) returns when the input is a JoinRequest.

#### Extends

- [`JoinRequest`](#joinrequest)

#### Properties

##### devEui

> **devEui**: `string`

DevEUI, 16-character uppercase hex, MSB first.

###### Inherited from

[`JoinRequest`](#joinrequest).[`devEui`](#deveui-1)

##### devNonce

> **devNonce**: `string`

4-character uppercase hex DevNonce.

###### Inherited from

[`JoinRequest`](#joinrequest).[`devNonce`](#devnonce-1)

##### joinEui

> **joinEui**: `string`

JoinEUI (a.k.a. AppEUI before LoRaWAN 1.1), 16-character uppercase hex, MSB first.

###### Inherited from

[`JoinRequest`](#joinrequest).[`joinEui`](#joineui-1)

##### oui

> **oui**: `string`

First 3 bytes of the DevEUI (6 hex chars, uppercase). The IEEE OUI.

###### Inherited from

[`JoinRequest`](#joinrequest).[`oui`](#oui-2)

##### vendor

> **vendor**: [`VendorEntry`](#vendorentry) & `object` \| `null`

Matched vendor, or `null` if neither the JoinEUI map nor the OUI registry knows it.

***

### JoinEvent

Event emitted by [watch](#watch) for each JoinRequest seen on the wire.

#### Properties

##### candidate

> **candidate**: [`JoinCandidate`](#joincandidate)

The parsed candidate.

##### gatewayId

> **gatewayId**: `string`

Gateway ID extracted from the MQTT topic.

##### receivedAt

> **receivedAt**: `Date`

Wall-clock time the event was processed.

***

### JoinRequest

Result of parsing a LoRaWAN JoinRequest.

#### Extended by

- [`JoinCandidate`](#joincandidate)

#### Properties

##### devEui

> **devEui**: `string`

DevEUI, 16-character uppercase hex, MSB first.

##### devNonce

> **devNonce**: `string`

4-character uppercase hex DevNonce.

##### joinEui

> **joinEui**: `string`

JoinEUI (a.k.a. AppEUI before LoRaWAN 1.1), 16-character uppercase hex, MSB first.

##### oui

> **oui**: `string`

First 3 bytes of the DevEUI (6 hex chars, uppercase). The IEEE OUI.

***

### JoinWatcher

Typed event emitter returned by [watch](#watch). The runtime instance is a
Node `EventEmitter`, but only the events listed here are part of the
public contract.

#### Methods

##### on()

###### Call Signature

> **on**(`event`, `listener`): [`JoinWatcher`](#joinwatcher)

###### Parameters

###### event

`"join"`

###### listener

(`e`) => `void`

###### Returns

[`JoinWatcher`](#joinwatcher)

###### Call Signature

> **on**(`event`, `listener`): [`JoinWatcher`](#joinwatcher)

###### Parameters

###### event

`"error"`

###### listener

(`err`) => `void`

###### Returns

[`JoinWatcher`](#joinwatcher)

###### Call Signature

> **on**(`event`, `listener`): [`JoinWatcher`](#joinwatcher)

###### Parameters

###### event

`"connect"`

###### listener

() => `void`

###### Returns

[`JoinWatcher`](#joinwatcher)

###### Call Signature

> **on**(`event`, `listener`): [`JoinWatcher`](#joinwatcher)

###### Parameters

###### event

`"close"`

###### listener

() => `void`

###### Returns

[`JoinWatcher`](#joinwatcher)

##### stop()

> **stop**(): `Promise`\<`void`\>

Disconnect from the broker. Resolves when the underlying client is closed.

###### Returns

`Promise`\<`void`\>

***

### VendorEntry

A single vendor entry in a [JoinEuiMap](#joineuimap-2).

#### Properties

##### id?

> `optional` **id?**: `string`

Vendor slug — matches the `vendor.id` from `@intelligentfarming/ttn-to-chirpstack` when known.

##### name

> **name**: `string`

Human-readable vendor name.

***

### WatchOptions

Options for [watch](#watch). Extends [AnalyzeOptions](#analyzeoptions).

#### Extends

- [`AnalyzeOptions`](#analyzeoptions)

#### Properties

##### joinEuiMap?

> `optional` **joinEuiMap?**: [`JoinEuiMap`](#joineuimap-2)

Inline JoinEUI → vendor map. Wins over `joinEuiMapPath` and OUI matching.

###### Inherited from

[`AnalyzeOptions`](#analyzeoptions).[`joinEuiMap`](#joineuimap)

##### joinEuiMapPath?

> `optional` **joinEuiMapPath?**: `string`

Path to a JSON file containing a [JoinEuiMap](#joineuimap-2). Read on first analyze() call and cached.

###### Inherited from

[`AnalyzeOptions`](#analyzeoptions).[`joinEuiMapPath`](#joineuimappath)

##### password?

> `optional` **password?**: `string`

Optional MQTT password.

##### topic?

> `optional` **topic?**: `string`

MQTT topic to subscribe to. Defaults to `gateway/+/event/up` (ChirpStack v4 default).
Use `+/gateway/+/event/up` if your broker is configured with a region prefix.

##### url

> **url**: `string`

ChirpStack MQTT broker URL, e.g. `mqtt://localhost:1883`.

##### username?

> `optional` **username?**: `string`

Optional MQTT username.

## Type Aliases

### JoinEuiMap

> **JoinEuiMap** = `Record`\<`string`, [`VendorEntry`](#vendorentry)\>

Caller-supplied JoinEUI → vendor map. Keys are 16-character uppercase hex
EUIs (no separators). When present and matched, takes precedence over
the OUI lookup.

#### Example

```json
{
  "70B3D57ED0000000": { "id": "dragino", "name": "Dragino" },
  "0000000000000001": { "id": "milesight", "name": "Milesight IoT" }
}
```

## Functions

### analyze()

> **analyze**(`phyPayload`, `opts?`): [`JoinCandidate`](#joincandidate) \| `null`

Parse a LoRaWAN PHYPayload and identify the candidate vendor.

#### Parameters

##### phyPayload

`string` \| `Buffer`\<`ArrayBufferLike`\>

Raw payload as a hex string, base64 string, or `Buffer`.

##### opts?

[`AnalyzeOptions`](#analyzeoptions) = `{}`

[AnalyzeOptions](#analyzeoptions).

#### Returns

[`JoinCandidate`](#joincandidate) \| `null`

A candidate object if the payload is a JoinRequest, otherwise `null`.

#### Example

```ts
const c = analyze('00010000000000000080E1F5C2F1A0D5B40000', { joinEuiMapPath: './join-euis.json' });
console.log(c?.vendor?.name); // e.g. "Microchip Technology Inc."
```

***

### cachePath()

> **cachePath**(): `string`

Where [updateOuis](#updateouis) writes the refreshed registry.

#### Returns

`string`

***

### handleGatewayUplink()

> **handleGatewayUplink**(`topic`, `payload`, `opts?`): [`JoinEvent`](#joinevent) \| `null`

Process one ChirpStack-shaped gateway uplink event (topic + JSON payload)
and return a [JoinEvent](#joinevent) if it carried a JoinRequest. Exported so
non-MQTT transports (webhooks, gRPC streams, message queues, etc.) can
reuse the parsing pipeline.

Returns `null` when the topic isn't a `gateway/<id>/event/up`, the payload
isn't ChirpStack's gateway-up JSON, or the frame isn't a JoinRequest.

#### Parameters

##### topic

`string`

##### payload

`string` \| `Buffer`\<`ArrayBufferLike`\>

##### opts?

[`AnalyzeOptions`](#analyzeoptions) = `{}`

#### Returns

[`JoinEvent`](#joinevent) \| `null`

***

### parseJoinRequest()

> **parseJoinRequest**(`input`): [`JoinRequest`](#joinrequest) \| `null`

Parse a raw LoRaWAN PHYPayload as a JoinRequest. Returns `null` if the
payload isn't a JoinRequest or is malformed.

JoinRequest layout (23 bytes total):
- MHDR (1) — `MType` in the top 3 bits
- JoinEUI (8) — little-endian on the air
- DevEUI  (8) — little-endian on the air
- DevNonce (2) — little-endian
- MIC (4) — unchecked here; vendor identification doesn't need crypto

#### Parameters

##### input

`string` \| `Buffer`\<`ArrayBufferLike`\>

#### Returns

[`JoinRequest`](#joinrequest) \| `null`

***

### updateOuis()

> **updateOuis**(): `Promise`\<`string`\>

Download the latest IEEE OUI CSV, convert it to the compact JSON shape this
module uses (`{ "AABBCC": "Organization name" }`), and write it to the
cache. Subsequent [analyze](#analyze) calls pick up the new data immediately.

#### Returns

`Promise`\<`string`\>

The path that was written.

***

### watch()

> **watch**(`opts`): [`JoinWatcher`](#joinwatcher)

Connect to ChirpStack's MQTT broker and emit a `join` event for every
JoinRequest seen on a gateway uplink topic. Use this to catch devices that
aren't yet provisioned in ChirpStack — those joins are visible at the
gateway level even though the device-level integration drops them.

#### Parameters

##### opts

[`WatchOptions`](#watchoptions)

#### Returns

[`JoinWatcher`](#joinwatcher)

#### Example

```ts
const w = watch({ url: 'mqtt://localhost:1883' });
w.on('join', e => console.log(`new device on ${e.gatewayId}: ${e.candidate.devEui} (${e.candidate.vendor?.name ?? 'unknown'})`));
w.on('error', console.error);
// later: await w.stop();
```
