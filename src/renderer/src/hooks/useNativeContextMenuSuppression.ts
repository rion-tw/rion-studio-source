import { useEffect } from "react";

export function useNativeContextMenuSuppression(): void {
  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };

    document.addEventListener("contextmenu", preventNativeContextMenu);
    return () => document.removeEventListener("contextmenu", preventNativeContextMenu);
  }, []);
}
