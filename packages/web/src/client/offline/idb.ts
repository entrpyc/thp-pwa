import {
  BY_USER_INDEX,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_STORES,
} from './schema';

/**
 * **A promise face over IndexedDB**, as small as the four stores need.
 *
 * No library: the surface the offline module uses is open, get, put, delete, and "everything
 * under this index value", and a dependency that wraps the whole API would be the larger thing to
 * keep in step. Every call opens the database on first use and keeps the connection; a
 * `versionchange` closes it so a future schema bump in another tab is not blocked by this one.
 *
 * Everything is **guarded at the caller**, not here: a browser with storage blocked rejects on
 * `open`, and what that costs is decided where the feature is used — no downloads rather than a
 * broken player.
 */

export type StoreName = (typeof OFFLINE_STORES)[keyof typeof OFFLINE_STORES];

let opening: Promise<IDBDatabase> | null = null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * The one place the stores are created. The upgrade runs once per version on each device; a later
 * version adds a branch on `oldVersion` rather than editing this one.
 */
function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(OFFLINE_STORES.downloads)) {
    const downloads = db.createObjectStore(OFFLINE_STORES.downloads, { keyPath: 'key' });
    downloads.createIndex(BY_USER_INDEX, 'userId', { unique: false });
  }
  if (!db.objectStoreNames.contains(OFFLINE_STORES.media)) {
    db.createObjectStore(OFFLINE_STORES.media);
  }
  if (!db.objectStoreNames.contains(OFFLINE_STORES.outbox)) {
    const outbox = db.createObjectStore(OFFLINE_STORES.outbox, { keyPath: 'clientId' });
    outbox.createIndex(BY_USER_INDEX, 'userId', { unique: false });
  }
  if (!db.objectStoreNames.contains(OFFLINE_STORES.meta)) {
    db.createObjectStore(OFFLINE_STORES.meta);
  }
  if (!db.objectStoreNames.contains(OFFLINE_STORES.noteImages)) {
    const images = db.createObjectStore(OFFLINE_STORES.noteImages, { keyPath: 'id' });
    images.createIndex(BY_USER_INDEX, 'userId', { unique: false });
  }
}

export function openOfflineDatabase(): Promise<IDBDatabase> {
  if (opening !== null) return opening;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available here'));
  }
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      opening = null;
      reject(req.error ?? new Error('IndexedDB open failed'));
    };
    req.onblocked = () => {
      opening = null;
      reject(new Error('IndexedDB open blocked'));
    };
  });
  return opening;
}

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(store, 'readonly');
  return request(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export async function idbPut(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(store, 'readwrite');
  await request(key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key));
}

export async function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(store, 'readwrite');
  await request(tx.objectStore(store).delete(key));
}

/** Every key in a store. For the small `meta` store; the big ones are read through their index. */
export async function idbKeys(store: StoreName): Promise<IDBValidKey[]> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(store, 'readonly');
  return request(tx.objectStore(store).getAllKeys());
}

/**
 * Read a value and write `change(value)` back **in one transaction**, so a delete made between
 * the read and the write cannot be undone by the write: a value gone when the transaction starts
 * is left gone, and `false` is answered. IndexedDB serialises transactions on a store, which is
 * the guarantee a get-then-put across two transactions does not have.
 */
export async function idbUpdate<T>(
  store: StoreName,
  key: IDBValidKey,
  change: (value: T) => T,
): Promise<boolean> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(store, 'readwrite');
  const objectStore = tx.objectStore(store);
  const current = await request(objectStore.get(key) as IDBRequest<T | undefined>);
  if (current === undefined) return false;
  await request(objectStore.put(change(current)));
  return true;
}

/** Every value whose indexed field equals `value`. */
export async function idbAllBy<T>(store: StoreName, index: string, value: IDBValidKey): Promise<T[]> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(store, 'readonly');
  return request(tx.objectStore(store).index(index).getAll(value) as IDBRequest<T[]>);
}
