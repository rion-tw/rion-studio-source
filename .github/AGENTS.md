# CI and Release Scope

- Keep actions pinned and preserve Linux, macOS, and Windows validation.
- Do not launch the desktop application during build/package validation.
- Preserve the owner-locked unsigned platform artifacts and mandatory updater
  signing/checksum gates from the root instructions.
- Release and installer changes require focused workflow/source tests.
