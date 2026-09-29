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

/**
 * The repository field (GOT.81, D2): read-only, showing the task's
 * repository. The user chooses and confirms the repository before the spec
 * session starts (design.md §14) and it cannot change afterwards, so this
 * replaces the GOT.54 dropdown that used to let the field be edited here.
 */
function RepositoryField({ value }: { value: string }) {
  return <input id="spec-field-repository-input" type="text" value={value} readOnly />;
}

function FieldWrapper({
  name,
  label,
  highlighted,
  full,
  children,
}: {
  name: string;
  label: string;
  highlighted: boolean;
  /** Spans both `.form-grid` columns; every field but `repository` reads better full-width (design.md §14 "list fields readable"). */
  full?: boolean;
  children: ReactNode;
}) {
  const className = ["field", "spec-draft-form__field", full ? "form-grid__full" : null, highlighted ? "spec-draft-form__field--highlighted" : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={className} data-testid={`spec-field-${name}`} data-highlighted={highlighted ? "true" : "false"}>
      <label htmlFor={`spec-field-${name}-input`}>{label}</label>
      {children}
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
    <div className="form-grid spec-draft-form">
      <FieldWrapper name="repository" label={SPEC_FIELD_LABELS.repository} highlighted={highlightedFields.has("repository")}>
        <RepositoryField value={content.repository} />
      </FieldWrapper>

      <FieldWrapper name="objective" label={SPEC_FIELD_LABELS.objective} highlighted={highlightedFields.has("objective")} full>
        <textarea
          id="spec-field-objective-input"
          rows={3}
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
          full
        >
          <textarea
            id={`spec-field-${field}-input`}
            rows={4}
            value={(content[field] ?? []).join("\n")}
            disabled={disabled}
            onChange={(event) =>
              setField(field, event.target.value === "" ? [] : event.target.value.split("\n"))
            }
          />
        </FieldWrapper>
      ))}

      <FieldWrapper name="notes" label={SPEC_FIELD_LABELS.notes} highlighted={highlightedFields.has("notes")} full>
        <textarea
          id="spec-field-notes-input"
          rows={3}
          value={content.notes ?? ""}
          disabled={disabled}
          onChange={(event) => setField("notes", event.target.value)}
        />
      </FieldWrapper>
    </div>
  );
}
