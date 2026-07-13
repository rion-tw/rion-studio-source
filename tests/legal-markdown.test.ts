import { describe, expect, it } from "vitest";

import { parseLegalMarkdown } from "../src/renderer/src/features/legal/legalMarkdownParser";

describe("legal markdown", () => {
  it("parses only the supported document block types", () => {
    expect(parseLegalMarkdown("# Terms\n\n## Rules\n\nParagraph\n\n- One\n- Two\n\n<script>alert(1)</script>")).toEqual([
      { level: 1, text: "Terms", type: "heading" },
      { level: 2, text: "Rules", type: "heading" },
      { text: "Paragraph", type: "paragraph" },
      { items: ["One", "Two"], type: "list" },
      { text: "<script>alert(1)</script>", type: "paragraph" }
    ]);
  });
});
