declare module "jsdom" {
  interface JSDOMOptions {
    runScripts?: "dangerously" | "outside-only";
    url?: string;
  }

  type JSDOMWindow = Window & typeof globalThis;

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: JSDOMWindow;
  }
}
