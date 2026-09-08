export { rendererCall } from "./renderer-bridge";

export function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the desktop E2E harness`);
  return value;
}
