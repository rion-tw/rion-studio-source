import type { ClearStorageDataOptions } from "electron";

export type ChromiumBrowserDataStorageType = NonNullable<
  ClearStorageDataOptions["storages"]
>[number];

export const CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES:
readonly ChromiumBrowserDataStorageType[] = Object.freeze([
  "cookies",
  "filesystem",
  "indexdb",
  "localstorage",
  "shadercache",
  "serviceworkers",
  "cachestorage"
] satisfies ChromiumBrowserDataStorageType[]);
