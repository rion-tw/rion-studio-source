// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Field, FormField } from "../src/renderer/src/components/ui/patterns";

afterEach(cleanup);

describe("field vertical alignment", () => {
  it("keeps field copy at the top and controls at the bottom", () => {
    render(
      <div>
        <FormField label="Target display" description="Choose the display used by this workspace.">
          <button type="button">Studio Display</button>
        </FormField>
        <Field title="Browser mode" description="Use the same mode for every role.">
          <button type="button">Global mode</button>
        </Field>
      </div>
    );

    const formField = screen.getByText("Target display").parentElement?.parentElement;
    const field = screen.getByText("Browser mode").parentElement?.parentElement;

    for (const element of [formField, field]) {
      expect([...element!.classList]).toEqual(
        expect.arrayContaining(["flex", "h-full", "flex-col", "justify-between"])
      );
    }
  });
});
