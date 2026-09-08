const MAX_TEXT_CHARACTERS = 8192;

export function summarizeNativeProbeError(error, privateValues, depth = 0, budget = { nodes: 32, text: 32768 }) {
  if (budget.nodes-- <= 0 || budget.text <= 0) {
    return { message: "[diagnostic limit reached]" };
  }
  const text = (value) => {
    let result = typeof value === "string" ? value : String(value);
    for (const secret of privateValues) {
      if (typeof secret === "string" && secret.length > 0) {
        result = result.replaceAll(secret, "[redacted]");
      }
    }
    const maximum = Math.min(MAX_TEXT_CHARACTERS, budget.text);
    budget.text -= Math.min(result.length, maximum);
    return result.length > maximum
      ? result.slice(0, maximum) + " [truncated]" : result;
  };
  if (!(error instanceof Error)) return { message: text(error) };
  return {
    name: text(error.name),
    ...(error.code !== undefined ? { code: text(error.code) } : {}),
    message: text(error.message),
    ...(error.stdout !== undefined ? { stdout: text(error.stdout) } : {}),
    ...(error.stderr !== undefined ? { stderr: text(error.stderr) } : {}),
    ...(error.cause !== undefined && depth < 3
      ? { cause: summarizeNativeProbeError(error.cause, privateValues, depth + 1, budget) }
      : {}),
    ...(error instanceof AggregateError && depth < 3
      ? { errors: error.errors.slice(0, 8).map((item) =>
        summarizeNativeProbeError(item, privateValues, depth + 1, budget)) }
      : {})
  };
}
