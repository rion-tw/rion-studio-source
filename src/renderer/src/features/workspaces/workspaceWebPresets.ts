import catalog from "../../../../shared/workspaceWebCatalog.json";
import categories from "../../../../shared/workspaceWebCategories.json";
import appleMusicBrandImageUrl from "../../assets/workspace-web/apple-music.png";
import appleTvBrandImageUrl from "../../assets/workspace-web/apple-tv.png";
import bahamutBrandImageUrl from "../../assets/workspace-web/bahamut.svg";
import crunchyrollBrandImageUrl from "../../assets/workspace-web/crunchyroll.svg";
import discordBrandImageUrl from "../../assets/workspace-web/discord.ico";
import disneyPlusBrandImageUrl from "../../assets/workspace-web/disney-plus.jpg";
import facebookBrandImageUrl from "../../assets/workspace-web/facebook.ico";
import fridayVideoBrandImageUrl from "../../assets/workspace-web/friday-video.ico";
import instagramBrandImageUrl from "../../assets/workspace-web/instagram.svg";
import iqiyiBrandImageUrl from "../../assets/workspace-web/iqiyi.png";
import kickBrandImageUrl from "../../assets/workspace-web/kick.svg";
import lineTvBrandImageUrl from "../../assets/workspace-web/line-tv.png";
import mangoTvBrandImageUrl from "../../assets/workspace-web/mango-tv.png";
import myvideoBrandImageUrl from "../../assets/workspace-web/myvideo.ico";
import netflixBrandImageUrl from "../../assets/workspace-web/netflix.svg";
import primeVideoBrandImageUrl from "../../assets/workspace-web/prime-video.png";
import redditBrandImageUrl from "../../assets/workspace-web/reddit.svg";
import spotifyBrandImageUrl from "../../assets/workspace-web/spotify.svg";
import threadsBrandImageUrl from "../../assets/workspace-web/threads.webp";
import tiktokBrandImageUrl from "../../assets/workspace-web/tiktok.svg";
import twitchBrandImageUrl from "../../assets/workspace-web/twitch.svg";
import wetvBrandImageUrl from "../../assets/workspace-web/wetv.ico";
import wikipediaBrandImageUrl from "../../assets/workspace-web/wikipedia.png";
import xBrandImageUrl from "../../assets/workspace-web/x.svg";
import youkuBrandImageUrl from "../../assets/workspace-web/youku.png";
import youtubeBrandImageUrl from "../../assets/workspace-web/youtube.svg";
import type { Translator } from "../../i18n";

type WorkspaceWebPresetId =
  | "youtube"
  | "netflix"
  | "disney-plus"
  | "prime-video"
  | "spotify"
  | "crunchyroll"
  | "apple-music"
  | "line-tv"
  | "friday-video"
  | "myvideo"
  | "apple-tv"
  | "iqiyi"
  | "wetv"
  | "youku"
  | "mango-tv"
  | "twitch"
  | "kick"
  | "tiktok"
  | "instagram"
  | "reddit"
  | "x"
  | "facebook"
  | "threads"
  | "discord"
  | "bahamut"
  | "wikipedia";

export type WorkspaceWebCategoryId = keyof typeof categories;

export interface WorkspaceWebPreset {
  category: WorkspaceWebCategoryId;
  nameKey?: Parameters<Translator>[0];
  brandImagePresentation?: "cover";
  brandImageUrl: string;
  hostnames: readonly string[];
  id: WorkspaceWebPresetId;
  name: string;
  startUrl: string;
}

const brandImages: Record<string, string> = {
  "mango-tv.png": mangoTvBrandImageUrl,
  "youku.png": youkuBrandImageUrl,
  "wetv.ico": wetvBrandImageUrl,
  "iqiyi.png": iqiyiBrandImageUrl,
  "apple-tv.png": appleTvBrandImageUrl,
  "myvideo.ico": myvideoBrandImageUrl,
  "friday-video.ico": fridayVideoBrandImageUrl,
  "line-tv.png": lineTvBrandImageUrl,
  "wikipedia.png": wikipediaBrandImageUrl,
  "bahamut.svg": bahamutBrandImageUrl,
  "discord.ico": discordBrandImageUrl,
  "threads.webp": threadsBrandImageUrl,
  "facebook.ico": facebookBrandImageUrl,
  "apple-music.png": appleMusicBrandImageUrl,
  "crunchyroll.svg": crunchyrollBrandImageUrl,
  "disney-plus.jpg": disneyPlusBrandImageUrl,
  "instagram.svg": instagramBrandImageUrl,
  "kick.svg": kickBrandImageUrl,
  "netflix.svg": netflixBrandImageUrl,
  "prime-video.png": primeVideoBrandImageUrl,
  "reddit.svg": redditBrandImageUrl,
  "spotify.svg": spotifyBrandImageUrl,
  "tiktok.svg": tiktokBrandImageUrl,
  "twitch.svg": twitchBrandImageUrl,
  "x.svg": xBrandImageUrl,
  "youtube.svg": youtubeBrandImageUrl
};

export const workspaceWebPresets: readonly WorkspaceWebPreset[] = catalog.map((preset) => ({
  ...preset,
  category: preset.category as WorkspaceWebCategoryId,
  nameKey: preset.nameKey as WorkspaceWebPreset["nameKey"],
  id: preset.id as WorkspaceWebPresetId,
  brandImageUrl: brandImages[preset.brandAsset]!,
  ...(preset.brandImagePresentation === "cover" ? { brandImagePresentation: "cover" as const } : { brandImagePresentation: undefined })
}));

export const workspaceWebPresetGroups = Object.entries(categories).map(([id, labelKey]) => ({
  id: id as WorkspaceWebCategoryId,
  labelKey: labelKey as `workspaces.webCategory.${WorkspaceWebCategoryId}`,
  presets: workspaceWebPresets.filter((preset) => preset.category === id)
}));

export function workspaceWebPresetName(preset: WorkspaceWebPreset, t: Translator): string {
  return preset.nameKey ? t(preset.nameKey) : preset.name;
}

export function resolveWorkspaceWebPreset(startUrl: string): WorkspaceWebPreset | undefined {
  let hostname: string;
  try {
    const url = new URL(startUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return undefined;
  }

  return workspaceWebPresets.find((preset) =>
    preset.hostnames.some((candidate) =>
      hostname === candidate || hostname.endsWith(`.${candidate}`)
    )
  );
}
