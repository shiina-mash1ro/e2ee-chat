import { decode, encode } from "@msgpack/msgpack";
import sodium from "libsodium-wrappers";

await sodium.ready;

self.addEventListener("message", (event) => {
  const { id, op, data } = event.data || {};
  try {
    let result;
    switch (op) {
      case "groupEncrypt":
        result = groupEncrypt(data);
        break;
      case "groupDecrypt":
        result = groupDecrypt(data);
        break;
      case "privateEncrypt":
        result = privateEncrypt(data);
        break;
      case "privateDecrypt":
        result = privateDecrypt(data);
        break;
      default:
        throw new Error(`Unknown crypto op: ${op}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});

function groupEncrypt({ payload, roomId, roomKey }) {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const additionalData = sodium.from_string(`room:${roomId}`);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    encode(payload),
    additionalData,
    null,
    nonce,
    roomKey,
  );
  return { nonce, ciphertext };
}

function groupDecrypt({ nonce, ciphertext, roomId, roomKey }) {
  const additionalData = sodium.from_string(`room:${roomId}`);
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    additionalData,
    nonce,
    roomKey,
  );
  return decode(plaintext);
}

function privateEncrypt({ payload, nonce, peerPublicKey, privateKey }) {
  const ciphertext = sodium.crypto_box_easy(encode(payload), nonce, peerPublicKey, privateKey);
  return { ciphertext };
}

function privateDecrypt({ nonce, ciphertext, peerPublicKey, privateKey }) {
  const plaintext = sodium.crypto_box_open_easy(ciphertext, nonce, peerPublicKey, privateKey);
  return decode(plaintext);
}
