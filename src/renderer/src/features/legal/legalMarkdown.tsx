import { Fragment, type JSX, type ReactNode } from "react";

import { parseLegalMarkdown } from "./legalMarkdownParser";

export function LegalMarkdown({ markdown }: { markdown: string }): JSX.Element {
  return (
    <article className="legal-document mx-auto w-full max-w-3xl text-[13px] leading-6 text-foreground">
      {parseLegalMarkdown(markdown).map((block, index) => {
        if (block.type === "heading") {
          return block.level === 1 ? (
            <h1 key={index} className="mb-5 text-2xl font-semibold tracking-tight">
              {renderInline(block.text)}
            </h1>
          ) : (
            <h2 key={index} className="mb-2 mt-6 text-base font-semibold">
              {renderInline(block.text)}
            </h2>
          );
        }

        if (block.type === "list") {
          return (
            <ul key={index} className="my-3 list-disc space-y-1.5 pl-5 text-muted-foreground">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }

        return (
          <p key={index} className="my-3 text-muted-foreground">
            {renderInline(block.text)}
          </p>
        );
      })}
    </article>
  );
}

function renderInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const linkPattern = /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;
  let cursor = 0;

  for (const match of text.matchAll(linkPattern)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }

    parts.push(
      <a
        key={`${matchIndex}-${match[2]}`}
        className="font-medium text-foreground underline underline-offset-2"
        href={match[2]}
        target="_blank"
        rel="noreferrer"
      >
        {match[1]}
      </a>
    );
    cursor = matchIndex + match[0].length;
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return parts.length > 0 ? <Fragment>{parts}</Fragment> : text;
}
