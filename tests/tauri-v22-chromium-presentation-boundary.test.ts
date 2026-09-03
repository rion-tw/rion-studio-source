import { describe, expect, it } from "vitest";

import { readSourceTree } from "./helpers/readSourceTree";

describe("stable v22 Chromium presentation boundary", () => {
  it("terminally rejects every v23 Game Window UI effect, including presentation", async () => {
    const [source, activation] = await Promise.all([
      readSourceTree("src-tauri/src/system_runtime/section_18_apply.rs", "utf8"),
      readSourceTree("src-tauri/src/lib/section_01_activation.rs", "utf8")
    ]);
    const boundary = source.slice(
      source.indexOf("CoreEffectAction::EmbeddedProvisionWindowForTabMove"),
      source.indexOf("CoreEffectAction::RoleBrowserDataClearSession")
    );

    expect(boundary).toContain("CoreEffectAction::EmbeddedRetireProvisionedWindow");
    expect(boundary).toContain("CoreEffectAction::EmbeddedSetRuntimeWindowVisibility");
    expect(boundary).toContain("CoreEffectAction::EmbeddedSetRuntimeWindowPresentation");
    expect(boundary).toContain('"CHROMIUM_RUNTIME_UI_EFFECT_UNAVAILABLE"');
    expect(boundary).toContain(
      '"A Chromium Game Window UI effect is unavailable in the stable System WebView runtime."'
    );
    expect(boundary).not.toContain("Ok(None)");
    expect(activation).toContain(
      'CoreEffectAction::EmbeddedSetRuntimeWindowPresentation { .. }'
    );
    expect(activation).toContain('"embeddedSetRuntimeWindowPresentation"');
  });
});
