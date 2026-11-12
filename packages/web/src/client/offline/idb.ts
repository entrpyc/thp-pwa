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
  if (!db.objectStoreNames.contains(OFFLINE_STORES.reads)) {
    const reads = db.createObjectStore(OFFLINE_STORES.reads, { keyPath: 'key' });
    reads.createIndex(BY_USER_INDEX, 'userId', { unique: false });
  }
  if (!db.objectStoreNames.contains(OFFLINE_STORES.requests)) {
    const requests = db.createObjectStore(OFFLINE_STORES.requests, { keyPath: 'clientId' });
    requests.createIndex(BY_USER_INDEX, 'userId', { unique: false });
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
      // The browser closed it under us (storage eviction, a killed storage process).
      db.onclose = () => {
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

/**
 * Open a transaction and hand its store to `use`, **reopening once if the kept connection is
 * dead**. iOS closes IndexedDB connections of a suspended page without always firing `close`, so
 * the kept connection can throw `InvalidStateError` ("the database connection is closing") on the
 * first transaction after the app returns from the background. `use` is called in the same tick
 * the transaction is created in, so the transaction cannot go inactive before its first request.
 */
async function withStore<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  use: (objectStore: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const attempt = openOfflineDatabase();
  let db = await attempt;
  let tx: IDBTransaction;
  try {
    tx = db.transaction(store, mode);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error;
    // Only drop the connection that failed: a concurrent caller may already have reopened.
    if (opening === attempt) opening = null;
    db.close();
    db = await openOfflineDatabase();
    tx = db.transaction(store, mode);
  }
  return use(tx.objectStore(store));
}

export function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return withStore(store, 'readonly', (os) => request(os.get(key) as IDBRequest<T | undefined>));
}

export async function idbPut(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  await withStore(store, 'readwrite', (os) =>
    request(key === undefined ? os.put(value) : os.put(value, key)),
  );
}

export async function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  await withStore(store, 'readwrite', (os) => request(os.delete(key)));
}

/** Every key in a store. For the small `meta` store; the big ones are read through their index. */
export function idbKeys(store: StoreName): Promise<IDBValidKey[]> {
  return withStore(store, 'readonly', (os) => request(os.getAllKeys()));
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
  return withStore(store, 'readwrite', async (objectStore) => {
    const current = await request(objectStore.get(key) as IDBRequest<T | undefined>);
    if (current === undefined) return false;
    await request(objectStore.put(change(current)));
    return true;
  });
}

/** Empty a store. For the copies a sign-out must not leave behind. */
export async function idbClear(store: StoreName): Promise<void> {
  await withStore(store, 'readwrite', (os) => request(os.clear()));
}

/** Every value whose indexed field equals `value`. */
export function idbAllBy<T>(store: StoreName, index: string, value: IDBValidKey): Promise<T[]> {
  return withStore(store, 'readonly', (os) => request(os.index(index).getAll(value) as IDBRequest<T[]>));
}
