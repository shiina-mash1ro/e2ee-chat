import { encode } from "@msgpack/msgpack";

export const PROTOCOL_VERSION = 4;
export const BINARY_EVENT_FIELDS = [
  "public_key",
  "sign_public_key",
  "hello_mac",
  "signature",
  "nonce",
  "ciphertext",
  "roster_hash",
  "sealed_key",
];

const BINARY_FIELD_LIMITS = {
  public_key: 64,
  sign_public_key: 64,
  hello_mac: 64,
  signature: 128,
  nonce: 64,
  ciphertext: 50 * 1024 * 1024,
  roster_hash: 64,
  sealed_key: 256,
};

export function asBytes(value) {
  if (value == null) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) {
    if (!value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
      throw new TypeError("Invalid byte array");
    }
    return new Uint8Array(value);
  }
  throw new TypeError("Invalid byte value");
}

export function createProtocolV3(sodium) {
  const decodeWireBytes = (value, field = "") => {
    const bytes = typeof value === "string"
      ? sodium.from_base64(value, sodium.base64_variants.ORIGINAL)
      : asBytes(value);
    const limit = BINARY_FIELD_LIMITS[field];
    if (limit && bytes.byteLength > limit) throw new RangeError(`Invalid ${field} length`);
    return bytes;
  };

  const normalizeWireEvent = (event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("Invalid event");
    const wireProtocol = Number(event.protocol || 0);
    if (wireProtocol !== PROTOCOL_VERSION) throw new Error("Unsupported protocol");
    // The current application code uses 3 as its internal payload codec selector.
    // Keep that implementation detail local while the wire protocol is v4.
    const normalized = { ...event, protocol: 3 };
    for (const field of BINARY_EVENT_FIELDS) {
      if (normalized[field] != null && normalized[field] !== "") {
        normalized[field] = decodeWireBytes(normalized[field], field);
      }
    }
    return normalized;
  };

  const toWireEvent = (event, mode) => {
    const wire = { ...event, protocol: PROTOCOL_VERSION };
    for (const field of BINARY_EVENT_FIELDS) {
      if (wire[field] == null) continue;
      const bytes = asBytes(wire[field]);
      const limit = BINARY_FIELD_LIMITS[field];
      if (limit && bytes.byteLength > limit) throw new RangeError(`Invalid ${field} length`);
      wire[field] = mode === "sse"
        ? sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
        : bytes;
    }
    return wire;
  };

  const canonicalEventBytes = (event) => {
    const bytes = (name) => event[name] ? asBytes(event[name]) : new Uint8Array();
    return encode([
      PROTOCOL_VERSION,
      event.type || "",
      event.room || "",
      event.from || "",
      event.to || "",
      event.msg_id || "",
      event.ack_id || "",
      event.transfer_id || "",
      event.message_type || "",
      Number(event.seq || 0),
      Number(event.total || 0),
      Number(event.epoch || 0),
      Number(event.next_epoch || 0),
      event.sender_key_id || "",
      event.recipient_key_id || "",
      event.rotation_id || "",
      Number(event.key_generation || 0),
      bytes("nonce"),
      bytes("ciphertext"),
      bytes("roster_hash"),
      bytes("sealed_key"),
      bytes("public_key"),
      bytes("sign_public_key"),
      event.display_name || "",
      bytes("hello_mac"),
    ]);
  };

  const canonicalMessageAAD = (event) => encode([
    PROTOCOL_VERSION,
    event.type || "",
    event.room || "",
    event.from || "",
    event.to || "",
    event.msg_id || "",
    Number(event.epoch || 0),
    event.sender_key_id || "",
    event.recipient_key_id || "",
    event.nonce ? asBytes(event.nonce) : new Uint8Array(),
  ]);

  return {
    canonicalEventBytes,
    canonicalMessageAAD,
    decodeWireBytes,
    normalizeWireEvent,
    toWireEvent,
  };
}
