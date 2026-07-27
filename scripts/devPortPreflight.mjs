import { createServer } from "node:net";

export const DEV_RENDERER_HOST = "127.0.0.1";
export const DEV_RENDERER_PORT = 5173;

export async function assertDevRendererPortAvailable(
  host = DEV_RENDERER_HOST,
  port = DEV_RENDERER_PORT,
  createServerImpl = createServer
) {
  await new Promise((resolve, reject) => {
    const server = createServerImpl();
    server.unref();
    server.once("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
        reject(new Error(
          `Rion Studio dev renderer cannot start because http://${host}:${port} is already in use. Stop the existing dev server or application and try again.`
        ));
        return;
      }
      reject(error);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}
