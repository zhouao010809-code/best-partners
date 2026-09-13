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
    try {
      const response = await send(payload);
      if (response?.ok === false) throw new Error(response.error || 'Native host rejected the payload');
      await store.remove(payload.packetId);
      return response || { ok: true, packetId: payload.packetId };
    } catch (error) {
      try {
        await store.save(payload);
      } catch (persistError) {
        await store.recordError(persistError).catch(() => undefined);
        throw new Error(`发送失败，且无法保存待发送收藏：${persistError.message || persistError}`);
      }
      throw error;
    }
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
