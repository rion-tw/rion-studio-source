import {
  Menu,
  type BaseWindow,
  type KeyboardEvent as ElectronKeyboardEvent,
  type MenuItemConstructorOptions,
  type WebContents
} from "electron";

import type { AppLanguage } from "../../shared/types";

type MenuLabelKey = "app" | "edit" | "view" | "window" | "alwaysShow" | "toggleFullScreen";

export type ApplicationMenuZoomAction = "in" | "out" | "reset";

export const APPLICATION_MENU_ZOOM_ITEM_IDS: Record<ApplicationMenuZoomAction, string> = {
  in: "rion-browser-zoom-in",
  out: "rion-browser-zoom-out",
  reset: "rion-browser-reset-zoom"
};

const labels: Record<AppLanguage, Record<MenuLabelKey, string>> = {
  en: {
    app: "Rion Studio",
    edit: "Edit",
    view: "View",
    window: "Window",
    alwaysShow: "Always Show Toolbar in Full Screen",
    toggleFullScreen: "Toggle Full Screen"
  },
  "zh-TW": {
    app: "Rion Studio",
    edit: "編輯",
    view: "顯示",
    window: "視窗",
    alwaysShow: "全螢幕時一律顯示工具列",
    toggleFullScreen: "切換全螢幕"
  },
  "zh-CN": {
    app: "Rion Studio",
    edit: "编辑",
    view: "视图",
    window: "窗口",
    alwaysShow: "全屏时始终显示工具栏",
    toggleFullScreen: "切换全屏"
  },
  ja: {
    app: "Rion Studio",
    edit: "編集",
    view: "表示",
    window: "ウインドウ",
    alwaysShow: "フルスクリーンでツールバーを常に表示",
    toggleFullScreen: "フルスクリーンを切り替える"
  }
};

interface ApplicationMenuOptions {
  alwaysShowToolbarInFullScreen: boolean;
  applyAlwaysShowToolbarInFullScreen: (value: boolean) => void;
  language?: AppLanguage;
  logger?: Pick<Console, "error">;
  platform?: NodeJS.Platform;
  saveAlwaysShowToolbarInFullScreen: (value: boolean) => Promise<void>;
  setApplicationMenu?: (menu: Menu) => void;
  toggleFullScreen?: () => void;
}

export class ApplicationMenuController {
  private alwaysShowToolbarInFullScreen: boolean;
  private language: AppLanguage;
  private readonly logger: Pick<Console, "error">;
  private menu?: Menu;

  constructor(private readonly options: ApplicationMenuOptions) {
    this.alwaysShowToolbarInFullScreen = options.alwaysShowToolbarInFullScreen;
    this.language = options.language ?? "en";
    this.logger = options.logger ?? console;
  }

  install(): void {
    this.rebuild();
  }

  setLanguage(language: AppLanguage): void {
    if (language === this.language) return;
    this.language = language;
    this.rebuild();
  }

  performZoom(
    action: ApplicationMenuZoomAction,
    event: ElectronKeyboardEvent,
    focusedWindow: BaseWindow,
    focusedWebContents: WebContents
  ): boolean {
    const item = this.menu?.getMenuItemById(APPLICATION_MENU_ZOOM_ITEM_IDS[action]);
    if (!item) {
      return false;
    }

    item.click(event, focusedWindow, focusedWebContents);
    return true;
  }

  private rebuild(): void {
    const menu = Menu.buildFromTemplate(buildApplicationMenuTemplate({
      alwaysShowToolbarInFullScreen: this.alwaysShowToolbarInFullScreen,
      language: this.language,
      onAlwaysShowToolbarInFullScreenChanged: (value) => void this.updateAlwaysShow(value),
      onToggleFullScreen: this.options.toggleFullScreen ?? (() => undefined),
      platform: this.options.platform ?? process.platform
    }));
    this.menu = menu;
    (this.options.setApplicationMenu ?? Menu.setApplicationMenu)(menu);
  }

  private async updateAlwaysShow(value: boolean): Promise<void> {
    if (value === this.alwaysShowToolbarInFullScreen) return;
    const previous = this.alwaysShowToolbarInFullScreen;
    this.alwaysShowToolbarInFullScreen = value;
    this.options.applyAlwaysShowToolbarInFullScreen(value);
    this.rebuild();

    try {
      await this.options.saveAlwaysShowToolbarInFullScreen(value);
    } catch (error) {
      this.alwaysShowToolbarInFullScreen = previous;
      this.options.applyAlwaysShowToolbarInFullScreen(previous);
      this.rebuild();
      this.logger.error("Failed to save the fullscreen toolbar preference.", error);
    }
  }
}

export function buildApplicationMenuTemplate({
  alwaysShowToolbarInFullScreen,
  language,
  onAlwaysShowToolbarInFullScreenChanged,
  onToggleFullScreen,
  platform
}: {
  alwaysShowToolbarInFullScreen: boolean;
  language: AppLanguage;
  onAlwaysShowToolbarInFullScreenChanged: (value: boolean) => void;
  onToggleFullScreen: () => void;
  platform: NodeJS.Platform;
}): MenuItemConstructorOptions[] {
  const text = labels[language];
  const appSubmenu: MenuItemConstructorOptions[] = platform === "darwin"
    ? [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    : [{ role: "quit" }];

  return [
    { label: text.app, submenu: appSubmenu },
    {
      label: text.edit,
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(platform === "darwin"
          ? [{ role: "pasteAndMatchStyle" as const }, { role: "delete" as const }]
          : [{ role: "delete" as const }]),
        { role: "selectAll" }
      ]
    },
    {
      label: text.view,
      submenu: [
        {
          checked: alwaysShowToolbarInFullScreen,
          click: (item) => onAlwaysShowToolbarInFullScreenChanged(item.checked),
          label: text.alwaysShow,
          type: "checkbox"
        },
        { type: "separator" },
        { id: APPLICATION_MENU_ZOOM_ITEM_IDS.reset, role: "resetZoom" },
        { id: APPLICATION_MENU_ZOOM_ITEM_IDS.in, role: "zoomIn" },
        { id: APPLICATION_MENU_ZOOM_ITEM_IDS.out, role: "zoomOut" },
        { type: "separator" },
        ...(platform === "darwin"
          ? [{
              accelerator: "Control+Command+F",
              click: onToggleFullScreen,
              label: text.toggleFullScreen
            }]
          : [{ role: "togglefullscreen" as const }])
      ]
    },
    {
      label: text.window,
      role: "windowMenu",
      submenu: [
        { role: "minimize" },
        ...(platform === "darwin" ? [{ role: "zoom" as const }] : []),
        { role: "close" },
        ...(platform === "darwin"
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : [])
      ]
    }
  ];
}
