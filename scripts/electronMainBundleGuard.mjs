/** Reject a successful bundler exit that silently emitted an empty main entry. */
export function electronMainBundleGuard() {
  return {
    name: "rion-electron-main-bundle-guard",
    enforce: "post",
    generateBundle(_options, bundle) {
      const entries = Object.values(bundle).filter(output => output.type === "chunk" && output.isEntry);
      if (entries.length === 0 || entries.some(entry => typeof entry.code !== "string" || entry.code.trim().length === 0)) {
        throw new Error("Electron main build emitted an empty or missing executable entry.");
      }
    }
  };
}
