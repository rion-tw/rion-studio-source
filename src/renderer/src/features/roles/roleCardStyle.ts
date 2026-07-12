import type { CSSProperties } from "react";

import { getDominantColorHoverBackground } from "../../../../shared/roleCoverColor";

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

type DominantLaunchButtonStyle = CSSProperties & {
  "--role-launch-bg": string;
  "--role-launch-hover-bg": string;
};

export function createDominantLaunchButtonStyle(color: string | undefined): DominantLaunchButtonStyle | undefined {
  if (!color) {
    return undefined;
  }

  return {
    "--role-launch-bg": color,
    "--role-launch-hover-bg": getDominantColorHoverBackground(color)
  };
}
