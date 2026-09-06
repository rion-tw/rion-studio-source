// E2E-only loader: execute the input owners and their shared engine primitive.
// Keep the whitelist closed so the probe cannot substitute another input path.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { Script } = require("node:vm");
const ts = require("typescript");
const modules = new Map();
function load(name) {
  if (!["chromiumWebContentsInput", "chromiumOwnedInputSubmission", "chromiumViewInputSubmission", "chromiumViewAttachmentCoordinator", "chromiumViewTrustedInputValidation", "chromiumViewTrustedInputHost"].includes(name)) {
    throw new Error(`Unexpected input-owner dependency: ${name}`);
  }
  if (modules.has(name)) return modules.get(name).exports;
  const filename = join(__dirname, "../src/electron/main", `${name}.ts`);
  const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const module = { exports: {} };
  modules.set(name, module);
  const execute = new Script(`(function(require, module, exports) {${source}\n})`,
    { filename }).runInThisContext();
  execute(dependency => load(dependency.replace(/^\.\//u, "")), module, module.exports);
  return module.exports;
}
module.exports = { ...load("chromiumOwnedInputSubmission"), ...load("chromiumWebContentsInput"), ...load("chromiumViewInputSubmission"), ...load("chromiumViewAttachmentCoordinator"), ...load("chromiumViewTrustedInputHost") };
