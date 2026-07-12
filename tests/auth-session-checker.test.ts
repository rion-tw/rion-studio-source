import { describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright";

import { AuthSessionChecker, classifyAuthSession } from "../src/main/auth/AuthSessionChecker";
import {
  LOGIN_STORAGE_EXPRESSION,
  isPersistedLoginStorageReady,
  type LoginStorageSnapshot
} from "../src/main/auth/loginEvidence";
import type { Role } from "../src/shared/types";

const role: Role = {
  id: "role-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  windowWidth: 1280,
  windowHeight: 720,
  notes: "",
  launchPreset: "performance",
  authState: "login_required",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("AuthSessionChecker", () => {
  it("classifies Google unsupported-browser pages as auth_failed", () => {
    expect(classifyAuthSession("https://roles.google.com/", "This browser or app may not be secure")).toMatchObject({
      authState: "auth_failed"
    });
  });

  it("classifies Google login redirects as login_required", () => {
    expect(classifyAuthSession("https://roles.google.com/signin/v2/identifier", "")).toMatchObject({
      authState: "login_required"
    });
  });

  it("classifies Facebook login redirects as login_required", () => {
    expect(classifyAuthSession("https://www.facebook.com/dialog/oauth", "")).toMatchObject({
      authState: "login_required"
    });
  });

  it("classifies target pages with login prompts as login_required", () => {
    expect(
      classifyAuthSession(
        "https://example.com/play",
        "Continue with Facebook",
        isPersistedLoginStorageReady(createStorageSnapshot({ cookies: { sid: "session-1" } }))
      )
    ).toMatchObject({
      authState: "login_required"
    });
    expect(
      classifyAuthSession(
        "https://example.com/play",
        "使用 Google 登入",
        isPersistedLoginStorageReady(createStorageSnapshot({ cookies: { sid: "session-1" } }))
      )
    ).toMatchObject({
      authState: "login_required"
    });
  });

  it("classifies target pages without persisted evidence as login_required", () => {
    expect(classifyAuthSession("https://example.com/play", "")).toMatchObject({
      authState: "login_required",
      message: "Login is still required. No persisted login session was found."
    });
  });

  it("classifies target pages with auth-like cookies as authenticated", () => {
    expect(classifyStorageSnapshot(createStorageSnapshot({ cookies: { sid: "session-1" } }))).toMatchObject({
      authState: "authenticated"
    });
  });

  it("classifies target pages with auth-like localStorage as authenticated", () => {
    expect(
      classifyStorageSnapshot(createStorageSnapshot({ localStorage: { authToken: "token-1" } }))
    ).toMatchObject({
      authState: "authenticated"
    });
  });

  it("classifies target pages with auth-like sessionStorage as authenticated", () => {
    expect(
      classifyStorageSnapshot(createStorageSnapshot({ sessionStorage: { currentUser: "user-1" } }))
    ).toMatchObject({
      authState: "authenticated"
    });
  });

  it("classifies target pages with IndexedDB session fingerprints as authenticated", () => {
    expect(
      classifyStorageSnapshot(
        createStorageSnapshot({
          indexedDb: {
            app_state_fingerprint: "v1:ready:1:fingerprint"
          }
        })
      )
    ).toMatchObject({
      authState: "authenticated"
    });
  });

  it("does not classify tracking-only storage as authenticated", () => {
    expect(
      classifyStorageSnapshot(
        createStorageSnapshot({
          cookies: { _ga: "GA1.1.test" },
          localStorage: { _fbp: "tracking" },
          indexedDb: { _gcl_au: "tracking" }
        })
      )
    ).toMatchObject({
      authState: "login_required",
      message: "Login is still required. No persisted login session was found."
    });
  });

  it("checks the role storage and returns login_required when no persisted session exists", async () => {
    const harness = createCheckHarness(createStorageSnapshot());

    await expect(harness.checker.check(role)).resolves.toMatchObject({
      authState: "login_required",
      message: "Login is still required. No persisted login session was found."
    });
    expect(harness.roleStore.ensureBrowserUserDataDir).toHaveBeenCalledWith(role.id);
    expect(harness.browserContext.cookies).toHaveBeenCalledWith(role.launchUrl);
    expect(harness.page.evaluate).toHaveBeenCalledWith(LOGIN_STORAGE_EXPRESSION);
    expect(harness.context.close).toHaveBeenCalledTimes(1);
  });

  it("checks the role storage and authenticates when persisted session evidence exists", async () => {
    const harness = createCheckHarness(createStorageSnapshot({ cookies: { sid: "session-1" } }));

    await expect(harness.checker.check(role)).resolves.toMatchObject({
      authState: "authenticated",
      finalUrl: role.launchUrl
    });
    expect(harness.browserContext.cookies).toHaveBeenCalledWith(role.launchUrl);
    expect(harness.page.evaluate).toHaveBeenCalledWith(LOGIN_STORAGE_EXPRESSION);
    expect(harness.context.close).toHaveBeenCalledTimes(1);
  });
});

function classifyStorageSnapshot(snapshot: LoginStorageSnapshot): ReturnType<typeof classifyAuthSession> {
  return classifyAuthSession(
    "https://example.com/play",
    snapshot.bodyText,
    isPersistedLoginStorageReady(snapshot)
  );
}

function createStorageSnapshot(overrides: Partial<LoginStorageSnapshot> = {}): LoginStorageSnapshot {
  return {
    cookies: {},
    localStorage: {},
    sessionStorage: {},
    indexedDb: {},
    bodyText: "",
    ...overrides
  };
}

function createCheckHarness(snapshot: LoginStorageSnapshot, finalUrl = role.launchUrl): {
  checker: AuthSessionChecker;
  roleStore: {
    ensureBrowserUserDataDir: ReturnType<typeof vi.fn>;
  };
  browserContext: {
    cookies: ReturnType<typeof vi.fn>;
  };
  page: {
    evaluate: ReturnType<typeof vi.fn>;
  };
  context: {
    close: ReturnType<typeof vi.fn>;
  };
} {
  const browserContext = {
    cookies: vi.fn().mockResolvedValue(
      Object.entries(snapshot.cookies).map(([name, value]) => ({
        name,
        value
      }))
    )
  };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(finalUrl),
    context: vi.fn().mockReturnValue(browserContext),
    evaluate: vi.fn().mockResolvedValue({
      localStorage: snapshot.localStorage,
      sessionStorage: snapshot.sessionStorage,
      indexedDb: snapshot.indexedDb,
      bodyText: snapshot.bodyText
    })
  };
  const context = {
    pages: vi.fn().mockReturnValue([page]),
    close: vi.fn().mockResolvedValue(undefined)
  };
  const roleStore = {
    ensureBrowserUserDataDir: vi.fn().mockResolvedValue("/tmp/rion-studio/role-1/browser")
  };
  const launchPersistentContext = vi.fn().mockResolvedValue(context as unknown as BrowserContext);

  return {
    checker: new AuthSessionChecker(roleStore, launchPersistentContext),
    roleStore,
    browserContext,
    page,
    context
  };
}
