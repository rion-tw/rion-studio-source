// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { X } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "../src/renderer/src/components/ui/button";
import { Input } from "../src/renderer/src/components/ui/input";
import { SegmentedControl } from "../src/renderer/src/components/ui/patterns";
import { Textarea } from "../src/renderer/src/components/ui/textarea";

afterEach(cleanup);

describe("renderer control sizing", () => {
  it("defines a global 30px minimum for visible controls", () => {
    const styles = readFileSync(
      path.join(process.cwd(), "src", "renderer", "src", "styles.css"),
      "utf8"
    );

    expect(styles).toContain("--control-min-size: 30px");
    expect(styles).toContain("--icon-button-icon-size: 14px");
    expect(styles).toContain("input:not([type=\"hidden\"]):not(.sr-only)");
    expect(styles).toContain("min-width: var(--control-min-size)");
    expect(styles).toContain("min-height: var(--control-min-size)");
  });

  it("keeps every button variant at or above 30px", () => {
    render(
      <>
        <Button aria-label="Default button">Default</Button>
        <Button aria-label="Small button" size="sm">Small</Button>
        <Button aria-label="Large button" size="lg">Large</Button>
      </>
    );

    for (const name of ["Default button", "Small button", "Large button"]) {
      const button = screen.getByRole("button", { name });
      expect(button.className).toContain("min-h-[var(--control-min-size)]");
      expect(button.className).toContain("min-w-[var(--control-min-size)]");
    }
    expect(screen.getByRole("button", { name: "Default button" }).className).toContain("h-[30px]");
    expect(screen.getByRole("button", { name: "Small button" }).className).toContain("h-[30px]");
    expect(screen.getByRole("button", { name: "Large button" }).className).toContain("h-8");
  });

  it("fixes compact icon buttons at 30px with a 14px icon override", () => {
    render(
      <Button aria-label="Close" size="icon">
        <X size={24} />
      </Button>
    );

    const button = screen.getByRole("button", { name: "Close" });
    expect(button.className).toContain("size-[var(--control-min-size)]");
    expect(button.className).toContain("[&>svg]:size-[var(--icon-button-icon-size)]");
    expect(button.querySelector("svg")?.getAttribute("width")).toBe("24");
  });

  it("applies the shared minimum to form and segmented controls", () => {
    render(
      <>
        <Input aria-label="Name" />
        <Textarea aria-label="Notes" />
        <SegmentedControl
          aria-label="View"
          items={[
            { label: "Cards", value: "cards" },
            { label: "Table", value: "table" }
          ]}
          value="cards"
          onValueChange={vi.fn()}
        />
      </>
    );

    expect(screen.getByRole("textbox", { name: "Name" }).className).toContain(
      "min-h-[var(--control-min-size)]"
    );
    expect(screen.getByRole("textbox", { name: "Notes" }).className).toContain(
      "min-w-[var(--control-min-size)]"
    );
    for (const name of ["Cards", "Table"]) {
      const segment = screen.getByRole("button", { name });
      expect(segment.className).toContain("h-[30px]");
      expect(segment.className).toContain("min-w-[var(--control-min-size)]");
    }
  });
});
