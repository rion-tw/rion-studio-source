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
import { PageHeader, Surface } from "./ui/patterns";
import { normalizeEditorTitle } from "../app/editorTitle";
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
  onTitleChange: (title: string) => void;
  saveHint?: string;
  saveIcon: ReactNode;
  saveLabel: string;
  title: string;
  titleAriaLabel: string;
  titlePlaceholder: string;
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
  onTitleChange,
  saveHint,
  saveIcon,
  saveLabel,
  title,
  titleAriaLabel,
  titlePlaceholder
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
    <section className="app-editor-page h-full min-h-0">
      <form
        ref={formRef}
        id="app-editor-form"
        className="app-page h-full overflow-auto px-6 py-7 md:px-10 md:py-10"
        onSubmit={onSubmit}
      >
        <div className="mx-auto flex min-h-full w-full max-w-[1500px] flex-col gap-4">
          <Button
            className="-ml-2 self-start px-2"
            type="button"
            variant="ghost"
            size="sm"
            title={backLabel}
            onClick={onCancel}
            disabled={isSaving}
          >
            <ArrowLeft size={14} />
            {backLabel}
          </Button>

          <PageHeader
            title={
              <EditableEditorTitle
                ariaLabel={titleAriaLabel}
                disabled={isSaving}
                placeholder={titlePlaceholder}
                value={title}
                onChange={onTitleChange}
              />
            }
            description={description}
            actions={
              <>
                {saveHint ? (
                  <p className="flex min-h-8 items-center text-xs font-medium text-muted-foreground">
                    {saveHint}
                  </p>
                ) : null}
                <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
                  {cancelLabel}
                </Button>
                <Button
                  className="min-w-[132px]"
                  type="submit"
                  disabled={isSaving || !canSubmit}
                >
                  {isSaving ? <Loader2 className="spin" size={16} /> : saveIcon}
                  {saveLabel}
                </Button>
              </>
            }
          />

          <div className={cn("grid gap-4", contentClassName)}>
            {children}
          </div>
        </div>
      </form>
    </section>
  );
}

function EditableEditorTitle({
  ariaLabel,
  disabled,
  onChange,
  placeholder,
  value
}: {
  ariaLabel: string;
  disabled: boolean;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}): JSX.Element {
  const titleRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (titleRef.current && titleRef.current.textContent !== value) {
      titleRef.current.textContent = value;
    }
  }, [value]);

  return (
    <span
      ref={titleRef}
      aria-label={ariaLabel}
      aria-required="true"
      className="app-editor-title inline-block max-w-full cursor-text truncate border-b border-transparent align-bottom outline-none transition-colors hover:border-border focus:border-primary data-[disabled=true]:cursor-default data-[disabled=true]:hover:border-transparent"
      contentEditable={disabled ? false : "plaintext-only"}
      data-disabled={disabled}
      data-placeholder={placeholder}
      role="textbox"
      spellCheck="false"
      suppressContentEditableWarning
      tabIndex={disabled ? -1 : 0}
      onInput={(event) => {
        const element = event.currentTarget;
        const nextValue = normalizeEditorTitle(element.textContent ?? "");

        if (element.textContent !== nextValue) {
          element.textContent = nextValue;
          moveCaretToEnd(element);
        }

        onChange(nextValue);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
        }
      }}
    >
      {value}
    </span>
  );
}

function moveCaretToEnd(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
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
