(() => {
  const style = document.createElement("style");
  style.dataset.rionCanvasScrollLock = "";
  style.textContent = `
html:has(#canvas),
html:has(#canvas) body {
  overflow: hidden !important;
  overflow-x: hidden !important;
  overflow-y: hidden !important;
  overscroll-behavior: none !important;
}
`;

  const attach = () => {
    const root = document.head ?? document.documentElement;
    if (!root || style.isConnected) return false;
    root.append(style);
    return true;
  };

  if (!attach()) {
    document.addEventListener("readystatechange", attach, { once: true });
  }
})();
