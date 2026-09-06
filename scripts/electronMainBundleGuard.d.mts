export function electronMainBundleGuard(): {
  name: string;
  enforce: "post";
  generateBundle: (options: unknown, bundle: Readonly<Record<string, {
    type: string;
    isEntry?: boolean;
    code?: string;
  }>>) => void;
};
