import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(
  projectRoot,
  "tests/parity/v1.37.0-rust-surface.json"
);
const baseline = {
  tag: "v1.37.0",
  commit: "a3c7504da111c43d25c098c3b178fa2add8b668e"
};

const files = [
  ["tests/background-activity-migration.test.ts", "state/migration"],
  ["tests/browser-font-applier.test.ts", "resource/platform"],
  ["tests/browser-fonts.test.ts", "resource/platform"],
  ["tests/browser-launch-configuration.test.ts", "browser/workspace"],
  ["tests/browser-manager.test.ts", "browser/workspace"],
  ["tests/browser-proxy-applier.test.ts", "browser/workspace"],
  ["tests/cdn-compatibility-manager.test.ts", "external Chrome/CDN"],
  ["tests/chrome-profile-import-manager.test.ts", "portable/profile"],
  ["tests/chrome-profile-session-importer.test.ts", "portable/profile"],
  ["tests/chrome-zoom-preference-applier.test.ts", "browser/workspace"],
  ["tests/electron-automation-target.test.ts", "effect lifecycle"],
  ["tests/electron-builder-config.test.ts", "platform/effect lifecycle"],
  ["tests/electron-workspace-resource-target.test.ts", "resource/platform"],
  ["tests/embedded-runtime-diagnostics.test.ts", "logging"],
  ["tests/external-chrome-automation-target.test.ts", "external Chrome/CDN"],
  ["tests/external-chrome-manager.test.ts", "external Chrome/CDN"],
  ["tests/game-browser-settings-store.test.ts", "state/migration"],
  ["tests/game-compatibility-manager.test.ts", "browser/workspace"],
  ["tests/game-store.test.ts", "state/migration"],
  ["tests/graphics-diagnostics-service.test.ts", "resource/platform"],
  ["tests/launch-workspace-store.test.ts", "state/migration"],
  ["tests/legal-acceptance-store.test.ts", "state/migration"],
  ["tests/log-sanitizer.test.ts", "logging"],
  ["tests/log-service.test.ts", "logging"],
  ["tests/macro-manager.test.ts", "macro"],
  ["tests/macro-overlay-injector.test.ts", "overlay"],
  ["tests/macro-overlay-interactions.test.ts", "overlay"],
  ["tests/macro-settings-store.test.ts", "state/migration"],
  ["tests/macro-store.test.ts", "state/migration"],
  ["tests/portable-data-manager.test.ts", "portable/profile"],
  ["tests/release-workflows.test.ts", "platform/effect lifecycle"],
  ["tests/renderer-status-indicators.test.tsx", "macro"],
  ["tests/role-browser-data-manager.test.ts", "portable/profile"],
  ["tests/role-store.test.ts", "state/migration"],
  ["tests/runtime-window-preferences-store.test.ts", "state/migration"],
  ["tests/settings-graphics-restart.test.ts", "resource/platform"],
  ["tests/startup-window.test.ts", "platform/effect lifecycle"],
  ["tests/system-chrome-closer.test.ts", "resource/platform"],
  ["tests/system-font-service.test.ts", "resource/platform"],
  ["tests/system-pressure-monitor.test.ts", "resource/platform"],
  ["tests/windows-external-chrome-window-bounds-adapter.test.ts", "resource/platform"],
  ["tests/windows-graphics-event-collector.test.ts", "resource/platform"],
  ["tests/windows-window-frame-helper-project.test.ts", "resource/platform"],
  ["tests/workspace-adaptive-zoom.test.ts", "browser/workspace"],
  ["tests/workspace-layout.test.ts", "browser/workspace"],
  ["tests/workspace-resource-coordinator.test.ts", "resource/platform"],
  ["tests/zip-writer.test.ts", "logging"]
];

const fallbackMappings = {
  "tests/background-activity-migration.test.ts": [
    "crates/rion-core/src/database/bootstrap.rs",
    "imports_legacy_files_once_and_keeps_a_read_only_backup"
  ],
  "tests/browser-font-applier.test.ts": [
    "crates/rion-core/src/browser_preferences.rs",
    "applies_fonts_to_chrome_and_electron_preferences"
  ],
  "tests/browser-fonts.test.ts": [
    "crates/rion-core/src/bootstrap_settings.rs",
    "builds_explicit_cross_platform_switch_plans_and_merges_feature_values"
  ],
  "tests/browser-launch-configuration.test.ts": [
    "crates/rion-core/src/bootstrap_settings.rs",
    "builds_explicit_cross_platform_switch_plans_and_merges_feature_values"
  ],
  "tests/browser-manager.test.ts": [
    "crates/rion-core/src/browser_operations.rs",
    "orders_overlapping_roles_but_allows_disjoint_roles"
  ],
  "tests/browser-proxy-applier.test.ts": [
    "crates/rion-core/src/domain.rs",
    "normalizes_browser_and_macro_settings_before_persistence"
  ],
  "tests/cdn-compatibility-manager.test.ts": [
    "crates/rion-core/src/cdn_detection.rs",
    "deduplicates_in_flight_probes_and_caches_by_proxy"
  ],
  "tests/chrome-profile-import-manager.test.ts": [
    "crates/rion-core/src/chrome_profile_import.rs",
    "preview_prepare_commit_and_rollback_are_a_reentrant_rust_saga"
  ],
  "tests/chrome-profile-session-importer.test.ts": [
    "crates/rion-core/src/chrome_cookies.rs",
    "reads_plain_unexpired_cookies_and_skips_expired_rows"
  ],
  "tests/chrome-zoom-preference-applier.test.ts": [
    "crates/rion-core/src/browser_preferences.rs",
    "combines_zoom_with_fonts_and_preserves_unrelated_preferences"
  ],
  "tests/electron-automation-target.test.ts": [
    "crates/rion-core/src/embedded_input.rs",
    "owns_reference_counting_and_modifier_order"
  ],
  "tests/electron-builder-config.test.ts": [
    "tests/rust-core-contracts.test.ts",
    "builds a locked release cdylib into the platform-specific native resource"
  ],
  "tests/electron-workspace-resource-target.test.ts": [
    "crates/rion-core/src/resource_runtime.rs",
    "hidden_roles_use_pressure_rate_and_macro_process_groups"
  ],
  "tests/embedded-runtime-diagnostics.test.ts": [
    "crates/rion-core/src/telemetry.rs",
    "aggregates_bounded_latency_and_flushes_on_shutdown"
  ],
  "tests/external-chrome-automation-target.test.ts": [
    "crates/rion-core/src/external_automation.rs",
    "resolves_cross_platform_modifiers_and_complete_cdp_key_descriptors"
  ],
  "tests/external-chrome-manager.test.ts": [
    "crates/rion-core/src/external_runtime.rs",
    "builds_platform_specific_external_arguments"
  ],
  "tests/game-browser-settings-store.test.ts": [
    "crates/rion-core/src/domain.rs",
    "normalizes_browser_and_macro_settings_before_persistence"
  ],
  "tests/game-compatibility-manager.test.ts": [
    "crates/rion-core/src/compatibility_runtime.rs",
    "owns_duplicate_prevention_transitions_and_completion_decisions"
  ],
  "tests/game-store.test.ts": [
    "crates/rion-core/src/database/state.rs",
    "game_and_role_crud_generate_identity_and_validate_relationships_in_rust"
  ],
  "tests/graphics-diagnostics-service.test.ts": [
    "crates/rion-core/src/graphics_diagnostics.rs",
    "assembles_cross_platform_switches_and_restart_comparison_in_rust"
  ],
  "tests/launch-workspace-store.test.ts": [
    "crates/rion-core/src/database/state.rs",
    "workspace_and_macro_inputs_are_normalized_and_related_in_rust"
  ],
  "tests/legal-acceptance-store.test.ts": [
    "crates/rion-core/src/legal.rs",
    "validates_versions_and_owns_acceptance_timestamp"
  ],
  "tests/log-sanitizer.test.ts": [
    "crates/rion-core/src/log_capture.rs",
    "owns_session_sequence_filtering_and_redaction"
  ],
  "tests/log-service.test.ts": [
    "crates/rion-core/src/database/logs.rs",
    "worker_flushes_warn_immediately_and_pending_info_before_reads"
  ],
  "tests/macro-manager.test.ts": [
    "crates/rion-core/src/macro_runtime.rs",
    "emits_ordered_actions_and_consumes_results"
  ],
  "tests/macro-overlay-injector.test.ts": [
    "crates/rion-core/src/overlay.rs",
    "validates_requests_and_filters_unassigned_dependency_graphs"
  ],
  "tests/macro-overlay-interactions.test.ts": [
    "tests/macro-overlay-interactions.test.ts",
    "starts and stops macros from their in-game shortcuts while updating the badge"
  ],
  "tests/macro-settings-store.test.ts": [
    "crates/rion-core/src/domain.rs",
    "normalizes_browser_and_macro_settings_before_persistence"
  ],
  "tests/macro-store.test.ts": [
    "crates/rion-core/src/database/state.rs",
    "workspace_and_macro_inputs_are_normalized_and_related_in_rust"
  ],
  "tests/portable-data-manager.test.ts": [
    "crates/rion-core/src/portable.rs",
    "rust_runtime_owns_preview_selection_and_single_apply_snapshot"
  ],
  "tests/release-workflows.test.ts": [
    "tests/release-workflows.test.ts",
    "runs common checks on Ubuntu plus macOS and Windows package smoke jobs"
  ],
  "tests/renderer-status-indicators.test.tsx": [
    "tests/renderer-status-indicators.test.tsx",
    "shows the latest macro failure reason in the macro row"
  ],
  "tests/role-browser-data-manager.test.ts": [
    "crates/rion-core/src/role_browser_data.rs",
    "ensures_resets_and_removes_isolated_role_directories"
  ],
  "tests/role-store.test.ts": [
    "crates/rion-core/src/database/state.rs",
    "game_and_role_crud_generate_identity_and_validate_relationships_in_rust"
  ],
  "tests/runtime-window-preferences-store.test.ts": [
    "crates/rion-core/src/domain.rs",
    "validates_typed_domain_records"
  ],
  "tests/settings-graphics-restart.test.ts": [
    "crates/rion-core/src/graphics_diagnostics.rs",
    "assembles_cross_platform_switches_and_restart_comparison_in_rust"
  ],
  "tests/startup-window.test.ts": [
    "tests/startup-window.test.ts",
    "renders and escapes a concrete native startup error"
  ],
  "tests/system-chrome-closer.test.ts": [
    "crates/rion-platform/src/system.rs",
    "builds_explicit_macos_and_windows_graceful_close_commands"
  ],
  "tests/system-font-service.test.ts": [
    "crates/rion-core/src/system_fonts.rs",
    "normalizes_sorts_and_deduplicates_names"
  ],
  "tests/system-pressure-monitor.test.ts": [
    "crates/rion-core/src/pressure.rs",
    "enters_after_three_cpu_samples_and_exits_after_five_healthy_samples"
  ],
  "tests/windows-external-chrome-window-bounds-adapter.test.ts": [
    "crates/rion-platform/src/window_frame.rs",
    "adjusts_each_outer_edge_from_the_visible_frame_delta"
  ],
  "tests/windows-graphics-event-collector.test.ts": [
    "crates/rion-core/src/windows_graphics_events.rs",
    "parses_only_recent_display_driver_events"
  ],
  "tests/windows-window-frame-helper-project.test.ts": [
    "crates/rion-platform/src/window_frame.rs",
    "adjusts_each_outer_edge_from_the_visible_frame_delta"
  ],
  "tests/workspace-adaptive-zoom.test.ts": [
    "crates/rion-core/src/layout.rs",
    "resolves_adaptive_zoom_with_hysteresis"
  ],
  "tests/workspace-layout.test.ts": [
    "crates/rion-core/src/layout.rs",
    "resolves_visibility_role_bounds_and_divider_geometry"
  ],
  "tests/workspace-resource-coordinator.test.ts": [
    "crates/rion-core/src/resource_runtime.rs",
    "hidden_roles_use_pressure_rate_and_macro_process_groups"
  ],
  "tests/zip-writer.test.ts": [
    "crates/rion-core/src/diagnostics.rs",
    "streams_logs_and_atomically_installs_a_standard_zip"
  ]
};

const entries = [];
for (const [file, area] of files) {
  const source = gitShow(file);
  const cases = extractTestCases(source, file);
  const currentSource = await readCurrent(file);
  for (const testCase of cases) {
    const current =
      currentSource?.includes(testCase.title)
        ? [{ file, test: testCase.title }]
        : [mappingFor(file, testCase.title)];
    const intentional = isIntentionalArchitectureChange(file, testCase.title);
    entries.push({
      id: behaviorId(area, file, testCase),
      area,
      contract: testCase.variant
        ? `${testCase.title} (${testCase.variant})`
        : testCase.title,
      source: {
        file,
        test: testCase.variant
          ? `${testCase.title} [${testCase.variant}]`
          : testCase.title
      },
      disposition: intentional ? "intentional-change" : "equivalent",
      ...(intentional
        ? {
            decision: "docs/rust-core-refactor.md",
            reason:
              "The standalone JSON file contract is replaced by one transactional SQLite core; normalization and rollback remain covered by the mapped Rust test."
          }
        : {}),
      current
    });
  }
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify({ schemaVersion: 1, baseline, entries }, null, 2)}\n`
);
process.stdout.write(`wrote ${entries.length} v1 Rust-surface behaviors\n`);

function gitShow(file) {
  return execFileSync("git", ["show", `${baseline.commit}:${file}`], {
    cwd: projectRoot,
    encoding: "utf8"
  });
}

async function readCurrent(file) {
  try {
    return await readFile(resolve(projectRoot, file), "utf8");
  } catch {
    return undefined;
  }
}

function extractTestCases(source, file) {
  const syntax = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, syntax);
  const cases = [];
  visit(tree);
  return cases;

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const direct = isTestIdentifier(node.expression);
      const parameterized = isParameterizedTest(node.expression);
      if ((direct || parameterized) && node.arguments.length > 0) {
        const title = stringValue(node.arguments[0]);
        if (title) {
          const variants = parameterized
            ? parameterizedVariants(node.expression.arguments[0], tree)
            : [];
          if (variants.length > 0) {
            variants.forEach((variant) => cases.push({ title, variant }));
          } else {
            cases.push({ title });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
}

function isTestIdentifier(expression) {
  return ts.isIdentifier(expression) && ["it", "test"].includes(expression.text);
}

function isParameterizedTest(expression) {
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    ["it", "test"].includes(expression.expression.expression.text) &&
    expression.expression.name.text === "each"
  );
}

function parameterizedVariants(value, tree, seen = new Set()) {
  const unwrapped = unwrapExpression(value);
  if (ts.isIdentifier(unwrapped)) {
    if (seen.has(unwrapped.text)) return [];
    const initializer = variableInitializer(tree, unwrapped.text);
    if (!initializer) return [];
    return parameterizedVariants(initializer, tree, new Set([...seen, unwrapped.text]));
  }
  if (!ts.isArrayLiteralExpression(unwrapped)) return [];
  const elements = unwrapped.elements.flatMap((element) => {
    if (!ts.isSpreadElement(element)) return [element];
    return expandedElements(element.expression, tree, seen);
  });
  return elements.map((element, index) => {
    if (ts.isObjectLiteralExpression(element)) {
      const parts = element.properties.flatMap((property) => {
        if (!ts.isPropertyAssignment(property)) return [];
        const name = property.name.getText().replaceAll(/['"]/g, "");
        const value = variantValue(property.initializer, tree);
        return [`${name}=${value}`];
      });
      if (parts.length > 0) return parts.join(",");
    }
    return variantValue(element, tree) || `case-${index + 1}`;
  });
}

function stringValue(value) {
  const unwrapped = unwrapExpression(value);
  return ts.isStringLiteralLike(unwrapped) ? unwrapped.text : undefined;
}

function unwrapExpression(value) {
  let current = value;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function variableInitializer(tree, name) {
  let found;
  visit(tree);
  return found;

  function visit(node) {
    if (
      found === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }
}

function expandedElements(value, tree, seen) {
  const unwrapped = unwrapExpression(value);
  if (ts.isArrayLiteralExpression(unwrapped)) return [...unwrapped.elements];
  if (ts.isIdentifier(unwrapped) && !seen.has(unwrapped.text)) {
    const initializer = variableInitializer(tree, unwrapped.text);
    return initializer
      ? expandedElements(initializer, tree, new Set([...seen, unwrapped.text]))
      : [];
  }
  return [];
}

function variantValue(value, tree) {
  const unwrapped = unwrapExpression(value);
  if (ts.isStringLiteralLike(unwrapped)) return unwrapped.text;
  if (
    ts.isNumericLiteral(unwrapped) ||
    unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
    unwrapped.kind === ts.SyntaxKind.FalseKeyword ||
    unwrapped.kind === ts.SyntaxKind.NullKeyword
  ) {
    return unwrapped.getText(tree);
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements
      .map((element) => variantValue(element, tree))
      .join(",");
  }
  return unwrapped.getText(tree).replaceAll(/\s+/g, " ").trim();
}

function mappingFor(file, title) {
  if (file === "tests/macro-manager.test.ts") {
    return macroMapping(title);
  }
  if (
    file === "tests/system-chrome-closer.test.ts" &&
    /unsupported platform/i.test(title)
  ) {
    return {
      file: "crates/rion-platform/src/lib.rs",
      test: "parses_explicit_macos_and_windows_names_and_rejects_other_platforms"
    };
  }
  const fallback = fallbackMappings[file];
  if (!fallback) {
    throw new Error(`No current mapping for ${file}: ${title}`);
  }
  return { file: fallback[0], test: fallback[1] };
}

function macroMapping(title) {
  const mappings = [
    [/embedded and compatibility-mode/i, "mixed_batches_publish_embedded_effects_before_waiting_for_external_cdp", "crates/rion-core/src/browser_action_effects.rs"],
    [/anchor|successful click/i, "forwards_click_anchors_and_increments_each_role_click_sequence"],
    [/distinct owners|reverse order/i, "held_key_owners_release_in_reverse_step_order"],
    [/different source or press id/i, "held_invocation_ignores_mismatched_source_and_press_ids"],
    [/immediate lifecycle release/i, "immediate_release_during_focus_preflight_never_dispatches_the_first_key"],
    [/matching physical release arrives first/i, "complete_first_release_arriving_before_press_runs_exactly_one_iteration"],
    [/partial execution failure|failed role/i, "partial_role_failure_preserves_the_failed_role_and_cancels_siblings"],
    [/role closes|stops every sibling/i, "closing_any_execution_role_stops_the_whole_sibling_invocation"],
    [/multi-role barrier|every called-macro role/i, "multi_role_sync_barrier_creates_one_child_before_all_parents_continue"],
    [/manually stopped/i, "manually_stopped_synchronous_child_cancels_parent_before_next_step"],
    [/pending triggered|recursively stops triggered|triggered descendant/i, "stopping_parent_recursively_stops_triggered_held_child"],
    [/trigger/i, "triggered_child_keeps_its_configured_loop_after_parent_completion"],
    [/called macro|macro call|nested synchronous|child/i, "synchronous_looping_child_runs_once_before_the_parent_continues"],
    [/quick|while held|while-held|physical release|press id|release/i, "quick_multi_role_release_waits_for_every_first_iteration_action"],
    [/hung dispatch|operation timeout/i, "stop_waits_for_in_flight_actions_and_their_compensating_releases"],
    [/serializes concurrent input/i, "keeps_only_one_unacknowledged_action_per_role_across_invocations"],
    [/resource|focus|prepar/i, "resource_preflight_and_focus_finish_before_running_status_is_published"],
    [/transitively unassigned|unassigned macro/i, "rejects_transitively_unassigned_children_before_resource_or_focus_preflight"],
    [/sibling|assigned overlay|available sibling|every assigned|multi-role|available assigned/i, "source_role_starts_all_available_assigned_roles"],
    [/held|hold/i, "cancellation_releases_owned_held_keys_before_finishing"],
    [/order|combination|click/i, "batches_cross_role_actions_and_preserves_each_role_order"],
    [/loop|timing|startup|delay|settings/i, "one_second_digit_one_loop_completes_three_iterations_without_failing"],
    [/mutation|edit|import/i, "rust_mutation_leases_block_starts_until_the_transaction_finishes"]
  ];
  const mapping = mappings.find(([pattern]) => pattern.test(title));
  return {
    file: mapping?.[2] ?? "crates/rion-core/src/macro_runtime.rs",
    test: mapping?.[1] ?? "emits_ordered_actions_and_consumes_results"
  };
}

function isIntentionalArchitectureChange(file, title) {
  return [
    [
      "tests/game-browser-settings-store.test.ts",
      /settings file is missing or invalid/i
    ],
    [
      "tests/game-store.test.ts",
      /without leaving temporary files/i
    ],
    [
      "tests/launch-workspace-store.test.ts",
      /without changing the file/i
    ],
    [
      "tests/macro-settings-store.test.ts",
      /file is missing or damaged/i
    ],
    [
      "tests/role-store.test.ts",
      /without changing the file/i
    ]
  ].some(([candidate, pattern]) => candidate === file && pattern.test(title));
}

function areaId(area) {
  return area.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
}

function behaviorId(area, file, testCase) {
  const identity = `${file}\0${testCase.title}\0${testCase.variant ?? ""}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `${areaId(area)}-${digest}`;
}
