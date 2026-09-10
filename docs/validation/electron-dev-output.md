# Electron Development Output Diagnosis

Use the read-only classifier when a local `pnpm dev` run mixes Rion failures
with Electron, Chromium, extension, and macOS framework output:

```bash
pnpm diagnose:electron-dev-output -- /absolute/path/to/dev.log
pnpm dev 2>&1 | pnpm diagnose:electron-dev-output -- -
```

The classifier does not filter or rewrite application output. It exits `1` for
known product failures, build-tool regressions, or unclassified diagnostic
lines; known compatibility and framework observations remain visible and exit
`0`. Argument and read failures exit `2`.

## Classification and escalation

| Category | Default interpretation | Escalate when |
| --- | --- | --- |
| `product-error` | A Rion-owned bridge, overlay, or receipt contract failed. | Always; the run is not clean. |
| `toolchain-regression` | A warning with a repository-owned dependency or build fix reappeared. | Always; reproduce with the narrow build command. |
| `unclassified` | A warning or error signature has no maintained rule. | Always; classify it before accepting the run. |
| `extension-compatibility` | Electron loaded an extension that requests an unsupported Chrome API. Electron supports only a subset of the Chrome Extensions API and logs unsupported API warnings during `loadExtension`. | The extension fails a required user-visible behavior or its load itself fails. |
| `macos-framework-noise` | TSM or IMK emitted an operating-system framework message. | A physical keyboard, Caps Lock, IME, text-edit, or focus defect is reproducible with the message. |
| `gpu-watch` | Chromium reported a missing SharedImage mailbox. | It repeats with visual corruption, a lost graphics context, a GPU-process exit, or degraded Graphics Information. |

Extension warnings do not authorize manifest rewriting, permission removal, or
blocking a Role launch. See the Electron documentation for
[extension support](https://www.electronjs.org/docs/latest/api/extensions) and
[supported extension APIs](https://www.electronjs.org/docs/latest/api/extensions-api).

For a `gpu-watch` escalation, open **Settings → Graphics Information**, refresh
the native status, and use **Copy report**. Preserve the original stderr, exact
reproduction steps, platform, and whether the issue survives a fresh app
process. A mailbox line without a correlated visible or process symptom is not
evidence for disabling hardware acceleration or changing WebContents teardown.

Diagnostic logs can contain local filesystem paths and extension identifiers.
Review them before sharing outside the development team.
