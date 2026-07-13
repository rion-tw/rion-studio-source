export type EditorSection = "roles" | "workspaces" | "macros";

const editorPathPatterns: Array<{ pattern: RegExp; section: EditorSection }> = [
  { section: "roles", pattern: /^\/roles\/(?:new|[^/]+\/edit)$/ },
  { section: "workspaces", pattern: /^\/workspaces\/(?:new|[^/]+\/edit)$/ },
  { section: "macros", pattern: /^\/macros\/(?:new|[^/]+\/edit)$/ }
];

export function createNewEditorPath(section: EditorSection, searchParams?: URLSearchParams): string {
  const search = searchParams?.toString();
  return `/${section}/new${search ? `?${search}` : ""}`;
}

export function createEditEditorPath(section: EditorSection, id: string): string {
  return `/${section}/${encodeURIComponent(id)}/edit`;
}

export function getEditorParentPath(pathname: string): `/${EditorSection}` | null {
  const match = editorPathPatterns.find(({ pattern }) => pattern.test(pathname));
  return match ? `/${match.section}` : null;
}

export function normalizeAppReturnTo(pathname: string, search = ""): string {
  return getEditorParentPath(pathname) ?? `${pathname}${search}`;
}

export function readRequestedMacroRoleId(search: string): string | undefined {
  const roleId = new URLSearchParams(search).get("roleId")?.trim();
  return roleId || undefined;
}
