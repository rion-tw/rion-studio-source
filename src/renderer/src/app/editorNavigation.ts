type EditorSection = "games" | "roles" | "workspaces" | "macros";

const editorPathPatterns: Array<{ pattern: RegExp; section: EditorSection }> = [
  { section: "games", pattern: /^\/games\/(?:new|[^/]+\/edit)$/ },
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

export function readRequestedMacroRoleIds(search: string): string[] | undefined {
  const parameters = new URLSearchParams(search);
  if (!parameters.has("roleIds") && !parameters.has("roleId")) {
    return undefined;
  }

  return [...new Set(parameters.getAll("roleId").map((roleId) => roleId.trim()).filter(Boolean))];
}

export function readRequestedMacroRoleId(search: string): string | undefined {
  return readRequestedMacroRoleIds(search)?.[0];
}
