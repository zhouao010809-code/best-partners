const DB_NAME = 'best-partners-clipper';
const DB_VERSION = 1;
const STORE_NAME = 'payloads';
const STATE_KEY = 'pendingState';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

function createIndexedDbDatabase(indexedDBRef = globalThis.indexedDB) {
  async function open() {
    if (!indexedDBRef) throw new Error('IndexedDB unavailable; cannot safely persist pending clip');
    const request = indexedDBRef.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'packetId' });
    };
    return requestResult(request);
  }
  return {
    async list() {
      const db = await open();
      try { return await requestResult(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll()); }
      finally { db.close(); }
    },
    async put(payload) {
      const db = await open();
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put(payload);
        await transactionDone(transaction);
      } finally { db.close(); }
    },
    async remove(packetId) {
      const db = await open();
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(packetId);
        await transactionDone(transaction);
      } finally { db.close(); }
    }
  };
}

function createPendingStore({ storage = globalThis.chrome?.storage?.local, database = createIndexedDbDatabase() } = {}) {
  async function syncState(lastError) {
    if (!storage?.set) return;
    const payloads = await database.list();
    const state = { packetIds: payloads.map((payload) => payload.packetId), count: payloads.length };
    if (lastError) state.lastError = String(lastError);
    await storage.set({ [STATE_KEY]: state });
  }
  return {
    async list() { return database.list(); },
    async save(payload) { await database.put(payload); await syncState(); },
    async remove(packetId) { await database.remove(packetId); await syncState(); },
    async recordError(error) { await syncState(error); }
  };
}

export { DB_NAME, STATE_KEY, createIndexedDbDatabase, createPendingStore };
