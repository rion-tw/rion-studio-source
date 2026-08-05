export interface PublicDocumentEntry {
  sourcePath: string;
  targetPath: string;
  content: Buffer;
  sha: string;
}

export interface RemoteTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

export interface PublicDocumentChange {
  action: "add" | "update" | "delete";
  path: string;
  entry?: PublicDocumentEntry;
}

export interface GitHubApi {
  request(endpoint: string, options?: {
    method?: string;
    body?: unknown;
  }): Promise<unknown>;
}

export const PUBLIC_DOCUMENT_FILES: readonly {
  sourcePath: string;
  targetPath: string;
}[];
export const PUBLIC_DOCUMENT_TREES: readonly {
  sourcePath: string;
  targetPath: string;
}[];

export function gitBlobSha(content: string | Buffer): string;
export function assertUniqueDocumentTargets(entries: readonly { targetPath: string }[]): void;
export function collectPublicDocuments(root?: string): Promise<PublicDocumentEntry[]>;
export function planPublicDocumentChanges(
  desiredEntries: readonly PublicDocumentEntry[],
  remoteEntries: readonly RemoteTreeEntry[]
): PublicDocumentChange[];
export function assertPublicDocumentsMatch(
  desiredEntries: readonly PublicDocumentEntry[],
  remoteEntries: readonly RemoteTreeEntry[]
): void;
export function shouldSynchronizeLatestTag(tag: string, latestTag: string): boolean;
export function synchronizePublicDocuments(input: {
  api?: GitHubApi;
  repository?: string;
  root?: string;
  tag: string;
  branch?: string;
}): Promise<
  | { status: "skipped-not-latest"; latestTag: string }
  | { status: "unchanged"; commitSha: string }
  | { status: "updated"; commitSha: string; changes: PublicDocumentChange[] }
>;
