export const MAX_COPY_NAME_LENGTH = 80;

export function createCopyName(
  name: string,
  existingNames: Iterable<string>,
  copySuffix: string,
  maxLength = MAX_COPY_NAME_LENGTH
): string {
  const normalizedExistingNames = new Set([...existingNames].map(normalizeNameForComparison));
  const normalizedCopySuffix = copySuffix.trim() || "Copy";
  const normalizedName = name.trim();

  for (let copyNumber = 1; ; copyNumber += 1) {
    const suffix = copyNumber === 1 ? normalizedCopySuffix : `${normalizedCopySuffix} ${copyNumber}`;
    const tail = ` ${suffix}`;
    const baseLength = Math.max(maxLength - tail.length, 0);
    const baseName = normalizedName.slice(0, baseLength).trimEnd();
    const candidate = `${baseName}${tail}`.trim();

    if (!normalizedExistingNames.has(normalizeNameForComparison(candidate))) {
      return candidate;
    }
  }
}

function normalizeNameForComparison(name: string): string {
  return name.trim().toLocaleLowerCase();
}
