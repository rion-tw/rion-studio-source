import { ChromiumPlatformRuntimeHostFactory } from
  "../main/chromiumRuntimeHostFactory";
import type { ChromiumRuntimeHostPort } from
  "../main/chromiumRuntimeHostPorts";

/**
 * Keeps an exact E2E-only handle to the retained AppKit runtime host.
 *
 * The authenticated bridge may use this only to reveal the real native tab
 * menu. The journey still selects the visible NSMenuItem through macOS AX.
 */
export class ElectronDesktopE2eAppKitTabMenuRuntimeObserver {
  readonly #owners = new Map<string, ChromiumRuntimeHostPort>();

  install(): void {
    const owners = this.#owners;
    const factory = ChromiumPlatformRuntimeHostFactory.prototype;
    const originalCreate = factory.create;
    const originalCreateEmpty = factory.createEmpty;
    factory.create = async function (target, initialTab) {
      const host = await originalCreate.call(this, target, initialTab);
      owners.set(host.logicalWindowId, host);
      return host;
    };
    factory.createEmpty = async function (target, identity) {
      const host = await originalCreateEmpty.call(this, target, identity);
      owners.set(host.logicalWindowId, host);
      return host;
    };
  }

  show(windowId: string, tabId: string): void {
    const host = this.#owners.get(windowId);
    if (
      !host || host.logicalWindowId !== windowId || host.isDestroyed() ||
      host.appKitIdentity?.logicalWindowId !== windowId ||
      !host.desktopE2eShowAppKitTabMenu
    ) {
      throw new Error(
        `Game Window ${windowId} has no exact retained AppKit tab-menu owner.`
      );
    }
    if (host.desktopE2eShowAppKitTabMenu(tabId) !== true) {
      throw new Error(
        `Game Window ${windowId} rejected AppKit tab ${tabId} for its native menu.`
      );
    }
  }
}
