type LegalMarkdownBlock =
  | { level: 1 | 2; text: string; type: "heading" }
  | { items: string[]; type: "list" }
  | { text: string; type: "paragraph" };

export function parseLegalMarkdown(markdown: string): LegalMarkdownBlock[] {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const blocks: LegalMarkdownBlock[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("# ")) {
      blocks.push({ level: 1, text: line.slice(2).trim(), type: "heading" });
      continue;
    }

    if (line.startsWith("## ")) {
      blocks.push({ level: 2, text: line.slice(3).trim(), type: "heading" });
      continue;
    }

    if (line.startsWith("- ")) {
      const items = [line.slice(2).trim()];
      while (index + 1 < lines.length && lines[index + 1].trim().startsWith("- ")) {
        index += 1;
        items.push(lines[index].trim().slice(2).trim());
      }
      blocks.push({ items, type: "list" });
      continue;
    }

    blocks.push({ text: line, type: "paragraph" });
  }

  return blocks;
}
