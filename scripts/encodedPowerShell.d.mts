export interface EncodedPowerShellJsonInvocation {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly standardInput: string;
  readonly standardInputArguments: readonly string[];
}

export function createEncodedPowerShellJsonInvocation(
  trustedScript: string,
  payload: Readonly<Record<string, unknown>>
): EncodedPowerShellJsonInvocation;

export function runEncodedPowerShellJson(
  trustedScript: string,
  payload: Readonly<Record<string, unknown>>,
  options: {
    readonly timeoutMilliseconds: number;
  }
): Promise<string>;
