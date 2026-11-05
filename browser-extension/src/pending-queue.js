import { validateClipperPayload } from './payload.js';

function createPendingQueue({ store, send }) {
  let tail = Promise.resolve();
  const serialize = (operation) => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  };

  async function deliverUnlocked(payload) {
    const validation = validateClipperPayload(payload);
    if (!validation.ok) throw new TypeError(validation.error);
    // The service worker may stop while the native host is still responding.
    // Commit the outbox first; the same packetId makes a replay idempotent.
    try {
      await store.save(payload);
    } catch (persistError) {
      await store.recordError(persistError).catch(() => undefined);
      const error = new Error(`无法保存待发送收藏，尚未发送：${persistError.message || persistError}`);
      error.queued = false;
      throw error;
    }
    const response = await send(payload);
    if (response?.ok === false) throw new Error(response.error || 'Native host rejected the payload');
    await store.remove(payload.packetId);
    return response || { ok: true, packetId: payload.packetId };
  }

  return {
    deliver(payload) { return serialize(() => deliverUnlocked(payload)); },
    retryPending() {
      return serialize(async () => {
        const results = [];
        for (const payload of await store.list()) {
          try { results.push(await deliverUnlocked(payload)); }
          catch (error) { results.push({ ok: false, packetId: payload.packetId, error: error.message }); }
        }
        return results;
      });
    }
  };
}

export { createPendingQueue };
