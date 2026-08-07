export function authenticatedEventReplayKey(event) {
  if (!event?.from || !event?.event_id) return "";
  return `${event.from}:${event.event_id}:${event.type === "chunk" ? Number(event.seq) : ""}`;
}

export function signingIdentityForEvent(event, { ownDeviceId, ownSignPublicKey, ownKeyGeneration, peer }) {
  const identity = event?.from === ownDeviceId
    ? { signPublicKey: ownSignPublicKey, keyGeneration: ownKeyGeneration }
    : peer;
  const generation = Number(event?.key_generation);
  if (!identity?.signPublicKey || !event?.signature || !event?.event_id || !Number.isInteger(generation) || generation < 0) return null;
  if (event.type !== "device_key_update" && generation > Number(identity.keyGeneration || 0)) return null;
  return identity;
}
