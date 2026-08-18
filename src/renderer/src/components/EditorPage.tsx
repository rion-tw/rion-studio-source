import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react";
import {
  type FormEvent,
  type JSX,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef
} from "react";

import { Button } from "./ui/button";
import { Surface } from "./ui/patterns";
import {
  registerWindowControlsScrollSource,
  syncWindowControlsScrollSource
} from "../app/windowControlsScrollState";
import { cn } from "../lib/utils";

interface EditorPageProps {
  backActionLabel: string;
  backLabel: string;
  canSubmit?: boolean;
  children: ReactNode;
  contentClassName?: string;
  description: string;
  isSaving: boolean;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  saveHint?: string;
  saveIcon: ReactNode;
  saveLabel: string;
  title: string;
}

export function EditorPage({
  backActionLabel,
  backLabel,
  canSubmit = true,
  children,
  contentClassName,
  description,
  isSaving,
  onCancel,
  onSubmit,
  saveHint,
  saveIcon,
  saveLabel,
  title
}: EditorPageProps): JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);

  useLayoutEffect(() => {
    const form = formRef.current;
    if (!form) return;
    return registerWindowControlsScrollSource(form);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (isSaving) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (canSubmit) {
          formRef.current?.requestSubmit();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canSubmit, isSaving, onCancel]);

  return (
    <section className="app-editor-page h-full min-h-0">
      <form
        ref={formRef}
        id="app-editor-form"
        className="app-page h-full overflow-auto px-6 py-7"
        onScroll={(event) => syncWindowControlsScrollSource(event.currentTarget)}
        onSubmit={onSubmit}
      >
        <div className="mx-auto flex min-h-full w-full max-w-[1500px] flex-col gap-4">
          <header className="app-editor-header grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-4">
            <div className="min-w-0">
              <h1 className="app-page-title min-w-0 truncate">{title}</h1>
              <p className="app-page-description truncate">{description}</p>
            </div>

            <div className="flex flex-col items-end gap-2">
              {saveHint ? (
                <p className="max-w-56 truncate text-right text-xs font-medium text-muted-foreground">
                  {saveHint}
                </p>
              ) : null}
              <div className="flex items-center gap-1.5">
                <Button
                  aria-label={backLabel}
                  type="button"
                  variant="outline"
                  title={backLabel}
                  onClick={onCancel}
                  disabled={isSaving}
                >
                  {backActionLabel}
                </Button>
                <Button
                  className="min-w-[132px]"
                  type="submit"
                  disabled={isSaving || !canSubmit}
                >
                  {isSaving ? <Loader2 className="spin" size={16} /> : saveIcon}
                  {saveLabel}
                </Button>
              </div>
            </div>
          </header>

          <div className={cn("grid gap-4", contentClassName)}>
            {children}
          </div>
        </div>
      </form>
    </section>
  );
}

export function EditorNotFound({
  actionLabel,
  description,
  onAction,
  title
}: {
  actionLabel: string;
  description: string;
  onAction: () => void;
  title: string;
}): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-8">
      <Surface className="grid max-w-md justify-items-center gap-3 p-6 text-center" variant="panel">
        <span className="glass-control grid size-10 place-items-center rounded-lg text-muted-foreground">
          <AlertCircle size={19} />
        </span>
        <div className="grid gap-1.5">
          <h1 className="text-base font-semibold">{title}</h1>
          <p className="text-xs font-medium leading-5 text-muted-foreground">{description}</p>
        </div>
        <Button type="button" variant="outline" onClick={onAction}>
          <ArrowLeft size={15} />
          {actionLabel}
        </Button>
      </Surface>
    </div>
  );
}
