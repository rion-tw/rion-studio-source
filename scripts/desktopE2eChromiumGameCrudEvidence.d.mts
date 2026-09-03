export function validateChromiumGameCrudSqliteEvidence(
  phase: string,
  entities: Readonly<Record<string, readonly unknown[]>>
): Readonly<{
  deletedEditedGameCount?: number;
  editedGameId?: string;
  entityCounts: Readonly<Record<string, number>>;
  restartVerified: boolean;
}>;
