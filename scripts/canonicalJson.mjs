export function serializeCanonicalJson(value) {
  return Buffer.from(
    `${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`,
    "utf8"
  );
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [
        key,
        canonicalJsonValue(value[key])
      ])
    );
  }
  return value;
}
