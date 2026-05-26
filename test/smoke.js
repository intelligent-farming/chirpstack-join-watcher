const assert = require('assert');
const {
  analyze, parseJoinRequest, handleGatewayUplink, watch, updateOuis, cachePath,
  MType, VendorSource,
} = require('..');

// Enums are real runtime objects.
assert.strictEqual(MType.JOIN_REQUEST, 0);
assert.strictEqual(VendorSource.OUI, 'oui');

// Hand-built JoinRequest. DevEUI prefix A84041 is Dragino's IEEE MA-L block.
// EUIs are little-endian on the wire; parseJoinRequest reverses them.
const build = (joinHex, devHex) => Buffer.concat([
  Buffer.from([0x00]),                                       // MHDR — JoinRequest
  Buffer.from(joinHex, 'hex').reverse(),                     // JoinEUI
  Buffer.from(devHex, 'hex').reverse(),                      // DevEUI
  Buffer.from([0x34, 0x12]),                                 // DevNonce
  Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]),                     // MIC (unchecked)
]);

const phy = build('1122334455667788', 'A8404100FF00FF00');
assert.strictEqual(phy.length, 23);

const req = parseJoinRequest(phy);
assert.ok(req);
assert.strictEqual(req.joinEui, '1122334455667788');
assert.strictEqual(req.devEui,  'A8404100FF00FF00');
assert.strictEqual(req.oui,     'A84041');
assert.strictEqual(req.devNonce, '1234');

// analyze() with an inline JoinEUI map — should win over OUI lookup.
const withMap = analyze(phy, {
  joinEuiMap: { '1122334455667788': { id: 'dragino', name: 'Dragino' } },
});
assert.ok(withMap);
assert.deepStrictEqual(withMap.vendor, { id: 'dragino', name: 'Dragino', source: VendorSource.JOIN_EUI });

// OUI fallback resolves a known IEEE-assigned block (A84041 = Dragino).
const ouiResolved = analyze(phy);
assert.ok(ouiResolved);
assert.ok(ouiResolved.vendor);
assert.strictEqual(ouiResolved.vendor.source, VendorSource.OUI);
assert.match(ouiResolved.vendor.name, /Dragino/);

// A locally-administered DevEUI (bit 1 set in the first byte: 0x02) is
// reserved by IEEE and never appears in the OUI registry.
const unknownPhy = build('1122334455667788', '0200000000ABCDEF');
const unknown = analyze(unknownPhy);
assert.ok(unknown);
assert.strictEqual(unknown.vendor, null);

// Hex string input works too.
assert.deepStrictEqual(parseJoinRequest(phy.toString('hex')), req);

// Base64 input works too (matches what ChirpStack publishes in MQTT JSON).
assert.deepStrictEqual(parseJoinRequest(phy.toString('base64')), req);

// Non-JoinRequest MType (Unconfirmed Data Up = 010) → null.
const dataUp = Buffer.concat([Buffer.from([0x40]), Buffer.alloc(22)]);
assert.strictEqual(parseJoinRequest(dataUp), null);

// Wrong length → null.
assert.strictEqual(parseJoinRequest(Buffer.alloc(10)), null);

// ChirpStack-shaped gateway uplink → JoinEvent end-to-end (no MQTT broker needed).
const csTopic = 'gateway/gw-test-01/event/up';
const csPayload = JSON.stringify({ phyPayload: phy.toString('base64') });
const event = handleGatewayUplink(csTopic, csPayload);
assert.ok(event);
assert.strictEqual(event.gatewayId, 'gw-test-01');
assert.strictEqual(event.candidate.devEui, 'A8404100FF00FF00');
assert.match(event.candidate.vendor.name, /Dragino/);
assert.ok(event.receivedAt instanceof Date);

// Non-gateway topic → null (e.g. application-level events get ignored).
assert.strictEqual(handleGatewayUplink('application/1/device/x/event/up', csPayload), null);

// Malformed JSON → null, no throw.
assert.strictEqual(handleGatewayUplink(csTopic, 'not json'), null);

// Gateway topic carrying a non-JoinRequest frame → null.
const dataUpPayload = JSON.stringify({ phyPayload: Buffer.concat([Buffer.from([0x40]), Buffer.alloc(22)]).toString('base64') });
assert.strictEqual(handleGatewayUplink(csTopic, dataUpPayload), null);

// Public API surface.
assert.strictEqual(typeof watch, 'function');
assert.strictEqual(typeof updateOuis, 'function');
assert.strictEqual(typeof cachePath(), 'string');

console.log('ok');
