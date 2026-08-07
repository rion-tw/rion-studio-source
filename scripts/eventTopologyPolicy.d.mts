export interface EventTopologySource {
  path: string;
  source: string;
}

export interface EventTopologyException {
  id: string;
  paths: string[];
  mechanism: string;
  authoritativeEvent: string;
  reason: string;
  terminalOutcome: string;
  cleanup: string;
}

export interface EventTopologyLedger {
  schemaVersion: number;
  exceptions: EventTopologyException[];
}

export const EVENT_TOPOLOGY_LEDGER_PATH: string;

export function scanEventTopologySources(
  sources: EventTopologySource[],
  ledger: EventTopologyLedger
): string[];
