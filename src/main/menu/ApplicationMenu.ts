import { Menu, type MenuItemConstructorOptions } from "electron";

import type { AppLanguage } from "../../shared/types";

type MenuLabelKey = "app" | "edit" | "view" | "window" | "alwaysShow";

const labels: Record<AppLanguage, Record<MenuLabelKey, string>> = {
  en: {
    app: "Rion Studio",
    edit: "Edit",
    view: "View",
    window: "Window",
    alwaysShow: "Always Show Toolbar in Full Screen"
  },
  "zh-TW": {
    app: "Rion Studio",
    edit: "編輯",
    view: "顯示",
    window: "視窗",
    alwaysShow: "全螢幕時一律顯示工具列"
  },
  "zh-CN": {
    app: "Rion Studio",
    edit: "编辑",
    view: "视图",
    window: "窗口",
    alwaysShow: "全屏时始终显示工具栏"
  },
  ja: {
    app: "Rion Studio",
    edit: "編集",
    view: "表示",
    window: "ウインドウ",
    alwaysShow: "フルスクリーンでツールバーを常に表示"
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
}

export class ApplicationMenuController {
  private alwaysShowToolbarInFullScreen: boolean;
  private language: AppLanguage;
  private readonly logger: Pick<Console, "error">;

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

  private rebuild(): void {
    const menu = Menu.buildFromTemplate(buildApplicationMenuTemplate({
      alwaysShowToolbarInFullScreen: this.alwaysShowToolbarInFullScreen,
      language: this.language,
      onAlwaysShowToolbarInFullScreenChanged: (value) => void this.updateAlwaysShow(value),
      platform: this.options.platform ?? process.platform
    }));
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
  platform
}: {
  alwaysShowToolbarInFullScreen: boolean;
  language: AppLanguage;
  onAlwaysShowToolbarInFullScreenChanged: (value: boolean) => void;
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
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
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
