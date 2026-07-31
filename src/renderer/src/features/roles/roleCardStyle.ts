import type { CSSProperties } from "react";

interface RoleCardStyleOptions {
  color: string | undefined;
  hasCoverImage: boolean;
  isActive: boolean;
}

type RoleCardStyle = CSSProperties & {
  "--role-cover-accent"?: string;
};

export function createRoleCardStyle({
  color,
  hasCoverImage,
  isActive
}: RoleCardStyleOptions): RoleCardStyle | undefined {
  if (!hasCoverImage && (!isActive || !color)) {
    return undefined;
  }

  const style: RoleCardStyle = {};

  if (hasCoverImage) {
    style["--role-cover-accent"] = color ?? "hsl(var(--primary))";
  }

  if (isActive && color) {
    style.borderColor = color;
    style.borderStyle = "solid";
    style.borderWidth = 2;
  }

  return style;
}
