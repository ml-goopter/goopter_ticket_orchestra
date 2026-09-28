import type { ReactNode } from "react";
import type { SpecContent } from "@orchestra/core";
import { useEffect } from "react";
import type { AdminRepository } from "../api/types.js";
import { SPEC_FIELD_LABELS, SPEC_LIST_FIELDS } from "./specForm.js";

export interface SpecDraftFormProps {
  content: SpecContent;
  /**
   * The task's project repositories (GOT.54): the repository field is a
   * dropdown over this list rather than free text, so approval can no
   * longer fail on a typo'd name.
   */
  repositories: readonly AdminRepository[];
  /** Fields to visually flag after a `spec.proposed`/`spec.revised` update. */
  highlightedFields: ReadonlySet<string>;
  disabled: boolean;
  onChange: (next: SpecContent) => void;
}

/**
 * The repository field's control (GOT.54, D3): a `<select>` over the
 * project's repositories rather than free text, so `repository "" does not
 * resolve` on approval can no longer happen from a name typo.
 *
 * - Exactly one repository and an empty value: preselects it through the
 *   same `onChange` a user pick would use (D3), so the draft reflects the
 *   choice the same way and Save Draft persists it.
 * - Two or more repositories and an empty value: the empty option is shown
 *   selected -- nothing is preselected.
 * - A saved value that matches no project repository: kept selected (never
 *   silently replaced) and flagged with a visible error.
 * - No repositories at all: no control is rendered, only an empty-state
 *   message, so nothing can be submitted through this field.
 */
function RepositoryField({
  value,
  repositories,
  disabled,
  onChange,
}: {
  value: string;
  repositories: readonly AdminRepository[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const isKnown = repositories.some((repository) => repository.name === value);
  const isStale = value !== "" && !isKnown;

  useEffect(() => {
    if (!disabled && value === "" && repositories.length === 1) {
      onChange(repositories[0]!.name);
    }
  }, [disabled, value, repositories, onChange]);

  if (repositories.length === 0) {
    return (
      <p className="empty-state" data-testid="repository-empty-state">
        No repositories are configured for this project.
      </p>
    );
  }

  return (
    <>
      <select
        id="spec-field-repository-input"
        value={value}
        disabled={disabled}
        aria-invalid={isStale ? "true" : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Select a repository...</option>
        {repositories.map((repository) => (
          <option key={repository.id} value={repository.name}>
            {repository.name}
          </option>
        ))}
        {isStale && <option value={value}>{value} (not a project repository)</option>}
      </select>
      {isStale && (
        <p role="alert" data-testid="repository-invalid">
          &quot;{value}&quot; is not a repository of this project.
        </p>
      )}
    </>
  );
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
export function SpecDraftForm({ content, repositories, highlightedFields, disabled, onChange }: SpecDraftFormProps) {
  function setField<K extends keyof SpecContent>(field: K, value: SpecContent[K]) {
    onChange({ ...content, [field]: value });
  }

  return (
    <div className="form-grid spec-draft-form">
      <FieldWrapper name="repository" label={SPEC_FIELD_LABELS.repository} highlighted={highlightedFields.has("repository")}>
        <RepositoryField
          value={content.repository}
          repositories={repositories}
          disabled={disabled}
          onChange={(value) => setField("repository", value)}
        />
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
