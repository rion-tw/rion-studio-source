// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ replacePage: false }));

vi.mock("@wdio/globals", () => {
  function select(selector: string, root: ParentNode = document): Element | null {
    if (selector.startsWith("//")) {
      return document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE)
        .singleNodeValue as Element | null;
    }
    const text = /^(h2|button)=(.*)$/.exec(selector);
    if (text) return [...root.querySelectorAll(text[1])]
      .find((element) => element.textContent === text[2]) ?? null;
    return root.querySelector(selector);
  }
  function element(selector: string, root: ParentNode = document) {
    const node = select(selector, root);
    return { node, selector, $: (child: string) => element(child, node ?? document.createElement("div")) };
  }
  return {
    $: element,
    expect: (target: ReturnType<typeof element>) => ({
      async toBeDisplayed() {
        expect(target.node?.isConnected, target.selector).toBe(true);
        expect(target.node?.hasAttribute("hidden")).toBe(false);
        if (state.replacePage && target.selector === ".app-page") {
          state.replacePage = false;
          document.body.innerHTML = '<section class="app-page"><h2>No roles yet</h2><button>Create role</button></section>';
        }
      },
      async toHaveText(text: string) { expect(target.node?.textContent).toBe(text); },
      not: { async toExist() { expect(target.node).toBeNull(); } }
    })
  };
});

import { assertSeedPrimaryPage } from "./primary-navigation";

afterEach(() => { state.replacePage = false; document.body.innerHTML = ""; });

describe.each(["darwin", "win32"])("primary navigation DOM assertions (%s)", () => {
  it("resolves the current page after the route replaces the parent element", async () => {
    document.body.innerHTML = '<section class="app-page"><header class="app-page-header">Games</header></section>';
    state.replacePage = true;
    await expect(assertSeedPrimaryPage("/roles")).resolves.toBeUndefined();
  });

  it("still rejects a wrong empty-state title", async () => {
    document.body.innerHTML = '<section class="app-page"><h2>No workspaces yet</h2><button>Create role</button></section>';
    await expect(assertSeedPrimaryPage("/roles")).rejects.toThrow();
  });

  it("still rejects an absent or hidden primary action", async () => {
    document.body.innerHTML = '<section class="app-page"><h2>No roles yet</h2><button hidden>Create role</button></section>';
    await expect(assertSeedPrimaryPage("/roles")).rejects.toThrow();
    document.querySelector("button")?.remove();
    await expect(assertSeedPrimaryPage("/roles")).rejects.toThrow();
  });

  it("still rejects a header on an empty primary page", async () => {
    document.body.innerHTML = '<section class="app-page"><header class="app-page-header">Roles</header><h2>No roles yet</h2><button>Create role</button></section>';
    await expect(assertSeedPrimaryPage("/roles")).rejects.toThrow();
  });
});
