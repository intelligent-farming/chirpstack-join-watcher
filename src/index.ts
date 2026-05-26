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
import os from 'os';
import path from 'path';
import https from 'https';
import mqtt, { MqttClient } from 'mqtt';

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
  /** Path to a JSON file containing a {@link JoinEuiMap}. Read on first analyze() call and cached. */
  joinEuiMapPath?: string;
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
/* OUI cache resolution (XDG, env-overridable; same shape as ttn-to-chirpstack) */
/* -------------------------------------------------------------------------- */

const BUNDLED_OUIS = path.join(__dirname, '..', 'data', 'ouis.json');
const CACHE_ROOT = process.env.JOIN_WATCHER_CACHE
  || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'chirpstack-join-watcher');
const CACHED_OUIS = path.join(CACHE_ROOT, 'ouis.json');
const OUI_CSV_URLS = [
  'https://standards-oui.ieee.org/oui/oui.csv',     // MA-L (24-bit) — ~40k entries
  'https://standards-oui.ieee.org/oui28/mam.csv',   // MA-M (28-bit) — narrower allocations
  'https://standards-oui.ieee.org/oui36/oui36.csv', // MA-S (36-bit) — what LoRa Alliance vendors use
];

let _ouis: Record<string, string> | undefined;

const loadOuis = (): Record<string, string> => {
  if (_ouis) return _ouis;
  const file = fs.existsSync(CACHED_OUIS) ? CACHED_OUIS : BUNDLED_OUIS;
  _ouis = JSON.parse(fs.readFileSync(file, 'utf8'));
  return _ouis!;
};

/** Where {@link updateOuis} writes the refreshed registry. */
export const cachePath = (): string => CACHED_OUIS;

/**
 * Download the latest IEEE OUI CSV, convert it to the compact JSON shape this
 * module uses (`{ "AABBCC": "Organization name" }`), and write it to the
 * cache. Subsequent {@link analyze} calls pick up the new data immediately.
 *
 * @returns The path that was written.
 */
export const updateOuis = async (): Promise<string> => {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  const merged: Record<string, string> = {};
  for (const url of OUI_CSV_URLS) Object.assign(merged, parseOuiCsv(await fetchText(url)));
  fs.writeFileSync(CACHED_OUIS, JSON.stringify(merged));
  _ouis = merged;
  return CACHED_OUIS;
};

const fetchText = (url: string): Promise<string> => new Promise((resolve, reject) => {
  https.get(url, res => {
    if (res.statusCode !== 200) return reject(new Error(`${url} → HTTP ${res.statusCode}`));
    const chunks: Buffer[] = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  }).on('error', reject);
});

/**
 * Parse the IEEE oui.csv into a flat `{ OUI: organization }` map. Exported
 * because the build-time `scripts/build-ouis.js` uses it; not normally
 * needed at runtime.
 *
 * @internal
 */
export const parseOuiCsv = (csv: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const lines = csv.split(/\r?\n/);
  // Header: Registry,Assignment,Organization Name,Organization Address
  // MA-L assignments are 6 hex chars (24-bit), MA-M are 7 (28-bit), MA-S are 9 (36-bit).
  // Keep all three so the longest-match lookup can find sub-allocated vendors —
  // critical for LoRaWAN, where most devices use 36-bit blocks under
  // LoRa Alliance's MA-S range at 70-B3-D5.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const fields = splitCsv(line);
    if (fields.length < 3) continue;
    const assignment = fields[1].trim().toUpperCase();
    const name = fields[2].trim();
    if ((assignment.length === 6 || assignment.length === 7 || assignment.length === 9) && name) {
      out[assignment] = name;
    }
  }
  return out;
};

const splitCsv = (line: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"' && inQuotes) { cur += '"'; i++; }
    else if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};

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
  const orgName = lookupOui(req.devEui);
  return {
    ...req,
    vendor: orgName ? { name: orgName, source: VendorSource.OUI } : null,
  };
};

/** Try the longest IEEE registry first: MA-S (36-bit) → MA-M (28-bit) → MA-L (24-bit). */
const lookupOui = (devEui: string): string | undefined => {
  const map = loadOuis();
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
