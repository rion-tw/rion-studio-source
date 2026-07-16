import { type JSX } from "react";

import { useAppWindowStateSync } from "../hooks/useAppWindowStateSync";

export function AppWindowStateSync(): JSX.Element | null {
  useAppWindowStateSync();
  return null;
}
