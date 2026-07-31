const MAX_DOMINANT_COLOR_SAMPLES = 12_000;
const COLOR_BUCKET_SIZE = 32;
const MIN_VIVID_SATURATION = 0.35;
const MIN_REPRESENTATIVE_VIVID_SHARE = 0.01;

export interface ImageDataLike {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

interface ColorBucket {
  count: number;
  saturationTotal: number;
  rTotal: number;
  gTotal: number;
  bTotal: number;
}

export function extractDominantColorFromImageData(imageData: ImageDataLike): string | undefined {
  const pixelCount = imageData.width * imageData.height;

  if (pixelCount <= 0 || imageData.data.length < pixelCount * 4) {
    return undefined;
  }

  const buckets = new Map<string, ColorBucket>();
  const sampleStep = Math.max(1, Math.ceil(pixelCount / MAX_DOMINANT_COLOR_SAMPLES));
  let sampledCount = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += sampleStep) {
    const offset = pixelIndex * 4;
    const alpha = imageData.data[offset + 3] ?? 0;

    if (alpha < 128) {
      continue;
    }

    sampledCount += 1;

    const r = imageData.data[offset] ?? 0;
    const g = imageData.data[offset + 1] ?? 0;
    const b = imageData.data[offset + 2] ?? 0;
    const key = `${Math.floor(r / COLOR_BUCKET_SIZE)}:${Math.floor(g / COLOR_BUCKET_SIZE)}:${Math.floor(
      b / COLOR_BUCKET_SIZE
    )}`;
    const bucket = buckets.get(key) ?? {
      count: 0,
      saturationTotal: 0,
      rTotal: 0,
      gTotal: 0,
      bTotal: 0
    };

    bucket.count += 1;
    bucket.saturationTotal += calculateRgbSaturation(r, g, b);
    bucket.rTotal += r;
    bucket.gTotal += g;
    bucket.bTotal += b;
    buckets.set(key, bucket);
  }

  const vividBuckets = [...buckets.values()].filter(
    (bucket) => getAverageBucketSaturation(bucket) >= MIN_VIVID_SATURATION
  );
  const minimumRepresentativeCount = Math.max(2, Math.ceil(sampledCount * MIN_REPRESENTATIVE_VIVID_SHARE));
  const representativeVividBuckets = vividBuckets.filter((bucket) => bucket.count >= minimumRepresentativeCount);
  const candidates = representativeVividBuckets.length
    ? representativeVividBuckets
    : vividBuckets.length
      ? vividBuckets
      : [...buckets.values()];
  let winner: ColorBucket | undefined;
  let winnerScore = -Infinity;

  for (const bucket of candidates) {
    const averageSaturation = getAverageBucketSaturation(bucket);
    const score =
      vividBuckets.length > 0
        ? averageSaturation ** 2.8 * Math.log2(bucket.count + 1)
        : bucket.count * (1 + averageSaturation);

    if (score > winnerScore) {
      winner = bucket;
      winnerScore = score;
    }
  }

  if (!winner) {
    return undefined;
  }

  return rgbToHex(
    Math.round(winner.rTotal / winner.count),
    Math.round(winner.gTotal / winner.count),
    Math.round(winner.bTotal / winner.count)
  );
}

function getAverageBucketSaturation(bucket: ColorBucket): number {
  return bucket.saturationTotal / bucket.count;
}

export function getReadableTextColor(backgroundHex: string): "#111111" | "#FFFFFF" {
  const rgb = parseHexColor(backgroundHex);

  if (!rgb) {
    return "#FFFFFF";
  }

  const luminance = calculateRelativeLuminance(rgb.r, rgb.g, rgb.b);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);

  return blackContrast >= whiteContrast ? "#111111" : "#FFFFFF";
}

function calculateRgbSaturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);

  if (max === 0) {
    return 0;
  }

  return (max - min) / max;
}

function calculateRelativeLuminance(r: number, g: number, b: number): number {
  const [linearR, linearG, linearB] = [r, g, b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return linearR * 0.2126 + linearG * 0.7152 + linearB * 0.0722;
}

function parseHexColor(value: string): { r: number; g: number; b: number } | undefined {
  const match = /^#([0-9A-Fa-f]{6})$/.exec(value.trim());

  if (!match) {
    return undefined;
  }

  const hex = match[1];

  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16)
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => clampRgbChannel(channel).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function clampRgbChannel(value: number): number {
  return Math.max(0, Math.min(255, value));
}
