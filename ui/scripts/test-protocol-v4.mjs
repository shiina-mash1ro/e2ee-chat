import assert from "node:assert/strict";
import { asBytes, createProtocolV3, PROTOCOL_VERSION } from "../src/protocol-v3.js";

const fakeSodium = {
  base64_variants: { ORIGINAL: 1 },
  from_base64(value) { return Uint8Array.from(Buffer.from(value, "base64")); },
  to_base64(value) { return Buffer.from(value).toString("base64"); },
};

assert.equal(PROTOCOL_VERSION, 4);
assert.deepEqual([...asBytes([0, 1, 255])], [0, 1, 255]);
assert.throws(() => asBytes(1024), /Invalid byte value/);
assert.throws(() => asBytes([256]), /Invalid byte array/);

const protocol = createProtocolV3(fakeSodium);
assert.throws(() => protocol.normalizeWireEvent({ type: "hello", protocol: 3 }), /Unsupported protocol/);
const normalized = protocol.normalizeWireEvent({ type: "hello", protocol: 4, signature: Buffer.alloc(64).toString("base64") });
assert.equal(normalized.protocol, 3);
assert.equal(normalized.signature.byteLength, 64);
assert.throws(
  () => protocol.normalizeWireEvent({ type: "hello", protocol: 4, signature: Buffer.alloc(129).toString("base64") }),
  /Invalid signature length/,
);
const wire = protocol.toWireEvent({ type: "hello", protocol: 3, signature: new Uint8Array(64) }, "sse");
assert.equal(wire.protocol, 4);
assert.equal(typeof wire.signature, "string");

console.log("protocol v4 checks passed");
