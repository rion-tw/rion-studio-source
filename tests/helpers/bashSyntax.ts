import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Parse workflow Bash without executing it, including on a Windows workstation. */
export function assertBashSyntax(sources: readonly string[], platform: NodeJS.Platform): void {
  const executable = platform === "win32"
    ? resolve(execFileSync("git", ["--exec-path"], {
        encoding: "utf8",
        windowsHide: true
      }).trim(), "../../..", "bin/bash.exe")
    : "bash";
  const checks = sources.map((source, index) => {
    const delimiter = `RION_BASH_SYNTAX_INPUT_${index}`;
    if (source.split(/\r?\n/u).includes(delimiter)) {
      throw new Error("Bash syntax fixture collides with its literal input delimiter.");
    }
    return `"$BASH" --noprofile --norc -n <<'${delimiter}' &\n${source}\n${delimiter}\npids+=("$!")`;
  });
  const batches: string[] = [];
  for (let offset = 0; offset < checks.length; offset += 4) {
    batches.push([
      "pids=()",
      ...checks.slice(offset, offset + 4),
      'for pid in "${pids[@]}"; do wait "$pid" || result=1; done'
    ].join("\n"));
  }
  // Only this fixed harness executes. Each supplied program is literal stdin
  // to its own syntax-only Bash invocation, never an executable command.
  execFileSync(executable, ["--noprofile", "--norc"], {
    encoding: "utf8",
    input: `set -e\nresult=0\n${batches.join("\n")}\nexit "$result"\n`,
    windowsHide: true
  });
}
