export interface ElectronWebContentsPort {
  readonly id: number;
  isDestroyed: () => boolean;
  send: (channel: string, ...args: unknown[]) => void;
}

export interface ElectronWindowPort {
  readonly id: number;
  readonly webContents: ElectronWebContentsPort;
  isDestroyed: () => boolean;
}

export interface ElectronIpcInvokeEventPort {
  readonly sender: ElectronWebContentsPort;
}

export interface ElectronIpcEventPort {
  readonly sender: ElectronWebContentsPort;
}

export type ElectronIpcInvokeListener = (
  event: ElectronIpcInvokeEventPort,
  request: unknown
) => Promise<unknown>;
export type ElectronIpcNotifyListener = (
  event: ElectronIpcEventPort,
  request: unknown
) => void;

export interface ElectronIpcMainPort {
  handle: (channel: string, listener: ElectronIpcInvokeListener) => void;
  removeHandler: (channel: string) => void;
  on: (channel: string, listener: ElectronIpcNotifyListener) => void;
  removeListener: (channel: string, listener: ElectronIpcNotifyListener) => void;
}
