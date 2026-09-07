export function runProcess(command: string, args: string[], options?: {
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout?: number;
}): Promise<{ stdout: Buffer; pid: number; stderrBytes: number }>;
export function exactResponse(wire: Buffer, platform: string): {
  outcome: number;
  metadata: Record<string, unknown>;
};
