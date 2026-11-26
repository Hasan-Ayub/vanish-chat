/** Tiny promise wrapper around IndexedDB for local-first storage. */

const DB_NAME = 'vanish-chat';
const DB_VERSION = 2;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('accounts')) {
        const store = db.createObjectStore('accounts', { keyPath: 'id' });
        store.createIndex('by-username', 'username', { unique: true });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'token' });
      }
      if (!db.objectStoreNames.contains('chats')) {
        const store = db.createObjectStore('chats', { keyPath: 'id' });
        store.createIndex('by-updated', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('by-chat', 'chatId');
        store.createIndex('by-expires', 'expiresAt');
      }
      if (!db.objectStoreNames.contains('media')) {
        const store = db.createObjectStore('media', { keyPath: 'id' });
        store.createIndex('by-expires', 'expiresAt');
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const store = db.createObjectStore('chunks', { keyPath: 'id' });
        store.createIndex('by-media', 'mediaId');
        store.createIndex('by-expires', 'expiresAt');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Database upgrade blocked by another tab.'));
  });

  return dbPromise;
}

async function withStore(name, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    let out;
    try {
      out = fn(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export const getAll = (store) => withStore(store, 'readonly', (s) => s.getAll());
export const get = (store, key) => withStore(store, 'readonly', (s) => s.get(key));
export const put = (store, value) => withStore(store, 'readwrite', (s) => s.put(value));
export const del = (store, key) => withStore(store, 'readwrite', (s) => s.delete(key));
export const clearStore = (store) => withStore(store, 'readwrite', (s) => s.clear());
export const getByIndex = (store, index, value) =>
  withStore(store, 'readonly', (s) => s.index(index).getAll(value));

/**
 * Remove messages (and their media blobs) whose 24-hour lifetime has ended.
 * Returns the removed records so the caller can mirror deletions to the cloud.
 */
export async function purgeExpired(now = Date.now()) {
  const [messages, media, chunks] = await Promise.all([
    getAll('messages'),
    getAll('media'),
    getAll('chunks'),
  ]);
  const expiredMessages = messages.filter((m) => m.expiresAt <= now);
  const mediaIds = new Set([
    ...expiredMessages.filter((m) => m.mediaId).map((m) => m.mediaId),
    ...media.filter((item) => item.expiresAt <= now).map((item) => item.id),
  ]);
  const chunkIds = new Set([
    ...chunks.filter((item) => item.expiresAt <= now).map((item) => item.id),
    ...chunks.filter((item) => mediaIds.has(item.mediaId)).map((item) => item.id),
  ]);

  for (const message of expiredMessages) await del('messages', message.id);
  for (const id of mediaIds) await del('media', id);
  for (const id of chunkIds) await del('chunks', id);

  return { messages: expiredMessages, media: [...mediaIds] };
}

export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
