import { describe, expect, it } from "vitest";

import {
  resolveWorkspaceWebPreset,
  workspaceWebPresets
} from "../src/renderer/src/features/workspaces/workspaceWebPresets";

describe("workspace Web App presets", () => {
  it("defines twelve ordered, complete, and unique HTTP(S) destinations", () => {
    expect(workspaceWebPresets.map((preset) => preset.name)).toEqual([
      "YouTube",
      "Netflix",
      "Twitch",
      "Disney+",
      "Prime Video",
      "Spotify",
      "Crunchyroll",
      "Kick",
      "TikTok",
      "Instagram",
      "Reddit",
      "X"
    ]);
    expect(new Set(workspaceWebPresets.map((preset) => preset.id)).size).toBe(12);
    expect(new Set(workspaceWebPresets.map((preset) => preset.startUrl)).size).toBe(12);
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
    ["https://x.com/example", "x"]
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
    "https://youtu.be.attacker.test/"
  ])("does not classify an invalid, unknown, or deceptive URL: %s", (startUrl) => {
    expect(resolveWorkspaceWebPreset(startUrl)).toBeUndefined();
  });
});
