"use strict";
/**
 * Listen to ChirpStack join requests and identify the likely vendor of an
 * unknown device from its DevEUI's IEEE OUI (with optional JoinEUI overrides).
 *
 * Two entry points:
 * - {@link analyze} — pure function that parses a LoRaWAN PHYPayload and
 *   returns a candidate vendor. Transport-agnostic.
 * - {@link watch} — opens an MQTT connection to a ChirpStack broker, filters
 *   gateway uplink events for JoinRequests, and emits each candidate.
 *
 * @packageDocumentation
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.watch = exports.handleGatewayUplink = exports.analyze = exports.parseJoinRequest = exports.MType = exports.VendorSource = exports.parseOuiCsv = exports.updateOuis = exports.cachePath = void 0;
const events_1 = require("events");
const fs_1 = __importDefault(require("fs"));
const mqtt_1 = __importDefault(require("mqtt"));
const oui_registry_1 = require("@intelligent-farming/oui-registry");
var oui_registry_2 = require("@intelligent-farming/oui-registry");
Object.defineProperty(exports, "cachePath", { enumerable: true, get: function () { return oui_registry_2.cachePath; } });
Object.defineProperty(exports, "updateOuis", { enumerable: true, get: function () { return oui_registry_2.updateOuis; } });
Object.defineProperty(exports, "parseOuiCsv", { enumerable: true, get: function () { return oui_registry_2.parseOuiCsv; } });
/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */
/** Source of a vendor match. */
var VendorSource;
(function (VendorSource) {
    /** Matched against the user-supplied JoinEUI map. */
    VendorSource["JOIN_EUI"] = "joinEui";
    /** Matched against the IEEE OUI registry on the DevEUI's top 3 bytes. */
    VendorSource["OUI"] = "oui";
})(VendorSource || (exports.VendorSource = VendorSource = {}));
/** LoRaWAN message type from the MHDR. JoinRequest is the only one this module cares about. */
var MType;
(function (MType) {
    MType[MType["JOIN_REQUEST"] = 0] = "JOIN_REQUEST";
    MType[MType["JOIN_ACCEPT"] = 1] = "JOIN_ACCEPT";
    MType[MType["UNCONFIRMED_DATA_UP"] = 2] = "UNCONFIRMED_DATA_UP";
    MType[MType["UNCONFIRMED_DATA_DOWN"] = 3] = "UNCONFIRMED_DATA_DOWN";
    MType[MType["CONFIRMED_DATA_UP"] = 4] = "CONFIRMED_DATA_UP";
    MType[MType["CONFIRMED_DATA_DOWN"] = 5] = "CONFIRMED_DATA_DOWN";
    MType[MType["REJOIN_REQUEST"] = 6] = "REJOIN_REQUEST";
    MType[MType["PROPRIETARY"] = 7] = "PROPRIETARY";
})(MType || (exports.MType = MType = {}));
/* -------------------------------------------------------------------------- */
/* LoRaWAN PHYPayload parsing                                                  */
/* -------------------------------------------------------------------------- */
/** Coerce a `string` (hex or base64) or `Buffer` to a `Buffer`. Heuristic: hex if it matches `^[0-9a-fA-F]+$` and even length. */
const toBuffer = (input) => {
    if (Buffer.isBuffer(input))
        return input;
    return /^[0-9a-fA-F]+$/.test(input) && input.length % 2 === 0
        ? Buffer.from(input, 'hex')
        : Buffer.from(input, 'base64');
};
/**
 * Parse a raw LoRaWAN PHYPayload as a JoinRequest. Returns `null` if the
 * payload isn't a JoinRequest or is malformed.
 *
 * JoinRequest layout (23 bytes total):
 * - MHDR (1) — `MType` in the top 3 bits
 * - JoinEUI (8) — little-endian on the air
 * - DevEUI  (8) — little-endian on the air
 * - DevNonce (2) — little-endian
 * - MIC (4) — unchecked here; vendor identification doesn't need crypto
 */
const parseJoinRequest = (input) => {
    const buf = toBuffer(input);
    if (buf.length !== 23)
        return null;
    if (((buf[0] >> 5) & 0x07) !== MType.JOIN_REQUEST)
        return null;
    const joinEui = Buffer.from(buf.subarray(1, 9)).reverse().toString('hex').toUpperCase();
    const devEui = Buffer.from(buf.subarray(9, 17)).reverse().toString('hex').toUpperCase();
    const devNonce = Buffer.from(buf.subarray(17, 19)).reverse().toString('hex').toUpperCase();
    return { joinEui, devEui, oui: devEui.slice(0, 6), devNonce };
};
exports.parseJoinRequest = parseJoinRequest;
/* -------------------------------------------------------------------------- */
/* Public: analyze                                                             */
/* -------------------------------------------------------------------------- */
let _loadedMapPath;
let _loadedMap;
const resolveJoinEuiMap = (opts) => {
    if (opts.joinEuiMap)
        return opts.joinEuiMap;
    if (!opts.joinEuiMapPath)
        return undefined;
    if (opts.joinEuiMapPath !== _loadedMapPath) {
        _loadedMap = JSON.parse(fs_1.default.readFileSync(opts.joinEuiMapPath, 'utf8'));
        _loadedMapPath = opts.joinEuiMapPath;
    }
    return _loadedMap;
};
/**
 * Parse a LoRaWAN PHYPayload and identify the candidate vendor.
 *
 * @param phyPayload - Raw payload as a hex string, base64 string, or `Buffer`.
 * @param opts - {@link AnalyzeOptions}.
 * @returns A candidate object if the payload is a JoinRequest, otherwise `null`.
 *
 * @example
 * ```ts
 * const c = analyze('00010000000000000080E1F5C2F1A0D5B40000', { joinEuiMapPath: './join-euis.json' });
 * console.log(c?.vendor?.name); // e.g. "Microchip Technology Inc."
 * ```
 */
const analyze = (phyPayload, opts = {}) => {
    const req = (0, exports.parseJoinRequest)(phyPayload);
    if (!req)
        return null;
    const map = resolveJoinEuiMap(opts);
    if (map && map[req.joinEui]) {
        const v = map[req.joinEui];
        return { ...req, vendor: { id: v.id, name: v.name, source: VendorSource.JOIN_EUI } };
    }
    const orgName = lookupOui(req.devEui, opts.ouiRegistry);
    return {
        ...req,
        vendor: orgName ? { name: orgName, source: VendorSource.OUI } : null,
    };
};
exports.analyze = analyze;
/**
 * Try the longest IEEE registry first: MA-S (36-bit) → MA-M (28-bit) → MA-L
 * (24-bit). When `registry` is provided, runs against it directly; otherwise
 * loads the bundled snapshot via `fs` (Node only).
 */
const lookupOui = (devEui, registry) => {
    const map = registry ?? (0, oui_registry_1.loadBundled)();
    return map[devEui.slice(0, 9)] ?? map[devEui.slice(0, 7)] ?? map[devEui.slice(0, 6)];
};
/* -------------------------------------------------------------------------- */
/* Public: watch                                                               */
/* -------------------------------------------------------------------------- */
const GATEWAY_TOPIC_RE = /^gateway\/([^/]+)\/event\/up$/;
/**
 * Process one ChirpStack-shaped gateway uplink event (topic + JSON payload)
 * and return a {@link JoinEvent} if it carried a JoinRequest. Exported so
 * non-MQTT transports (webhooks, gRPC streams, message queues, etc.) can
 * reuse the parsing pipeline.
 *
 * Returns `null` when the topic isn't a `gateway/<id>/event/up`, the payload
 * isn't ChirpStack's gateway-up JSON, or the frame isn't a JoinRequest.
 */
const handleGatewayUplink = (topic, payload, opts = {}) => {
    const m = topic.match(GATEWAY_TOPIC_RE);
    if (!m)
        return null;
    const gatewayId = m[1];
    let raw;
    try {
        const json = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
        // ChirpStack v4 emits `phyPayload` as a base64 string in JSON gateway uplinks.
        raw = json.phyPayload ?? json.phy_payload;
    }
    catch {
        return null;
    }
    if (!raw)
        return null;
    const candidate = (0, exports.analyze)(raw, opts);
    return candidate ? { gatewayId, candidate, receivedAt: new Date() } : null;
};
exports.handleGatewayUplink = handleGatewayUplink;
/**
 * Connect to ChirpStack's MQTT broker and emit a `join` event for every
 * JoinRequest seen on a gateway uplink topic. Use this to catch devices that
 * aren't yet provisioned in ChirpStack — those joins are visible at the
 * gateway level even though the device-level integration drops them.
 *
 * @example
 * ```ts
 * const w = watch({ url: 'mqtt://localhost:1883' });
 * w.on('join', e => console.log(`new device on ${e.gatewayId}: ${e.candidate.devEui} (${e.candidate.vendor?.name ?? 'unknown'})`));
 * w.on('error', console.error);
 * // later: await w.stop();
 * ```
 */
const watch = (opts) => {
    const emitter = new events_1.EventEmitter();
    const topic = opts.topic ?? 'gateway/+/event/up';
    const client = mqtt_1.default.connect(opts.url, { username: opts.username, password: opts.password });
    client.on('connect', () => {
        client.subscribe(topic, err => {
            if (err)
                emitter.emit('error', err);
            else
                emitter.emit('connect');
        });
    });
    client.on('error', err => emitter.emit('error', err));
    client.on('close', () => emitter.emit('close'));
    client.on('message', (incomingTopic, payload) => {
        const event = (0, exports.handleGatewayUplink)(incomingTopic, payload, opts);
        if (event)
            emitter.emit('join', event);
    });
    emitter.stop =
        () => new Promise(resolve => client.end(false, {}, () => resolve()));
    return emitter;
};
exports.watch = watch;
//# sourceMappingURL=index.js.map