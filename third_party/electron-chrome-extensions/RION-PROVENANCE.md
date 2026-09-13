# Rion vendoring provenance

- Upstream project: `ramboxapp/electron-browser-shell`
- Upstream package: `@ramboxapp/electron-chrome-extensions` 4.10.3
- Audited commit: `026cea78b6d743a81e2aa0e84d236081fccf4c72`
- Imported: 2026-09-13
- Selected license: GNU GPL v3

Rion retains the complete upstream package source and license as corresponding
source. Product builds enter through `src/browser/rion.ts` and
`src/rion-preload.ts`. Those entry points instantiate only alarms, commands,
notifications, offscreen documents, permissions, in-memory session storage,
bounded tab reads/reload/events, and webNavigation. Rion also hardens IPC sender
identity, removes remote-session routing, bounds payloads, denies optional
permission escalation, and disables native messaging, WebSocket proxying,
downloads, identity, management, context menus, arbitrary tab mutation, and
toolbar popups.

Files outside that compiled graph remain present so recipients receive the
complete corresponding upstream source; their presence is not a supported Rion
runtime capability.
