// Native font raster evidence from an isolated fixture; no debugger attachment.
module.exports = async function probeFontFallback(contents, assemble) {
  const render = (family, text = "繁體中文 简体中文 日本語") => `(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 900; canvas.height = 80;
    const context = canvas.getContext("2d");
    context.font = ${JSON.stringify(`32px ${family}`)};
    context.fillText(${JSON.stringify(text)}, 5, 50);
    const bytes = context.getImageData(0, 0, 900, 80).data;
    let hash = 2166136261;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return hash.toString(16);
  })()`;
  const outcomes = [];
  for (const language of ["zh-TW", "zh-CN", "ja"]) {
    await contents.executeJavaScript(`document.documentElement.lang = ${JSON.stringify(language)}`);
    const reference = {};
    for (const family of ["serif", "sans-serif", '"Georgia", serif', '"Georgia", sans-serif',
      '"Times New Roman", serif', '"Times New Roman", sans-serif']) {
      reference[family] = await contents.executeJavaScript(render(family));
    }
    for (const family of ["Georgia", "Times New Roman"]) {
      for (const numericFamily of [family, "system-ui"]) {
        const selection = { source: "system", family };
        const payload = { settings: { mode: "custom", fontSmoothingEnabled: false,
          cjkVariant: "auto", slots: { cjk: selection, latin: selection,
            numeric: { source: "system", family: numericFamily } } }, faces: [] };
        const application = await contents.executeJavaScript(assemble(payload));
        const canvas = await contents.executeJavaScript(render("sans-serif"));
        const bodyFamily = await contents.executeJavaScript("getComputedStyle(document.body).fontFamily");
        outcomes.push({ language, family, numericFamily, reference, canvas, bodyFamily, application });
        await contents.executeJavaScript(assemble({ ...payload,
          settings: { ...payload.settings, mode: "default", slots: {} } }));
      }
    }
  }
  return outcomes;
};
