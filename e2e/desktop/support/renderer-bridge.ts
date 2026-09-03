import { browser } from "@wdio/globals";

import type { RionStudioApi } from "../../../src/shared/api";

interface RendererCallResult {
  error?: string;
  ok: boolean;
  value?: unknown;
}

export async function rendererCall<K extends keyof RionStudioApi>(
  method: K,
  ...args: Parameters<RionStudioApi[K]>
): Promise<Awaited<ReturnType<RionStudioApi[K]>>> {
  const result = await browser.executeAsync(
    (
      methodName: string,
      methodArgs: unknown[],
      done: (result: RendererCallResult) => void
    ) => {
      type AsyncMethod = (...values: unknown[]) => Promise<unknown>;
      const api = window.rionStudio as unknown as Record<string, AsyncMethod>;
      const callable = api[methodName];
      if (!callable) {
        done({ error: `Unknown renderer bridge method: ${methodName}`, ok: false });
        return;
      }
      void callable(...methodArgs).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => done({
          error: error instanceof Error ? error.message : String(error),
          ok: false
        })
      );
    },
    String(method),
    args
  ) as RendererCallResult;
  if (!result.ok) throw new Error(result.error ?? `Renderer bridge method ${String(method)} failed`);
  return result.value as Awaited<ReturnType<RionStudioApi[K]>>;
}
