export function createRuntimeTabsPageUrl(): string {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
    <title>Rion Studio</title>
  </head>
  <body><main id="runtime-tabs-root"></main></body>
</html>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}
