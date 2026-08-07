export const MAX_RETAINED_MESSAGES = 200;
export const MESSAGE_RETENTION_MS = 20 * 60 * 1000;

export function partitionRetainedMessages(messages, now = Date.now()) {
  const cutoff = now - MESSAGE_RETENTION_MS;
  const retained = [];
  const removed = [];
  for (const message of messages) {
    if (Number(message?.receivedAt || 0) < cutoff) removed.push(message);
    else retained.push(message);
  }
  if (retained.length > MAX_RETAINED_MESSAGES) {
    removed.push(...retained.splice(0, retained.length - MAX_RETAINED_MESSAGES));
  }
  return { retained, removed };
}
