import type { ReactNode } from "react";
import type { SpecContent } from "@orchestra/core";
import { SPEC_FIELD_LABELS, SPEC_LIST_FIELDS } from "./specForm.js";

export interface SpecDraftFormProps {
  content: SpecContent;
  /** Fields to visually flag after a `spec.proposed`/`spec.revised` update. */
  highlightedFields: ReadonlySet<string>;
  disabled: boolean;
  onChange: (next: SpecContent) => void;
}

function FieldWrapper({
  name,
  label,
  highlighted,
  children,
}: {
  name: string;
  label: string;
  highlighted: boolean;
  children: ReactNode;
}) {
  return (
    <div data-testid={`spec-field-${name}`} data-highlighted={highlighted ? "true" : "false"}>
      <label>
        {label}
        {children}
      </label>
    </div>
  );
}

/**
 * The spec builder's right pane form (design.md §14 Spec builder row, §4.3):
 * bound to the draft revision's `SpecContent`, one list editor per list
 * field. Each list field is edited as newline-separated text -- simpler and
 * as testable as a chip/add-remove editor, and the underlying value is a
 * plain `string[]` either way.
 */
export function SpecDraftForm({ content, highlightedFields, disabled, onChange }: SpecDraftFormProps) {
  function setField<K extends keyof SpecContent>(field: K, value: SpecContent[K]) {
    onChange({ ...content, [field]: value });
  }

  return (
    <div>
      <FieldWrapper name="repository" label={SPEC_FIELD_LABELS.repository} highlighted={highlightedFields.has("repository")}>
        <input
          value={content.repository}
          disabled={disabled}
          onChange={(event) => setField("repository", event.target.value)}
        />
      </FieldWrapper>

      <FieldWrapper name="objective" label={SPEC_FIELD_LABELS.objective} highlighted={highlightedFields.has("objective")}>
        <textarea
          value={content.objective}
          disabled={disabled}
          onChange={(event) => setField("objective", event.target.value)}
        />
      </FieldWrapper>

      {SPEC_LIST_FIELDS.map((field) => (
        <FieldWrapper
          key={field}
          name={field}
          label={SPEC_FIELD_LABELS[field]}
          highlighted={highlightedFields.has(field)}
        >
          <textarea
            value={(content[field] ?? []).join("\n")}
            disabled={disabled}
            onChange={(event) =>
              setField(field, event.target.value === "" ? [] : event.target.value.split("\n"))
            }
          />
        </FieldWrapper>
      ))}

      <FieldWrapper name="notes" label={SPEC_FIELD_LABELS.notes} highlighted={highlightedFields.has("notes")}>
        <textarea
          value={content.notes ?? ""}
          disabled={disabled}
          onChange={(event) => setField("notes", event.target.value)}
        />
      </FieldWrapper>
    </div>
  );
}
