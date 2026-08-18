export interface ContextReport {
  changeKind: string;
  paths: string[];
  areas: Array<{ id: string; reasons: string[] }>;
  contextFiles: string[];
  canonicalDocs: string[];
  risks: string[];
  fastChecks: string[];
  requiredChecks: string[];
  platforms: { required: string[]; local: string[]; pending: string[] };
  e2e: {
    features: string[];
    candidateJourneys: string[];
    omissionReason: string | null;
  };
}

export function loadContextMap(root?: string): Promise<Record<string, unknown>>;
export function matchesGlob(path: string, glob: string): boolean;
export function analyzeContext(options: {
  root?: string;
  contextMap?: Record<string, unknown>;
  intents?: string[];
  paths?: string[];
  changeKind?: string;
  hostPlatform?: NodeJS.Platform;
}): Promise<ContextReport>;
export function collectChangedPaths(root?: string, base?: string): Promise<string[]>;
export function validateAiContext(root?: string): Promise<string[]>;
export function formatContextReport(report: ContextReport): string;
