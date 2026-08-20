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

export const workspaceWebPresets: readonly WorkspaceWebPreset[] = [
  {
    id: "youtube",
    name: "YouTube",
    startUrl: "https://www.youtube.com/",
    hostnames: ["youtube.com", "youtu.be"],
    brandImageUrl: youtubeBrandImageUrl
  },
  {
    id: "netflix",
    name: "Netflix",
    startUrl: "https://www.netflix.com/",
    hostnames: ["netflix.com"],
    brandImageUrl: netflixBrandImageUrl
  },
  {
    id: "twitch",
    name: "Twitch",
    startUrl: "https://www.twitch.tv/",
    hostnames: ["twitch.tv"],
    brandImageUrl: twitchBrandImageUrl
  },
  {
    id: "disney-plus",
    name: "Disney+",
    startUrl: "https://www.disneyplus.com/",
    hostnames: ["disneyplus.com"],
    brandImageUrl: disneyPlusBrandImageUrl,
    brandImagePresentation: "cover"
  },
  {
    id: "prime-video",
    name: "Prime Video",
    startUrl: "https://www.primevideo.com/",
    hostnames: ["primevideo.com"],
    brandImageUrl: primeVideoBrandImageUrl
  },
  {
    id: "spotify",
    name: "Spotify",
    startUrl: "https://open.spotify.com/",
    hostnames: ["spotify.com"],
    brandImageUrl: spotifyBrandImageUrl
  },
  {
    id: "crunchyroll",
    name: "Crunchyroll",
    startUrl: "https://www.crunchyroll.com/",
    hostnames: ["crunchyroll.com"],
    brandImageUrl: crunchyrollBrandImageUrl
  },
  {
    id: "kick",
    name: "Kick",
    startUrl: "https://kick.com/",
    hostnames: ["kick.com"],
    brandImageUrl: kickBrandImageUrl
  },
  {
    id: "tiktok",
    name: "TikTok",
    startUrl: "https://www.tiktok.com/",
    hostnames: ["tiktok.com"],
    brandImageUrl: tiktokBrandImageUrl
  },
  {
    id: "instagram",
    name: "Instagram",
    startUrl: "https://www.instagram.com/",
    hostnames: ["instagram.com"],
    brandImageUrl: instagramBrandImageUrl
  },
  {
    id: "reddit",
    name: "Reddit",
    startUrl: "https://www.reddit.com/",
    hostnames: ["reddit.com"],
    brandImageUrl: redditBrandImageUrl
  },
  {
    id: "x",
    name: "X",
    startUrl: "https://x.com/",
    hostnames: ["x.com", "twitter.com"],
    brandImageUrl: xBrandImageUrl
  }
];

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
