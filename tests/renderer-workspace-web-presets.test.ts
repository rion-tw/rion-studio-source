import { describe, expect, it } from "vitest";

import {
  resolveWorkspaceWebPreset,
  workspaceWebPresetGroups,
  workspaceWebPresets
} from "../src/renderer/src/features/workspaces/workspaceWebPresets";

describe("workspace Website presets", () => {
  it("defines 26 grouped, ordered, complete, and unique HTTP(S) destinations", () => {
    expect(workspaceWebPresetGroups.map(group => [group.id, group.presets.map(preset => preset.id)])).toEqual([
      ["media", ["youtube", "netflix", "disney-plus", "prime-video", "spotify", "crunchyroll", "apple-music", "line-tv", "friday-video", "myvideo", "apple-tv", "iqiyi", "wetv", "youku", "mango-tv"]],
      ["live", ["twitch", "kick"]],
      ["social", ["tiktok", "instagram", "reddit", "x", "facebook", "threads", "discord", "bahamut"]],
      ["other", ["wikipedia"]]
    ]);
    expect(workspaceWebPresetGroups.flatMap(group => group.presets)).toEqual(workspaceWebPresets);
    expect(new Set(workspaceWebPresets.map((preset) => preset.id)).size).toBe(26);
    expect(new Set(workspaceWebPresets.map((preset) => preset.startUrl)).size).toBe(26);
    const hostnames = workspaceWebPresets.flatMap((preset) => preset.hostnames);
    expect(new Set(hostnames).size).toBe(hostnames.length);

    for (const preset of workspaceWebPresets) {
      expect(preset.name.trim()).not.toBe("");
      expect(preset.brandImageUrl).not.toBe("");
      expect(preset.hostnames.length).toBeGreaterThan(0);
      expect(["http:", "https:"]).toContain(new URL(preset.startUrl).protocol);
      expect(resolveWorkspaceWebPreset(preset.startUrl)?.id).toBe(preset.id);
    }
  });

  it.each([
    ["https://www.youtube.com/", "youtube"],
    ["https://studio.youtube.com/channel/test", "youtube"],
    ["https://youtu.be/example", "youtube"],
    ["https://m.twitch.tv/example", "twitch"],
    ["https://open.spotify.com/playlist/test", "spotify"],
    ["https://old.reddit.com/r/test", "reddit"],
    ["https://mobile.twitter.com/example", "x"],
    ["https://x.com/example", "x"],
    ["https://music.apple.com/tw/new", "apple-music"],
    ["https://tv.apple.com/tw", "apple-tv"],
    ["https://video.friday.tw/drama", "friday-video"],
    ["https://www.iq.com/drama?lang=zh_tw", "iqiyi"],
    ["https://forum.gamer.com.tw/", "bahamut"],
    ["https://www.threads.net/@test", "threads"],
    ["https://zh.wikipedia.org/wiki/Test", "wikipedia"]
  ])("resolves %s as %s", (startUrl, presetId) => {
    expect(resolveWorkspaceWebPreset(startUrl)?.id).toBe(presetId);
  });

  it.each([
    "",
    "not a URL",
    "ftp://youtube.com/video",
    "https://example.com/",
    "https://youtube.com.evil.test/",
    "https://notyoutube.com/",
    "https://twitter.com.attacker.test/",
    "https://youtu.be.attacker.test/",
    "https://apple.com/",
    "https://support.apple.com/",
    "https://music.apple.com.evil.test/",
    "https://nottv.apple.com/",
    "https://www.friday.tw/",
    "https://www.iqiyi.com/",
    "https://www.youku.com/"
  ])("does not classify an invalid, unknown, or deceptive URL: %s", (startUrl) => {
    expect(resolveWorkspaceWebPreset(startUrl)).toBeUndefined();
  });
});
