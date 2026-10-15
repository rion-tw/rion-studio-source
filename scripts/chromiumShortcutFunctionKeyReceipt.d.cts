export interface FunctionKeyProbeEvent {
  readonly type: string;
  readonly code: string;
  readonly trusted: boolean;
  readonly repeat: boolean;
  readonly shift: boolean;
  readonly control: boolean;
}
export interface FunctionKeyProbeReceipt {
  readonly caseId: string;
  readonly status: "received" | "indeterminate" | "submission-failed";
  readonly events: readonly FunctionKeyProbeEvent[];
}
export function sampleFunctionKeyCase(
  contents: { executeJavaScript(script: string): Promise<unknown> },
  caseId: string,
  submit: () => Promise<unknown>,
  deadlineMs?: number
): Promise<Readonly<{ receipt: FunctionKeyProbeReceipt; submission: unknown }>>;
