import catalog from "../../../../shared/workspaceWebCatalog.json";
import crunchyrollBrandImageUrl from "../../assets/workspace-web/crunchyroll.svg";
import disneyPlusBrandImageUrl from "../../assets/workspace-web/disney-plus.jpg";
import instagramBrandImageUrl from "../../assets/workspace-web/instagram.svg";
import kickBrandImageUrl from "../../assets/workspace-web/kick.svg";
import netflixBrandImageUrl from "../../assets/workspace-web/netflix.svg";
import primeVideoBrandImageUrl from "../../assets/workspace-web/prime-video.png";
import redditBrandImageUrl from "../../assets/workspace-web/reddit.svg";
import spotifyBrandImageUrl from "../../assets/workspace-web/spotify.svg";
import tiktokBrandImageUrl from "../../assets/workspace-web/tiktok.svg";
import twitchBrandImageUrl from "../../assets/workspace-web/twitch.svg";
import xBrandImageUrl from "../../assets/workspace-web/x.svg";
import youtubeBrandImageUrl from "../../assets/workspace-web/youtube.svg";

type WorkspaceWebPresetId =
  | "youtube"
  | "netflix"
  | "twitch"
  | "disney-plus"
  | "prime-video"
  | "spotify"
  | "crunchyroll"
  | "kick"
  | "tiktok"
  | "instagram"
  | "reddit"
  | "x";

export interface WorkspaceWebPreset {
  brandImagePresentation?: "cover";
  brandImageUrl: string;
  hostnames: readonly string[];
  id: WorkspaceWebPresetId;
  name: string;
  startUrl: string;
}

const brandImages: Record<string, string> = {
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
  id: preset.id as WorkspaceWebPresetId,
  brandImageUrl: brandImages[preset.brandAsset]!,
  ...(preset.brandImagePresentation === "cover" ? { brandImagePresentation: "cover" as const } : { brandImagePresentation: undefined })
}));

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
