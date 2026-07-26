export interface CargoExecutableOptions {
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
  isUsable?: (path: string) => boolean | Promise<boolean>;
  platform?: NodeJS.Platform;
}

export declare function resolveCargoExecutable(
  options?: CargoExecutableOptions
): Promise<string>;

export declare function environmentWithCargoExecutable(
  options?: CargoExecutableOptions
): Promise<Record<string, string | undefined>>;
