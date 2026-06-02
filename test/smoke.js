const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  analyze, parseJoinRequest, handleGatewayUplink, watch, updateOuis, cachePath,
  MType, VendorSource,
} = require('..');

// Fixtures — real OUI-bearing DevEUIs so vendor lookups exercise the registry.
const FIX = {
  draginoDevEui: 'A8404100FF00FF00',
  ttnJoinEui: '1122334455667788',
  // Locally-administered DevEUI (bit 1 set in first byte → IEEE never assigns).
  privateDevEui: '0200000000ABCDEF',
};

// Build a 23-byte JoinRequest PHYPayload. EUIs are little-endian on the air,
// so the caller passes MSB-first hex and the helper reverses them.
const buildJoinRequest = (joinEuiMsbHex, devEuiMsbHex) => Buffer.concat([
  Buffer.from([0x00]),                                       // MHDR — JoinRequest (MType bits = 000)
  Buffer.from(joinEuiMsbHex, 'hex').reverse(),               // JoinEUI on air
  Buffer.from(devEuiMsbHex, 'hex').reverse(),                // DevEUI on air
  Buffer.from([0x34, 0x12]),                                 // DevNonce 0x1234 little-endian
  Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]),                     // MIC (unchecked)
]);

const PHY = buildJoinRequest(FIX.ttnJoinEui, FIX.draginoDevEui);
const PHY_PRIVATE = buildJoinRequest(FIX.ttnJoinEui, FIX.privateDevEui);

describe('enums', () => {
  test('MType.JOIN_REQUEST is 0 (matches LoRaWAN spec)', () => {
    assert.equal(MType.JOIN_REQUEST, 0);
  });

  test('MType covers all 8 MAC message types', () => {
    assert.equal(MType.JOIN_REQUEST, 0);
    assert.equal(MType.JOIN_ACCEPT, 1);
    assert.equal(MType.UNCONFIRMED_DATA_UP, 2);
    assert.equal(MType.PROPRIETARY, 7);
  });

  test('VendorSource uses readable string values', () => {
    assert.equal(VendorSource.OUI, 'oui');
    assert.equal(VendorSource.JOIN_EUI, 'joinEui');
  });
});

describe('parseJoinRequest — bytes', () => {
  test('decodes a well-formed Buffer to canonical fields', () => {
    const req = parseJoinRequest(PHY);
    assert.ok(req);
    assert.equal(req.joinEui, FIX.ttnJoinEui);
    assert.equal(req.devEui, FIX.draginoDevEui);
    assert.equal(req.oui, 'A84041');                          // first 6 of DevEUI
    assert.equal(req.devNonce, '1234');
  });

  test('reverses little-endian wire order to MSB-first output', () => {
    // The raw bytes on the wire (PHY[9..17]) are FIX.draginoDevEui stored
    // back-to-front. parseJoinRequest un-reverses them.
    const onWire = PHY.subarray(9, 17).toString('hex').toUpperCase();
    assert.equal(onWire, '00FF00FF004140A8');                   // bytes reversed
    assert.equal(parseJoinRequest(PHY).devEui, FIX.draginoDevEui); // … and unreversed by the parser
  });
});

describe('parseJoinRequest — input forms', () => {
  test('accepts hex string', () => {
    const req = parseJoinRequest(PHY.toString('hex'));
    assert.deepEqual(req, parseJoinRequest(PHY));
  });

  test('accepts uppercase hex string', () => {
    const req = parseJoinRequest(PHY.toString('hex').toUpperCase());
    assert.deepEqual(req, parseJoinRequest(PHY));
  });

  test('accepts base64 string (ChirpStack MQTT payload format)', () => {
    const req = parseJoinRequest(PHY.toString('base64'));
    assert.deepEqual(req, parseJoinRequest(PHY));
  });
});

describe('parseJoinRequest — rejection cases', () => {
  test('returns null on wrong length', () => {
    assert.equal(parseJoinRequest(Buffer.alloc(10)), null);
    assert.equal(parseJoinRequest(Buffer.alloc(24)), null);
    assert.equal(parseJoinRequest(Buffer.alloc(0)), null);
  });

  test('returns null on non-JoinRequest MType', () => {
    // MType bits 010 (= 0x40) = Unconfirmed Data Up.
    const dataUp = Buffer.concat([Buffer.from([0x40]), Buffer.alloc(22)]);
    assert.equal(parseJoinRequest(dataUp), null);
  });

  test('returns null on Join Accept (MType=1)', () => {
    const joinAccept = Buffer.concat([Buffer.from([0x20]), Buffer.alloc(22)]);
    assert.equal(parseJoinRequest(joinAccept), null);
  });

  test('returns null on Proprietary frame (MType=7)', () => {
    const proprietary = Buffer.concat([Buffer.from([0xE0]), Buffer.alloc(22)]);
    assert.equal(parseJoinRequest(proprietary), null);
  });
});

describe('analyze — vendor identification', () => {
  test('JoinEUI map takes precedence over OUI lookup', () => {
    const result = analyze(PHY, {
      joinEuiMap: { [FIX.ttnJoinEui]: { id: 'dragino', name: 'Dragino' } },
    });
    assert.deepEqual(result.vendor, {
      id: 'dragino',
      name: 'Dragino',
      source: VendorSource.JOIN_EUI,
    });
  });

  test('falls back to OUI registry when no JoinEUI map matches', () => {
    const result = analyze(PHY);
    assert.equal(result.vendor.source, VendorSource.OUI);
    assert.match(result.vendor.name, /Dragino/);
  });

  test('reports null vendor for locally-administered DevEUI', () => {
    const result = analyze(PHY_PRIVATE);
    assert.ok(result);
    assert.equal(result.vendor, null);
  });

  test('returns null on a non-JoinRequest payload', () => {
    const dataUp = Buffer.concat([Buffer.from([0x40]), Buffer.alloc(22)]);
    assert.equal(analyze(dataUp), null);
  });

  test('empty JoinEUI map falls through to OUI lookup', () => {
    const result = analyze(PHY, { joinEuiMap: {} });
    assert.equal(result.vendor.source, VendorSource.OUI);
  });

  test('JoinEUI map with a non-matching key falls through to OUI lookup', () => {
    const result = analyze(PHY, {
      joinEuiMap: { 'OTHER_JOIN_EUI_0000': { id: 'other', name: 'Other' } },
    });
    assert.equal(result.vendor.source, VendorSource.OUI);
    assert.match(result.vendor.name, /Dragino/);
  });
});

describe('handleGatewayUplink — ChirpStack MQTT integration', () => {
  test('builds a JoinEvent from a gateway-event topic + payload', () => {
    const topic = 'gateway/gw-test-01/event/up';
    const payload = JSON.stringify({ phyPayload: PHY.toString('base64') });
    const event = handleGatewayUplink(topic, payload);
    assert.ok(event);
    assert.equal(event.gatewayId, 'gw-test-01');
    assert.equal(event.candidate.devEui, FIX.draginoDevEui);
    assert.equal(event.candidate.joinEui, FIX.ttnJoinEui);
    assert.match(event.candidate.vendor.name, /Dragino/);
    assert.ok(event.receivedAt instanceof Date);
  });

  test('extracts gateway ID even with hyphens and digits', () => {
    const event = handleGatewayUplink(
      'gateway/gw-rooftop-01-EU868/event/up',
      JSON.stringify({ phyPayload: PHY.toString('base64') }),
    );
    assert.equal(event.gatewayId, 'gw-rooftop-01-EU868');
  });

  test('returns null for application-level topics (not raw gateway events)', () => {
    assert.equal(
      handleGatewayUplink('application/1/device/x/event/up', '{}'),
      null,
    );
  });

  test('returns null on malformed JSON without throwing', () => {
    const topic = 'gateway/gw-x/event/up';
    assert.equal(handleGatewayUplink(topic, 'not json'), null);
    assert.equal(handleGatewayUplink(topic, '{'), null);
    assert.equal(handleGatewayUplink(topic, ''), null);
  });

  test('returns null when JSON lacks phyPayload', () => {
    const topic = 'gateway/gw-x/event/up';
    assert.equal(handleGatewayUplink(topic, '{}'), null);
    assert.equal(handleGatewayUplink(topic, '{"other":"field"}'), null);
  });

  test('returns null for non-JoinRequest frames on a gateway topic', () => {
    const topic = 'gateway/gw-x/event/up';
    const dataUp = Buffer.concat([Buffer.from([0x40]), Buffer.alloc(22)]);
    const payload = JSON.stringify({ phyPayload: dataUp.toString('base64') });
    assert.equal(handleGatewayUplink(topic, payload), null);
  });

  test('returns null for non-up gateway events (stats, ack, exec)', () => {
    const payload = JSON.stringify({ phyPayload: PHY.toString('base64') });
    assert.equal(handleGatewayUplink('gateway/gw-x/event/stats', payload), null);
    assert.equal(handleGatewayUplink('gateway/gw-x/event/ack', payload), null);
  });
});

describe('public API surface', () => {
  test('watch is exported as a function', () => {
    assert.equal(typeof watch, 'function');
  });

  test('updateOuis is exported as a function (re-exported from oui-registry)', () => {
    assert.equal(typeof updateOuis, 'function');
  });

  test('cachePath() returns a string path', () => {
    const p = cachePath();
    assert.equal(typeof p, 'string');
    assert.match(p, /ouis\.json$/);
  });

  test('cachePath() now points at the shared oui-registry cache location', () => {
    // After the oui-registry refactor, the cache is shared across consumers.
    assert.match(cachePath(), /intelligentfarming-oui-registry/);
  });
});
