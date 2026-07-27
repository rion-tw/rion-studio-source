export declare const DEV_RENDERER_HOST = "127.0.0.1";
export declare const DEV_RENDERER_PORT = 5173;

export declare function assertDevRendererPortAvailable(
  host?: string,
  port?: number,
  createServerImpl?: typeof import("node:net").createServer
): Promise<void>;
