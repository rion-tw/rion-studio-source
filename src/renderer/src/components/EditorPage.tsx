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
import { normalizeEditorTitle, syncEditorTitle } from "../app/editorTitle";
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
  onTitleChange: (title: string) => void;
  saveHint?: string;
  saveIcon: ReactNode;
  saveLabel: string;
  title: string;
  titleAriaLabel: string;
  titleDisabled?: boolean;
  titlePlaceholder: string;
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
  onTitleChange,
  saveHint,
  saveIcon,
  saveLabel,
  title,
  titleAriaLabel,
  titleDisabled = false,
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
        className="app-page h-full overflow-auto px-6 py-7"
        onSubmit={onSubmit}
      >
        <div className="mx-auto flex min-h-full w-full max-w-[1500px] flex-col gap-4">
          <header className="app-editor-header grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-4">
            <div className="min-w-0">
              <h1 className="app-page-title min-w-0 truncate">
                <EditableEditorTitle
                  ariaLabel={titleAriaLabel}
                  disabled={isSaving || titleDisabled}
                  placeholder={titlePlaceholder}
                  value={title}
                  onChange={onTitleChange}
                />
              </h1>
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
    if (titleRef.current) {
      syncEditorTitle(titleRef.current, value);
    }
  }, [value]);

  return (
    <span className="relative inline-block min-w-48 max-w-full align-bottom">
      {value.trim().length === 0 ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 truncate text-muted-foreground opacity-[0.65]"
          data-editor-title-placeholder
        >
          {placeholder}
        </span>
      ) : null}
      <span
        ref={titleRef}
        aria-label={ariaLabel}
        aria-placeholder={placeholder}
        aria-required="true"
        className="app-editor-title relative inline-block min-w-48 max-w-full cursor-text truncate border-b border-transparent align-bottom outline-none transition-colors hover:border-border focus:border-primary data-[disabled=true]:cursor-default data-[disabled=true]:hover:border-transparent"
        contentEditable={disabled ? false : "plaintext-only"}
        data-disabled={disabled}
        role="textbox"
        spellCheck="false"
        suppressContentEditableWarning
        tabIndex={disabled ? -1 : 0}
        onInput={(event) => {
          const element = event.currentTarget;
          const caretOffset = getCaretOffset(element);
          const nextValue = normalizeEditorTitle(element.textContent ?? "");

          if (element.textContent !== nextValue) {
            element.textContent = nextValue;
            setCaretOffset(element, Math.min(caretOffset, nextValue.length));
          }

          onChange(nextValue);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
          }
        }}
      />
    </span>
  );
}

function getCaretOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection) {
    return element.textContent?.length ?? 0;
  }

  if (selection.rangeCount === 0) {
    return element.textContent?.length ?? 0;
  }

  const range = selection.getRangeAt(0);
  const startContainer = range.startContainer;
  const startOffset = range.startOffset;

  if (!element.contains(startContainer)) {
    return element.textContent?.length ?? 0;
  }

  if (startContainer.nodeType === Node.TEXT_NODE) {
    let offset = 0;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);

    let node = walker.nextNode();
    while (node) {
      if (node === startContainer) {
        return offset + startOffset;
      }
      offset += node.textContent?.length ?? 0;
      node = walker.nextNode();
    }

    return element.textContent?.length ?? 0;
  }

  const treeWalker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
  let totalOffset = 0;
  let node: Node | null = treeWalker.nextNode();
  while (node) {
    totalOffset += node.textContent?.length ?? 0;
    node = treeWalker.nextNode();
  }

  return totalOffset;
}

function setCaretOffset(element: HTMLElement, offset: number): void {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const text = element.textContent ?? "";
  const safeOffset = Math.max(0, Math.min(text.length, offset));

  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
  let node: Node | null = walker.nextNode();

  let remaining = safeOffset;
  while (node) {
    const currentText = node.textContent ?? "";
    if (remaining <= currentText.length) {
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= currentText.length;
    node = walker.nextNode();
  }

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
