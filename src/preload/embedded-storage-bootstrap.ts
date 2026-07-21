import { ipcRenderer } from "electron";

import {
  EMBEDDED_STORAGE_BOOTSTRAP_COMPLETE_CHANNEL,
  EMBEDDED_STORAGE_BOOTSTRAP_SEED_CHANNEL
} from "../shared/internalIpc";

interface EncodedStorageValue {
  type?: string;
  value?: string;
  name?: string;
  mimeType?: string;
  values?: EncodedStorageValue[];
  entries?: Array<[string, EncodedStorageValue]>;
}

interface IndexedDbRecordSeed {
  key: EncodedStorageValue;
  value: EncodedStorageValue;
}

interface IndexedDbObjectStoreSeed {
  autoIncrement: boolean;
  indexes: Array<{ keyPath: string | string[] | null; multiEntry: boolean; name: string; unique: boolean }>;
  keyPath: string | string[] | null;
  name: string;
  records: IndexedDbRecordSeed[];
}

interface IndexedDbDatabaseSeed {
  name: string;
  objectStores: IndexedDbObjectStoreSeed[];
  version: number;
}

interface CacheStorageEntrySeed {
  bodyBase64: string;
  cacheName: string;
  requestHeaders: Array<[string, string]>;
  requestUrl: string;
  responseHeaders: Array<[string, string]>;
  responseStatus: number;
  responseStatusText: string;
}

interface BootstrapSeed {
  cacheStorage?: CacheStorageEntrySeed[];
  indexedDb?: IndexedDbDatabaseSeed[];
  localStorage?: Record<string, string>;
}

void bootstrapAtDocumentStart();

async function bootstrapAtDocumentStart(): Promise<void> {
  if (window.top !== window) return;

  const origin = window.location.origin;
  let seed: BootstrapSeed | undefined;
  try {
    seed = ipcRenderer.sendSync(EMBEDDED_STORAGE_BOOTSTRAP_SEED_CHANNEL, { origin }) as BootstrapSeed | undefined;
  } catch {
    return;
  }
  if (!isBootstrapSeed(seed)) return;

  let indexedDbRecordCount = 0;
  let cacheEntryCount = 0;
  let localStorageKeyCount = 0;
  let success = true;
  try {
    localStorageKeyCount = restoreLocalStorage(seed.localStorage ?? {});
    indexedDbRecordCount = await restoreIndexedDb(seed.indexedDb ?? []);
    cacheEntryCount = await restoreCacheStorage(seed.cacheStorage ?? []);
  } catch {
    success = false;
  }

  ipcRenderer.send(EMBEDDED_STORAGE_BOOTSTRAP_COMPLETE_CHANNEL, {
    cacheEntryCount,
    indexedDbRecordCount,
    localStorageKeyCount,
    origin,
    success
  });
}

function restoreLocalStorage(values: Record<string, string>): number {
  for (const [key, value] of Object.entries(values)) {
    localStorage.setItem(key, value);
  }
  return Object.keys(values).length;
}

async function restoreIndexedDb(databases: IndexedDbDatabaseSeed[]): Promise<number> {
  let recordCount = 0;
  for (const databaseSeed of databases) {
    const database = await openDatabase(databaseSeed);
    try {
      const decoded = await Promise.all(databaseSeed.objectStores.map(async (store) => ({
        name: store.name,
        keyPath: store.keyPath,
        records: await Promise.all(store.records.map(async (record) => ({
          key: await decodeStorageValue(record.key),
          value: await decodeStorageValue(record.value)
        })))
      })));
      const transaction = database.transaction(decoded.map((store) => store.name), "readwrite");
      for (const storeSeed of decoded) {
        const objectStore = transaction.objectStore(storeSeed.name);
        for (const record of storeSeed.records) {
          if (storeSeed.keyPath === null) {
            objectStore.put(record.value, record.key as IDBValidKey);
          } else {
            objectStore.put(record.value);
          }
          recordCount += 1;
        }
      }
      await transactionComplete(transaction);
    } finally {
      database.close();
    }
  }
  return recordCount;
}

async function restoreCacheStorage(entries: CacheStorageEntrySeed[]): Promise<number> {
  let entryCount = 0;
  for (const entry of entries) {
    const cache = await caches.open(entry.cacheName);
    const request = new Request(entry.requestUrl, { headers: entry.requestHeaders, method: "GET" });
    const response = new Response(base64ToArrayBuffer(entry.bodyBase64), {
      headers: entry.responseHeaders,
      status: entry.responseStatus,
      statusText: entry.responseStatusText
    });
    await cache.put(request, response);
    entryCount += 1;
  }
  return entryCount;
}

function openDatabase(seed: IndexedDbDatabaseSeed): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(seed.name, seed.version);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const storeSeed of seed.objectStores) {
        const objectStore = database.objectStoreNames.contains(storeSeed.name)
          ? request.transaction?.objectStore(storeSeed.name)
          : database.createObjectStore(storeSeed.name, {
              autoIncrement: storeSeed.autoIncrement,
              keyPath: storeSeed.keyPath
            });
        if (!objectStore) continue;
        for (const indexSeed of storeSeed.indexes) {
          if (indexSeed.keyPath !== null && !objectStore.indexNames.contains(indexSeed.name)) {
            objectStore.createIndex(indexSeed.name, indexSeed.keyPath, {
              multiEntry: indexSeed.multiEntry,
              unique: indexSeed.unique
            });
          }
        }
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB."));
    request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked."));
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

async function decodeStorageValue(value: EncodedStorageValue): Promise<unknown> {
  if (value === null || typeof value !== "object" || !("type" in value)) return value;
  switch (value.type) {
    case "undefined":
      return undefined;
    case "number":
      return value.value === "NaN" ? Number.NaN : value.value === "Infinity" ? Infinity : -Infinity;
    case "bigint":
      return BigInt(value.value ?? "0");
    case "date":
      return new Date(value.value ?? "");
    case "array-buffer":
      return base64ToArrayBuffer(value.value ?? "");
    case "blob":
      return new Blob([base64ToArrayBuffer(value.value ?? "")], { type: value.mimeType ?? "" });
    case "typed-array":
      return createTypedArray(value.name, base64ToBytes(value.value ?? ""));
    case "array":
      return Promise.all((value.values ?? []).map((item) => decodeStorageValue(item)));
    case "object":
      return Object.fromEntries(await Promise.all((value.entries ?? []).map(async ([key, item]) => [
        key,
        await decodeStorageValue(item)
      ] as const)));
    default:
      throw new Error("Unsupported persistent storage value.");
  }
}

function createTypedArray(name: string | undefined, bytes: Uint8Array): ArrayBufferView {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  switch (name) {
    case "Int8Array": return new Int8Array(buffer);
    case "Uint8ClampedArray": return new Uint8ClampedArray(buffer);
    case "Int16Array": return new Int16Array(buffer);
    case "Uint16Array": return new Uint16Array(buffer);
    case "Int32Array": return new Int32Array(buffer);
    case "Uint32Array": return new Uint32Array(buffer);
    case "Float32Array": return new Float32Array(buffer);
    case "Float64Array": return new Float64Array(buffer);
    case "BigInt64Array": return new BigInt64Array(buffer);
    case "BigUint64Array": return new BigUint64Array(buffer);
    default: return new Uint8Array(buffer);
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const bytes = base64ToBytes(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isBootstrapSeed(value: unknown): value is BootstrapSeed {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
