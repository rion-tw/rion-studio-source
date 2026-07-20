// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { X } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "../src/renderer/src/components/ui/button";
import { Input } from "../src/renderer/src/components/ui/input";
import { SegmentedControl } from "../src/renderer/src/components/ui/patterns";
import { Slider } from "../src/renderer/src/components/ui/slider";
import { Textarea } from "../src/renderer/src/components/ui/textarea";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("renderer control sizing", () => {
  it("defines a floating 30px hit target without imposing global layout minimums", () => {
    const styles = readFileSync(
      path.join(process.cwd(), "src", "renderer", "src", "styles.css"),
      "utf8"
    );

    expect(styles).toContain("--control-hit-size: 30px");
    expect(styles).toContain("--control-min-size: 30px");
    expect(styles).toContain("--icon-button-icon-size: 14px");
    expect(styles).toContain('[role="checkbox"]');
    expect(styles).toContain(".control-hit-target");
    expect(styles).toContain("position: absolute");
    expect(styles).toContain("width: max(100%, var(--control-hit-size))");
    expect(styles).not.toContain("min-width: var(--control-hit-size)");
    expect(styles).not.toContain("min-height: var(--control-hit-size)");
  });

  it("keeps full-surface button variants visually sized while allowing compact overrides", () => {
    render(
      <>
        <Button aria-label="Default button">Default</Button>
        <Button aria-label="Small button" size="sm">Small</Button>
        <Button aria-label="Large button" size="lg">Large</Button>
        <Button aria-label="Compact button" className="h-7 w-7" size="icon" />
      </>
    );

    for (const name of ["Default button", "Small button", "Large button"]) {
      const button = screen.getByRole("button", { name });
      expect(button.className).not.toContain("min-h-[var(--control-min-size)]");
      expect(button.className).not.toContain("min-w-[var(--control-min-size)]");
    }
    expect(screen.getByRole("button", { name: "Default button" }).className).toContain("h-[30px]");
    expect(screen.getByRole("button", { name: "Small button" }).className).toContain("h-[30px]");
    expect(screen.getByRole("button", { name: "Large button" }).className).toContain("h-8");
    expect(screen.getByRole("button", { name: "Compact button" }).className).toContain("h-7");
    expect(screen.getByRole("button", { name: "Compact button" }).className).toContain("w-7");
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

  it("preserves explicit visual sizing for form and segmented controls and gives sliders a floating target", () => {
    vi.stubGlobal("ResizeObserver", class {
      disconnect(): void {}
      observe(): void {}
      unobserve(): void {}
    });

    render(
      <>
        <Input aria-label="Name" />
        <Textarea aria-label="Notes" />
        <Slider aria-label="Amount" value={[50]} />
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
    const slider = screen.getByRole("slider", { name: "Amount" });
    expect(slider.className).toContain("size-3.5");
    const sliderRoot = slider.closest(".control-hit-target");
    expect(sliderRoot?.className).toContain("h-3.5");
  });
});
