// IndexedDB-backed cache for SLAM map artefacts, keyed by robot map ID.
// The robot only has one physical slot, so we cache each saved map's full file
// set here so it can be re-uploaded later for localization/navigation, and
// rendered in the viewer without involving the robot.

const DB_NAME = 'go2_slam';
// v2: switched from raw ArrayBuffer to {pcd, pgm, txt} bundle per map id.
const DB_VERSION = 2;
const STORE = 'pcds';

export interface MapBundle {
  pcd: ArrayBuffer;
  pgm?: ArrayBuffer;
  txt?: ArrayBuffer;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
      // v1 → v2: legacy entries were a bare ArrayBuffer; rewrite as {pcd}.
      if ((e.oldVersion ?? 0) < 2) {
        const tx = req.transaction!;
        const store = tx.objectStore(STORE);
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const v = cursor.value;
          if (v instanceof ArrayBuffer) {
            cursor.update({ pcd: v });
          }
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function putBundle(mapId: string, bundle: MapBundle): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(bundle, mapId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function patchBundle(mapId: string, patch: Partial<MapBundle>): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(mapId);
    getReq.onsuccess = () => {
      const existing = (getReq.result ?? {}) as MapBundle;
      store.put({ ...existing, ...patch }, mapId);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getBundle(mapId: string): Promise<MapBundle | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(mapId);
    req.onsuccess = () => {
      const v = req.result;
      if (!v) return resolve(null);
      if (v instanceof ArrayBuffer) return resolve({ pcd: v });
      resolve(v as MapBundle);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteBundle(mapId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(mapId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listBundleIds(): Promise<string[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
    req.onerror = () => reject(req.error);
  });
}

export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // Avoid stack overflow on large buffers — chunked conversion.
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
