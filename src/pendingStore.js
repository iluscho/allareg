/**
 * Хранилище незавершённого ввода для Node-версии.
 * В Cloudflare Workers используется D1-хранилище с тем же интерфейсом.
 */
export function createMemoryPendingStore() {
  const entries = new Map();

  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        entries.delete(key);
        return null;
      }
      return entry;
    },
    async set(key, value) {
      entries.set(key, value);
    },
    async remove(key) {
      entries.delete(key);
    },
  };
}
