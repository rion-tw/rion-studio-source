import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react";
import {
  type FormEvent,
  type JSX,
  type ReactNode,
  useEffect,
  useRef
} from "react";

import { Button } from "./ui/button";
import { Surface } from "./ui/patterns";
import { cn } from "../lib/utils";

interface EditorPageProps {
  backLabel: string;
  cancelLabel: string;
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
  backLabel,
  cancelLabel,
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
    <section className="app-editor-page flex h-full min-h-0 flex-col">
      <header className="app-editor-toolbar glass-divider shrink-0 border-b px-6 py-4 md:px-8">
        <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <Button
              className="mt-0.5"
              type="button"
              variant="ghost"
              size="icon"
              title={backLabel}
              aria-label={backLabel}
              onClick={onCancel}
              disabled={isSaving}
            >
              <ArrowLeft size={16} />
            </Button>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold leading-7">{title}</h1>
              <p className="mt-0.5 text-xs font-medium leading-5 text-muted-foreground">{description}</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            {saveHint ? <p className="mr-1 text-xs font-medium text-muted-foreground">{saveHint}</p> : null}
            <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
              {cancelLabel}
            </Button>
            <Button className="min-w-[132px]" type="submit" form="app-editor-form" disabled={isSaving || !canSubmit}>
              {isSaving ? <Loader2 className="spin" size={16} /> : saveIcon}
              {saveLabel}
            </Button>
          </div>
        </div>
      </header>

      <form
        ref={formRef}
        id="app-editor-form"
        className="min-h-0 flex-1 overflow-auto"
        onSubmit={onSubmit}
      >
        <div className={cn("mx-auto grid min-h-full w-full max-w-[1500px] gap-4 px-6 py-6 md:px-8 md:py-8", contentClassName)}>
          {children}
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
