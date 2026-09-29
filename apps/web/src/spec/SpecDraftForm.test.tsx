// @vitest-environment jsdom
import type { SpecContent } from "@orchestra/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpecDraftForm } from "./SpecDraftForm.js";
import { emptySpecContent } from "./specForm.js";

afterEach(cleanup);

function renderForm({
  content = emptySpecContent("tsk-repo"),
  disabled = false,
  onChange = vi.fn(),
  highlightedFields = new Set<string>(),
}: {
  content?: SpecContent;
  disabled?: boolean;
  onChange?: (next: SpecContent) => void;
  highlightedFields?: ReadonlySet<string>;
} = {}) {
  render(
    <SpecDraftForm content={content} highlightedFields={highlightedFields} disabled={disabled} onChange={onChange} />,
  );
  return { onChange };
}

describe("SpecDraftForm repository field (GOT.81, D2: chosen at session start, fixed afterwards)", () => {
  it("shows the task's repository as a read-only field with an accessible name", () => {
    renderForm({ content: emptySpecContent("tsk-repo") });

    const field = screen.getByLabelText("Repository") as HTMLInputElement;
    expect(field.tagName).toBe("INPUT");
    expect(field.value).toBe("tsk-repo");
    expect(field.readOnly).toBe(true);
  });

  it("is not a select and offers no other repository to choose (replaces the GOT.54 dropdown)", () => {
    renderForm({ content: emptySpecContent("tsk-repo") });

    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("does not call onChange when the user attempts to edit it", () => {
    const onChange = vi.fn();
    renderForm({ content: emptySpecContent("tsk-repo"), onChange });

    const field = screen.getByLabelText("Repository") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "some-other-repo" } });

    expect(onChange).not.toHaveBeenCalled();
  });
});
