import { createContext, useContext } from "react";

export interface ConfirmationOptions {
  cancelLabel: string;
  confirmLabel: string;
  confirmDisabled?: boolean;
  description: string;
  title: string;
  tone?: "default" | "destructive";
}

export type Confirm = (options: ConfirmationOptions) => Promise<boolean>;

export const ConfirmationContext = createContext<Confirm | null>(null);

export function useConfirmation(): Confirm {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) {
    throw new Error("useConfirmation must be used within ConfirmationProvider.");
  }

  return confirm;
}
