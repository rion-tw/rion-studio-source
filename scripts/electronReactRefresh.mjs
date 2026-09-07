import react from "@vitejs/plugin-react";

/** Serve Fast Refresh as a same-origin module under the renderer's strict CSP. */
export function electronReactRefresh() {
  const modulePath = "/@rion-react-refresh-preamble";
  let preamble;
  return {
    name: "rion-electron-react-refresh",
    apply: "serve",
    configResolved(config) {
      preamble = react.preambleCode.replace("__BASE__", config.base);
    },
    resolveId(id) {
      if (id === modulePath) return id;
    },
    load(id) {
      if (id === modulePath) return preamble;
    },
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return html.replace(
          `<script type="module">${preamble}</script>`,
          `<script type="module" src="${modulePath}"></script>`
        );
      }
    }
  };
}
