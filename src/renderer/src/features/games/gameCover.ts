const GAME_COVER_SOURCE_MAX_BYTES = 8_000_000;
const GAME_COVER_DATA_URL_MAX_LENGTH = 2_000_128;
const GAME_COVER_WIDTH = 1280;
const GAME_COVER_HEIGHT = 720;
const GAME_COVER_QUALITY = 0.82;
const SUPPORTED_GAME_COVER_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

export interface GameCoverCropRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export async function createGameCoverImageDataUrl(file: File): Promise<string> {
  if (!SUPPORTED_GAME_COVER_TYPES.has(file.type) || file.size > GAME_COVER_SOURCE_MAX_BYTES) {
    throw new Error("Game cover must be a PNG, JPEG, WebP, or GIF image up to 8 MB.");
  }

  const image = await loadImage(file);
  const crop = calculateGameCoverCrop(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = GAME_COVER_WIDTH;
  canvas.height = GAME_COVER_HEIGHT;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to process game cover.");
  }

  context.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
  const dataUrl = canvas.toDataURL("image/webp", GAME_COVER_QUALITY);
  if (dataUrl.length > GAME_COVER_DATA_URL_MAX_LENGTH) {
    throw new Error("Game cover is too large after processing.");
  }
  return dataUrl;
}

export function calculateGameCoverCrop(width: number, height: number): GameCoverCropRect {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Unable to process game cover.");
  }

  const targetAspectRatio = GAME_COVER_WIDTH / GAME_COVER_HEIGHT;
  const sourceAspectRatio = width / height;
  if (sourceAspectRatio > targetAspectRatio) {
    const cropWidth = height * targetAspectRatio;
    return { x: (width - cropWidth) / 2, y: 0, width: cropWidth, height };
  }

  const cropHeight = width / targetAspectRatio;
  return { x: 0, y: (height - cropHeight) / 2, width, height: cropHeight };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Unable to process game cover."));
    };
    image.src = objectUrl;
  });
}
