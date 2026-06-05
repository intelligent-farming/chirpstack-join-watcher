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

import { EventEmitter } from 'events';
import fs from 'fs';
import mqtt, { MqttClient } from 'mqtt';
import {
  loadBundled as loadOuis,
  type OuiRegistry,
} from '@intelligent-farming/oui-registry';

export { cachePath, updateOuis, parseOuiCsv } from '@intelligent-farming/oui-registry';
/** Re-export so browser callers don't have to depend on `@intelligent-farming/oui-registry` directly. */
export type { OuiRegistry };

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

/** Source of a vendor match. */
export enum VendorSource {
  /** Matched against the user-supplied JoinEUI map. */
  JOIN_EUI = 'joinEui',
  /** Matched against the IEEE OUI registry on the DevEUI's top 3 bytes. */
  OUI = 'oui',
}

/** LoRaWAN message type from the MHDR. JoinRequest is the only one this module cares about. */
export enum MType {
  JOIN_REQUEST = 0,
  JOIN_ACCEPT = 1,
  UNCONFIRMED_DATA_UP = 2,
  UNCONFIRMED_DATA_DOWN = 3,
  CONFIRMED_DATA_UP = 4,
  CONFIRMED_DATA_DOWN = 5,
  REJOIN_REQUEST = 6,
  PROPRIETARY = 7,
}

/* -------------------------------------------------------------------------- */
/* Public interfaces                                                           */
/* -------------------------------------------------------------------------- */

/** A single vendor entry in a {@link JoinEuiMap}. */
export interface VendorEntry {
  /** Vendor slug — matches the `vendor.id` from `@intelligent-farming/ttn-to-chirpstack` when known. */
  id?: string;
  /** Human-readable vendor name. */
  name: string;
}

/**
 * Caller-supplied JoinEUI → vendor map. Keys are 16-character uppercase hex
 * EUIs (no separators). When present and matched, takes precedence over
 * the OUI lookup.
 *
 * @example
 * ```json
 * {
 *   "70B3D57ED0000000": { "id": "dragino", "name": "Dragino" },
 *   "0000000000000001": { "id": "milesight", "name": "Milesight IoT" }
 * }
 * ```
 */
export type JoinEuiMap = Record<string, VendorEntry>;

/** Result of parsing a LoRaWAN JoinRequest. */
export interface JoinRequest {
  /** JoinEUI (a.k.a. AppEUI before LoRaWAN 1.1), 16-character uppercase hex, MSB first. */
  joinEui: string;
  /** DevEUI, 16-character uppercase hex, MSB first. */
  devEui: string;
  /** First 3 bytes of the DevEUI (6 hex chars, uppercase). The IEEE OUI. */
  oui: string;
  /** 4-character uppercase hex DevNonce. */
  devNonce: string;
}

/** What {@link analyze} returns when the input is a JoinRequest. */
export interface JoinCandidate extends JoinRequest {
  /** Matched vendor, or `null` if neither the JoinEUI map nor the OUI registry knows it. */
  vendor: (VendorEntry & { source: VendorSource }) | null;
}

/** Options for {@link analyze}. */
export interface AnalyzeOptions {
  /** Inline JoinEUI → vendor map. Wins over `joinEuiMapPath` and OUI matching. */
  joinEuiMap?: JoinEuiMap;
  /**
   * Path to a JSON file containing a {@link JoinEuiMap}. Read on first
   * analyze() call and cached. **Node only** — uses `fs`. In browsers, pass
   * an inline {@link joinEuiMap} instead.
   */
  joinEuiMapPath?: string;
  /**
   * IEEE OUI registry for vendor identification. When provided, the lookup
   * runs against this map directly — browser-safe. When omitted, falls back
   * to the bundled snapshot via `fs` from `@intelligent-farming/oui-registry`
   * (Node only).
   *
   * Browser usage:
   * ```ts
   * import ouis from '@intelligent-farming/oui-registry/data/ouis.json';
   * watch({ url, ouiRegistry: ouis });
   * ```
   */
  ouiRegistry?: OuiRegistry;
}

/** Options for {@link watch}. Extends {@link AnalyzeOptions}. */
export interface WatchOptions extends AnalyzeOptions {
  /** ChirpStack MQTT broker URL, e.g. `mqtt://localhost:1883`. */
  url: string;
  /** Optional MQTT username. */
  username?: string;
  /** Optional MQTT password. */
  password?: string;
  /**
   * MQTT topic to subscribe to. Defaults to `gateway/+/event/up` (ChirpStack v4 default).
   * Use `+/gateway/+/event/up` if your broker is configured with a region prefix.
   */
  topic?: string;
}

/** Event emitted by {@link watch} for each JoinRequest seen on the wire. */
export interface JoinEvent {
  /** Gateway ID extracted from the MQTT topic. */
  gatewayId: string;
  /** The parsed candidate. */
  candidate: JoinCandidate;
  /** Wall-clock time the event was processed. */
  receivedAt: Date;
}

/**
 * Typed event emitter returned by {@link watch}. The runtime instance is a
 * Node `EventEmitter`, but only the events listed here are part of the
 * public contract.
 */
export interface JoinWatcher {
  on(event: 'join', listener: (e: JoinEvent) => void): JoinWatcher;
  on(event: 'error', listener: (err: Error) => void): JoinWatcher;
  on(event: 'connect', listener: () => void): JoinWatcher;
  on(event: 'close', listener: () => void): JoinWatcher;
  /** Disconnect from the broker. Resolves when the underlying client is closed. */
  stop(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* LoRaWAN PHYPayload parsing                                                  */
/* -------------------------------------------------------------------------- */

/** Coerce a `string` (hex or base64) or `Buffer` to a `Buffer`. Heuristic: hex if it matches `^[0-9a-fA-F]+$` and even length. */
const toBuffer = (input: string | Buffer): Buffer => {
  if (Buffer.isBuffer(input)) return input;
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
export const parseJoinRequest = (input: string | Buffer): JoinRequest | null => {
  const buf = toBuffer(input);
  if (buf.length !== 23) return null;
  if (((buf[0] >> 5) & 0x07) !== MType.JOIN_REQUEST) return null;
  const joinEui = Buffer.from(buf.subarray(1, 9)).reverse().toString('hex').toUpperCase();
  const devEui  = Buffer.from(buf.subarray(9, 17)).reverse().toString('hex').toUpperCase();
  const devNonce = Buffer.from(buf.subarray(17, 19)).reverse().toString('hex').toUpperCase();
  return { joinEui, devEui, oui: devEui.slice(0, 6), devNonce };
};

/* -------------------------------------------------------------------------- */
/* Public: analyze                                                             */
/* -------------------------------------------------------------------------- */

let _loadedMapPath: string | undefined;
let _loadedMap: JoinEuiMap | undefined;

const resolveJoinEuiMap = (opts: AnalyzeOptions): JoinEuiMap | undefined => {
  if (opts.joinEuiMap) return opts.joinEuiMap;
  if (!opts.joinEuiMapPath) return undefined;
  if (opts.joinEuiMapPath !== _loadedMapPath) {
    _loadedMap = JSON.parse(fs.readFileSync(opts.joinEuiMapPath, 'utf8'));
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
export const analyze = (phyPayload: string | Buffer, opts: AnalyzeOptions = {}): JoinCandidate | null => {
  const req = parseJoinRequest(phyPayload);
  if (!req) return null;
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

/**
 * Try the longest IEEE registry first: MA-S (36-bit) → MA-M (28-bit) → MA-L
 * (24-bit). When `registry` is provided, runs against it directly; otherwise
 * loads the bundled snapshot via `fs` (Node only).
 */
const lookupOui = (devEui: string, registry?: OuiRegistry): string | undefined => {
  const map = registry ?? loadOuis();
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
export const handleGatewayUplink = (
  topic: string,
  payload: Buffer | string,
  opts: AnalyzeOptions = {},
): JoinEvent | null => {
  const m = topic.match(GATEWAY_TOPIC_RE);
  if (!m) return null;
  const gatewayId = m[1];
  let raw: string | undefined;
  try {
    const json = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
    // ChirpStack v4 emits `phyPayload` as a base64 string in JSON gateway uplinks.
    raw = json.phyPayload ?? json.phy_payload;
  } catch { return null; }
  if (!raw) return null;
  const candidate = analyze(raw, opts);
  return candidate ? { gatewayId, candidate, receivedAt: new Date() } : null;
};

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
export const watch = (opts: WatchOptions): JoinWatcher => {
  const emitter = new EventEmitter();
  const topic = opts.topic ?? 'gateway/+/event/up';
  const client: MqttClient = mqtt.connect(opts.url, { username: opts.username, password: opts.password });

  client.on('connect', () => {
    client.subscribe(topic, err => {
      if (err) emitter.emit('error', err);
      else emitter.emit('connect');
    });
  });

  client.on('error', err => emitter.emit('error', err));
  client.on('close', () => emitter.emit('close'));

  client.on('message', (incomingTopic, payload) => {
    const event = handleGatewayUplink(incomingTopic, payload, opts);
    if (event) emitter.emit('join', event);
  });

  (emitter as EventEmitter & { stop: () => Promise<void> }).stop =
    () => new Promise<void>(resolve => client.end(false, {}, () => resolve()));
  return emitter as unknown as JoinWatcher;
};
