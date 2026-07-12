import { extractDominantColorFromImageData } from "../../../../shared/roleCoverColor";

const COVER_IMAGE_MAX_DIMENSION = 900;
const COVER_IMAGE_QUALITY = 0.82;
const COVER_IMAGE_MAX_DATA_URL_LENGTH = 1_400_000;

interface ProcessedCoverImage {
  coverImageDataUrl: string;
  coverImageDominantColor?: string;
}

export async function createCoverImageDataUrl(file: File): Promise<ProcessedCoverImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Role cover image must be an image file.");
  }

  const image = await loadImage(file);
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("Unable to process role cover image.");
  }

  const scale = Math.min(1, COVER_IMAGE_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to process role cover image.");
  }

  context.fillStyle = "#111111";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  let coverImageDominantColor: string | undefined;

  try {
    coverImageDominantColor = extractDominantColorFromImageData(
      context.getImageData(0, 0, canvas.width, canvas.height)
    );
  } catch {
    coverImageDominantColor = undefined;
  }

  const dataUrl = canvas.toDataURL("image/jpeg", COVER_IMAGE_QUALITY);

  if (dataUrl.length > COVER_IMAGE_MAX_DATA_URL_LENGTH) {
    throw new Error("Role cover image is too large.");
  }

  return {
    coverImageDataUrl: dataUrl,
    coverImageDominantColor
  };
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
      reject(new Error("Unable to process role cover image."));
    };
    image.src = objectUrl;
  });
}
