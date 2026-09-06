export function isDarwinProcessGroupAlive(processGroupId: number, operations?: {
  kill?: (pid: number, signal: 0) => unknown;
  readGroupSnapshot?: (processGroupId: number) => string;
}): boolean;
