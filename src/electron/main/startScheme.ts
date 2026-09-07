import { protocol } from "electron";

// Must run before app.ready; only global-web sessions install its bounded handler.
protocol.registerSchemesAsPrivileged([
  { scheme: "rion-start", privileges: { standard: true, secure: true } }
]);
