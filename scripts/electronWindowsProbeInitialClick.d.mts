export function clickWindowsProbeCaption(input: Readonly<{
  processId: number;
  nativeWindowHandle: string;
}>, port?: Readonly<{
  platform: string;
  run: (script: string, payload: Record<string, unknown>, options: {
    timeoutMilliseconds: number;
  }) => Promise<string>;
}>): Promise<unknown>;
