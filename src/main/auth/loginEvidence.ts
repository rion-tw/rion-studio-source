import { containsLoginPromptText } from "./loginDetection";

export interface LoginStorageClient {
  send: <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
}

export interface LoginStorageSnapshot {
  cookies: Record<string, string>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  indexedDb: Record<string, string>;
  bodyText: string;
}

export interface LoginStorageReadiness {
  ready: boolean;
  reason: string;
}

export const LOGIN_STORAGE_EXPRESSION = `(async () => {
  const readStorage = (name) => {
    const values = {};
    try {
      const storage = window[name];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key !== null) {
          values[key] = storage.getItem(key) ?? "";
        }
      }
    } catch {
      return values;
    }
    return values;
  };
  const requestToPromise = (request) => {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
  };
  const summarizeValue = (value) => {
    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized === "string") {
        return serialized.length + ":" + serialized.slice(0, 160);
      }
    } catch {
      // Ignore and fall back to Object.prototype below.
    }
    return Object.prototype.toString.call(value);
  };
  const openDatabase = async (name) => {
    return requestToPromise(indexedDB.open(name));
  };
  const readIndexedDb = async () => {
    const values = {};
    try {
      if (!("indexedDB" in window) || typeof indexedDB.databases !== "function") {
        return values;
      }

      const databases = await indexedDB.databases();
      for (const database of databases) {
        if (!database.name) {
          continue;
        }

        let connection;
        try {
          connection = await openDatabase(database.name);
          const stores = {};

          for (const storeName of Array.from(connection.objectStoreNames)) {
            try {
              const transaction = connection.transaction(storeName, "readonly");
              const store = transaction.objectStore(storeName);
              const [count, keys, records] = await Promise.all([
                requestToPromise(store.count()).catch(() => 0),
                requestToPromise(store.getAllKeys(undefined, 5)).catch(() => []),
                requestToPromise(store.getAll(undefined, 3)).catch(() => [])
              ]);

              stores[storeName] = {
                count,
                keys: Array.isArray(keys) ? keys.map(summarizeValue) : [],
                records: Array.isArray(records) ? records.map(summarizeValue) : []
              };
            } catch (error) {
              stores[storeName] = { error: String(error) };
            }
          }

          values[database.name] = summarizeValue({
            version: connection.version,
            stores
          });
        } catch (error) {
          values[database.name] = "error:" + String(error);
        } finally {
          connection?.close();
        }
      }
    } catch {
      return values;
    }

    return values;
  };

  return {
    localStorage: readStorage("localStorage"),
    sessionStorage: readStorage("sessionStorage"),
    indexedDb: await readIndexedDb(),
    bodyText: document.body?.innerText ?? ""
  };
})()`;

export async function readLoginStorageSnapshot(
  client: LoginStorageClient,
  launchUrl: string
): Promise<LoginStorageSnapshot> {
  const [cookieResult, runtimeResult] = await Promise.all([
    client.send<{ cookies?: unknown[] }>("Network.getCookies", { urls: [launchUrl] }),
    client.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      expression: LOGIN_STORAGE_EXPRESSION,
      returnByValue: true,
      awaitPromise: true
    })
  ]);

  return createLoginStorageSnapshot(cookieResult.cookies, runtimeResult.result?.value);
}

export function createLoginStorageSnapshot(cookies: unknown, runtimeValue: unknown): LoginStorageSnapshot {
  return {
    cookies: normalizeCookieMap(cookies),
    localStorage: normalizeStorageMap(readRuntimeStorageValue(runtimeValue, "localStorage")),
    sessionStorage: normalizeStorageMap(readRuntimeStorageValue(runtimeValue, "sessionStorage")),
    indexedDb: normalizeStorageMap(readRuntimeStorageValue(runtimeValue, "indexedDb")),
    bodyText: readRuntimeBodyText(runtimeValue)
  };
}

export function isLoginStorageReady(
  baseline: LoginStorageSnapshot | undefined,
  current: LoginStorageSnapshot
): LoginStorageReadiness {
  if (containsLoginPromptText(current.bodyText)) {
    return {
      ready: false,
      reason: "login_prompt_visible"
    };
  }

  if (hasAuthLikeStorageChange(baseline, current)) {
    return {
      ready: true,
      reason: "auth_like_storage_changed"
    };
  }

  if (!baseline && hasPostLoginStorageEvidence(current)) {
    return {
      ready: true,
      reason: "post_login_storage_present"
    };
  }

  if (baseline && hasNonTrackingStorageChange(baseline, current)) {
    return {
      ready: true,
      reason: "non_tracking_storage_changed"
    };
  }

  return {
    ready: false,
    reason: "storage_not_ready"
  };
}

export function isPersistedLoginStorageReady(snapshot: LoginStorageSnapshot): LoginStorageReadiness {
  if (containsLoginPromptText(snapshot.bodyText)) {
    return {
      ready: false,
      reason: "login_prompt_visible"
    };
  }

  if (hasAuthLikeStorageEntry(snapshot)) {
    return {
      ready: true,
      reason: "auth_like_storage_present"
    };
  }

  if (hasMeaningfulIndexedDbEvidence(snapshot)) {
    return {
      ready: true,
      reason: "indexed_db_storage_present"
    };
  }

  return {
    ready: false,
    reason: "no_persisted_login_evidence"
  };
}

export function createLoginStorageFingerprint(snapshot: LoginStorageSnapshot): string {
  return JSON.stringify(
    listSnapshotEntries(snapshot)
      .filter((entry) => !isTrackingStorageName(entry.name))
      .sort((left, right) => {
        const areaOrder = left.area.localeCompare(right.area);
        return areaOrder !== 0 ? areaOrder : left.name.localeCompare(right.name);
      })
  );
}

function normalizeCookieMap(cookies: unknown): Record<string, string> {
  const values: Record<string, string> = {};

  if (!Array.isArray(cookies)) {
    return values;
  }

  for (const cookie of cookies) {
    if (
      typeof cookie === "object" &&
      cookie !== null &&
      "name" in cookie &&
      "value" in cookie &&
      typeof (cookie as { name?: unknown }).name === "string"
    ) {
      values[(cookie as { name: string }).name] = String((cookie as { value?: unknown }).value ?? "");
    }
  }

  return values;
}

function normalizeStorageMap(value: unknown): Record<string, string> {
  const values: Record<string, string> = {};

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return values;
  }

  for (const [key, storageValue] of Object.entries(value)) {
    values[key] = String(storageValue ?? "");
  }

  return values;
}

function readRuntimeStorageValue(value: unknown, key: "localStorage" | "sessionStorage" | "indexedDb"): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }

  return (value as Record<string, unknown>)[key];
}

function readRuntimeBodyText(value: unknown): string {
  if (typeof value !== "object" || value === null || !("bodyText" in value)) {
    return "";
  }

  return String((value as { bodyText?: unknown }).bodyText ?? "");
}

function hasAuthLikeStorageChange(
  baseline: LoginStorageSnapshot | undefined,
  current: LoginStorageSnapshot
): boolean {
  return listSnapshotEntries(current).some((entry) => {
    if (isTrackingStorageName(entry.name) || !isAuthLikeStorageEntry(entry)) {
      return false;
    }

    if (!baseline) {
      return true;
    }

    const baselineValue = baseline[entry.area][entry.name];
    return baselineValue !== entry.value;
  });
}

function hasNonTrackingStorageChange(baseline: LoginStorageSnapshot, current: LoginStorageSnapshot): boolean {
  return listSnapshotEntries(current).some((entry) => {
    if (isTrackingStorageName(entry.name)) {
      return false;
    }

    const baselineValue = baseline[entry.area][entry.name];
    return baselineValue !== entry.value;
  });
}

function hasPostLoginStorageEvidence(current: LoginStorageSnapshot): boolean {
  return listSnapshotEntries(current).some((entry) => !isTrackingStorageName(entry.name));
}

function hasAuthLikeStorageEntry(snapshot: LoginStorageSnapshot): boolean {
  return listSnapshotEntries(snapshot).some(
    (entry) => !isTrackingStorageName(entry.name) && isAuthLikeStorageEntry(entry)
  );
}

function hasMeaningfulIndexedDbEvidence(snapshot: LoginStorageSnapshot): boolean {
  return Object.entries(snapshot.indexedDb).some(([name, value]) => {
    if (isTrackingStorageName(name)) {
      return false;
    }

    return value.trim().length > 0;
  });
}

function listSnapshotEntries(snapshot: LoginStorageSnapshot): Array<{
  area: "cookies" | "localStorage" | "sessionStorage" | "indexedDb";
  name: string;
  value: string;
}> {
  return [
    ...Object.entries(snapshot.cookies).map(([name, value]) => ({ area: "cookies" as const, name, value })),
    ...Object.entries(snapshot.localStorage).map(([name, value]) => ({
      area: "localStorage" as const,
      name,
      value
    })),
    ...Object.entries(snapshot.sessionStorage).map(([name, value]) => ({
      area: "sessionStorage" as const,
      name,
      value
    })),
    ...Object.entries(snapshot.indexedDb).map(([name, value]) => ({
      area: "indexedDb" as const,
      name,
      value
    }))
  ];
}

function isTrackingStorageName(name: string): boolean {
  const normalized = name.toLowerCase();

  return (
    normalized === "_ga" ||
    normalized === "_gid" ||
    normalized === "_gat" ||
    normalized === "_fbp" ||
    normalized === "_fbc" ||
    normalized.startsWith("_ga_") ||
    normalized.startsWith("_gcl_") ||
    normalized.startsWith("__utm")
  );
}

function isAuthLikeStorageEntry(entry: { name: string; value: string }): boolean {
  const normalized = `${entry.name} ${entry.value}`.toLowerCase();

  return AUTH_STORAGE_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

const AUTH_STORAGE_KEYWORDS = ["auth", "token", "session", "jwt", "sid", "login", "user", "account"];
