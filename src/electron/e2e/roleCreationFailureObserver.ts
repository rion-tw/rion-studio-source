import { WebContentsView } from "electron";

/** One exact Role view fault; only the authenticated desktop E2E bridge arms it. */
export class ElectronDesktopE2eRoleCreationFailureObserver {
  #armedRoleId: string | null = null;
  #consumedRoleId: string | null = null;

  install(): void {
    const original = WebContentsView.prototype.setBackgroundColor;
    const consumeFailure = (color: string, storagePath: string | null | undefined): boolean => {
      const roleId = this.#armedRoleId;
      if (!roleId || color !== "#00000000" ||
          !storagePath?.split(/[\\/]/u).includes(roleId)) return false;
      this.#armedRoleId = null;
      this.#consumedRoleId = roleId;
      return true;
    };
    WebContentsView.prototype.setBackgroundColor = function (color: string): void {
      const storagePath = this.webContents.session.storagePath;
      if (consumeFailure(color, storagePath)) {
        throw new Error("Desktop E2E injected one Role transparency failure.");
      }
      original.call(this, color);
    };
  }

  failNext(roleId: string): void {
    if (this.#armedRoleId) {
      throw new Error("A Role creation failure is already armed.");
    }
    this.#armedRoleId = roleId;
    this.#consumedRoleId = null;
  }

  wasConsumed(roleId: string): boolean { return this.#consumedRoleId === roleId; }
}
