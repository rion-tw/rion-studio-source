export interface ElectronMainWindowCloseEventPort {
  preventDefault: () => void;
}

export interface ElectronMainWindowClosePolicyInput {
  hide: () => void;
  isFinalCloseAdmitted: () => boolean;
}

export function applyElectronMainWindowClosePolicy(
  input: ElectronMainWindowClosePolicyInput,
  event: ElectronMainWindowCloseEventPort
): "admitted" | "hidden" {
  if (input.isFinalCloseAdmitted()) return "admitted";
  event.preventDefault();
  input.hide();
  return "hidden";
}
