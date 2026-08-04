import { encode } from "@msgpack/msgpack";

export const PROTOCOL_VERSION = 3;
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

export function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return new Uint8Array(value);
  return new Uint8Array(value || []);
}

export function createProtocolV3(sodium) {
  const decodeWireBytes = (value) => (
    typeof value === "string"
      ? sodium.from_base64(value, sodium.base64_variants.ORIGINAL)
      : asBytes(value)
  );

  const normalizeWireEvent = (event) => {
    const normalized = { ...event, protocol: Number(event.protocol || 0) };
    for (const field of BINARY_EVENT_FIELDS) {
      if (normalized[field] != null && normalized[field] !== "") {
        normalized[field] = decodeWireBytes(normalized[field]);
      }
    }
    return normalized;
  };

  const toWireEvent = (event, mode) => {
    const wire = { ...event, protocol: PROTOCOL_VERSION };
    for (const field of BINARY_EVENT_FIELDS) {
      if (wire[field] == null) continue;
      const bytes = asBytes(wire[field]);
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
      Number(event.seq || 0),
      Number(event.total || 0),
      Number(event.epoch || 0),
      Number(event.next_epoch || 0),
      event.sender_key_id || "",
      event.recipient_key_id || "",
      event.rotation_id || "",
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
