import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

export interface WindowsGraphicsEvent {
  eventId: number;
  provider: string;
  timestamp: string;
}

export interface WindowsGraphicsEventCollection {
  available: boolean;
  events: WindowsGraphicsEvent[];
  error?: string;
}

export interface WindowsGraphicsEventCollectorOptions {
  execFile?: (
    file: string,
    args: string[]
  ) => Promise<{ stderr?: string; stdout: string }>;
  platform?: NodeJS.Platform;
}

const DISPLAY_DRIVER_EVENT_ID = 4101;
const MAX_EVENTS = 24;

export class WindowsGraphicsEventCollector {
  private readonly execFile: NonNullable<WindowsGraphicsEventCollectorOptions["execFile"]>;
  private readonly platform: NodeJS.Platform;

  constructor(options: WindowsGraphicsEventCollectorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.execFile = options.execFile ?? (async (file, args) => {
      const result = await promisify(execFileCallback)(file, args, {
        encoding: "utf8",
        windowsHide: true
      });
      return { stderr: result.stderr, stdout: result.stdout };
    });
  }

  async collect(since: Date): Promise<WindowsGraphicsEventCollection> {
    if (this.platform !== "win32") {
      return { available: false, events: [] };
    }

    try {
      const result = await this.execFile("wevtutil", [
        "qe",
        "System",
        `/q:*[System[(EventID=${DISPLAY_DRIVER_EVENT_ID})]]`,
        "/f:RenderedXml",
        "/rd:true",
        `/c:${MAX_EVENTS}`
      ]);
      return {
        available: true,
        events: parseWindowsGraphicsEvents(result.stdout, since)
      };
    } catch (error) {
      return {
        available: false,
        events: [],
        error: error instanceof Error ? error.message.slice(0, 256) : "Unable to read Windows graphics events."
      };
    }
  }
}

export function parseWindowsGraphicsEvents(xml: string, since: Date): WindowsGraphicsEvent[] {
  const events: WindowsGraphicsEvent[] = [];
  const chunks = xml.match(/<Event(?:\s[^>]*)?>[\s\S]*?<\/Event>/g) ?? [];
  chunks.forEach((chunk) => {
    const provider = /<Provider\s+Name="([^"]+)"/.exec(chunk)?.[1];
    const eventId = Number(/<EventID[^>]*>(\d+)<\/EventID>/.exec(chunk)?.[1]);
    const systemTime = /<TimeCreated\s+SystemTime="([^"]+)"/.exec(chunk)?.[1];
    if (!provider || eventId !== DISPLAY_DRIVER_EVENT_ID || !systemTime) {
      return;
    }
    const timestamp = new Date(systemTime);
    if (Number.isNaN(timestamp.getTime()) || timestamp < since) {
      return;
    }
    events.push({ eventId, provider, timestamp: timestamp.toISOString() });
  });
  return events;
}
