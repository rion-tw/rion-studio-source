export type RustBoundaryTargetCommit = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export interface RustBoundaryDebt {
  key: string;
  targetCommit: RustBoundaryTargetCommit;
  reason: string;
}

/**
 * Exact production debt present when the 2.1 thin-TypeScript migration began.
 *
 * Architecture tests compare compiler-AST findings with this manifest in both
 * directions. New findings therefore fail immediately, while removing an item
 * requires deleting its manifest entry in the commit that transfers ownership.
 */
export const RUST_OWNED_MAIN_DEBT = {
  authoritativeMaps: [],
  coreIntervals: [],
  nodeIoImports: [],
  orchestrationMethods: [],
  promiseTails: [],
  specializedNapiMethods: []
} satisfies Record<string, RustBoundaryDebt[]>;
