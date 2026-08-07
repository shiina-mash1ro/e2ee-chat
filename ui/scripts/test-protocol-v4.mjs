import assert from "node:assert/strict";
import { asBytes, createProtocolV4, PROTOCOL_VERSION } from "../src/protocol-v4.js";
import { MESSAGE_RETENTION_MS, partitionRetainedMessages } from "../src/message-retention.js";
import { authenticatedEventReplayKey, signingIdentityForEvent } from "../src/authenticated-events.js";

const fakeSodium = {
  base64_variants: { ORIGINAL: 1 },
  from_base64(value) { return Uint8Array.from(Buffer.from(value, "base64")); },
  to_base64(value) { return Buffer.from(value).toString("base64"); },
};

assert.equal(PROTOCOL_VERSION, 4);
assert.deepEqual([...asBytes([0, 1, 255])], [0, 1, 255]);
assert.throws(() => asBytes(1024), /Invalid byte value/);
assert.throws(() => asBytes([256]), /Invalid byte array/);

const protocol = createProtocolV4(fakeSodium);
assert.throws(() => protocol.normalizeWireEvent({ type: "hello", protocol: 3 }), /Unsupported protocol/);
const normalized = protocol.normalizeWireEvent({ type: "hello", protocol: 4, signature: Buffer.alloc(64).toString("base64") });
assert.equal(normalized.protocol, 4);
assert.equal(normalized.signature.byteLength, 64);
assert.throws(
  () => protocol.normalizeWireEvent({ type: "hello", protocol: 4, signature: Buffer.alloc(129).toString("base64") }),
  /Invalid signature length/,
);
assert.throws(() => protocol.normalizeWireEvent({ type: "hello", protocol: 4, signature: Buffer.alloc(63).toString("base64") }), /Invalid signature length/);
const wire = protocol.toWireEvent({ type: "hello", protocol: 4, signature: new Uint8Array(64) }, "sse");
assert.equal(wire.protocol, 4);
assert.equal(typeof wire.signature, "string");

const authenticated = {
  type: "device_key_update", protocol: 4, room: "room", from: "dev_sender",
  event_id: "evt_0123456789abcdef", sender_key_id: "key", key_generation: 2,
  public_key: new Uint8Array(32), sign_public_key: new Uint8Array(32),
};
const canonical = Buffer.from(protocol.canonicalEventBytes(authenticated));
assert.notDeepEqual(Buffer.from(protocol.canonicalEventBytes({ ...authenticated, event_id: "evt_fedcba9876543210" })), canonical);
assert.notDeepEqual(Buffer.from(protocol.canonicalEventBytes({ ...authenticated, key_generation: 1 })), canonical);
assert.notDeepEqual(Buffer.from(protocol.canonicalEventBytes({ ...authenticated, features: ["tampered"] })), canonical);

const now = 1_000_000_000;
const retentionInput = [
  { id: "expired", receivedAt: now - MESSAGE_RETENTION_MS - 1 },
  ...Array.from({ length: 202 }, (_, index) => ({ id: `recent-${index}`, receivedAt: now - index })),
];
const retention = partitionRetainedMessages(retentionInput, now);
assert.equal(retention.retained.length, 200);
assert.deepEqual(retention.removed.map((item) => item.id), ["expired", "recent-0", "recent-1"]);

const ownSignPublicKey = new Uint8Array([7]);
const ownEcho = { type: "group_msg", from: "dev_self", event_id: "evt_self", key_generation: 2, signature: new Uint8Array(64) };
assert.equal(signingIdentityForEvent(ownEcho, { ownDeviceId: "dev_self", ownSignPublicKey, ownKeyGeneration: 2, peer: null }).signPublicKey, ownSignPublicKey);
assert.equal(signingIdentityForEvent({ ...ownEcho, key_generation: 3 }, { ownDeviceId: "dev_self", ownSignPublicKey, ownKeyGeneration: 2, peer: null }), null);
assert.equal(authenticatedEventReplayKey({ ...ownEcho, type: "chunk", seq: 4 }), "dev_self:evt_self:4");

console.log("protocol v4 checks passed");
