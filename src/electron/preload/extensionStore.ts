/// <reference lib="dom" />

import { ipcRenderer } from "electron";
import { EXTENSION_STORE_NAVIGATION_CHANNEL } from
  "../extensionStoreNavigationProtocol";
import { installExtensionStoreNavigationCapture } from
  "./installExtensionStoreNavigationCapture";

installExtensionStoreNavigationCapture(window, (request) => {
  ipcRenderer.send(EXTENSION_STORE_NAVIGATION_CHANNEL, request);
});
