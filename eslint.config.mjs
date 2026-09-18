import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      // Agent tooling state. A nested git worktree here is a second full copy of
      // the repository; ESLint does not read .gitignore, so it must be named again.
      ".claude",
      "coverage",
      ".desktop-e2e-artifacts",
      "dist",
      "node_modules",
      "out",
      "release",
      "target",
      // Complete corresponding source is retained verbatim; the compiled Rion
      // subset is typechecked and guarded by focused bundle/native probes.
      "third_party/electron-chrome-extensions",
      // These two files are ordered raw-script fragments, parsed after Rust concatenates them.
      "src/shared/browser-overlay/macro-overlay-runtime/*.js"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ]
    }
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React Hooks 7 enables compiler-oriented checks in its recommended preset.
      // Keep the pre-upgrade policy until these components adopt compiler-safe patterns.
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }]
    }
  },
  {
    files: ["src/shared/browser-overlay/**/*.js"],
    languageOptions: {
      globals: globals.browser
    },
    rules: {
      "@typescript-eslint/no-unused-expressions": "off"
    }
  },
  {
    files: ["tests/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ["scripts/**/*.cjs", "tests/fixtures/**/*.cjs"],
    languageOptions: {
      globals: globals.node,
      sourceType: "commonjs"
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  }
);
