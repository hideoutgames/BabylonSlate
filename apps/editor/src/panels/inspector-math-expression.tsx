import { MultilineTextField, PropertyGrid, useEditorReadOnly, type PropertyRow } from "@haptic/editor-kit";
import { Field, FieldError } from "@haptic/ui/components/field";
import { Textarea } from "@haptic/ui/components/textarea";
import {
  isMathType,
  MATH_TYPES,
  mathExpressionExplicitInputType,
  mathExpressionFormula,
  mathExpressionInputType,
  mathExpressionInputTypePatch,
  mathExpressionNodeState,
  mathTypeName,
} from "@haptic/scripting";
import { mathExpressionErrorText } from "@haptic/scripting-nodes";
import { useTextEditorTab } from "../lib/use-text-editor-tab";

const FORMULA_HINT = "Names you assign become outputs and other names become inputs; let names a value without a pin.";
const AUTO = "auto";

/**
 * A Math Expression node's Details: its Formula and, per input, a type that is either chosen here
 * or follows the wire into it (Auto, showing what it resolves to).
 */
export function MathExpressionDetails({ nodeId, data, onFormula, onPatch }: {
  /** The node's id: the Formula's Text Editor tab follows it. */
  nodeId: string;
  /** The node's data, with the input types the canvas derived from its wires. */
  data: Record<string, unknown>;
  onFormula: (formula: string) => void;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const formula = mathExpressionFormula(data);
  const state = mathExpressionNodeState(data);
  const inputs = state.pins?.signature.inputs ?? [];
  const errorText = state.error ? mathExpressionErrorText(state.error) : null;
  const readOnly = useEditorReadOnly();
  const openInTab = useTextEditorTab({
    fieldKey: `node:${nodeId}:formula`,
    title: "Formula",
    mode: "formula",
    value: formula,
    onChange: onFormula,
    error: errorText,
  });
  const typeRows: PropertyRow[] = inputs.map((input) => {
    const explicit = mathExpressionExplicitInputType(data, input.name);
    return {
      id: `math-input-type-${input.name}`,
      kind: "enum",
      label: input.name,
      value: explicit ?? AUTO,
      options: [{ value: AUTO, label: "Auto" }, ...MATH_TYPES.map((type) => ({ value: type, label: mathTypeName(type) }))],
      ...(explicit ? {} : { status: mathTypeName(mathExpressionInputType(data, input.name)) }),
      onChange: (value: string) => onPatch(mathExpressionInputTypePatch(data, input.name, isMathType(value) ? value : undefined)),
    };
  });
  return (
    <div className="flex flex-col gap-3" data-testid="math-expression-details">
      <Field data-invalid={state.error ? true : undefined}>
        <MultilineTextField
          key={nodeId}
          id="math-expression-formula"
          label="Formula"
          hint={FORMULA_HINT}
          value={formula}
          onChange={onFormula}
          onOpenInTab={openInTab}
          data-testid="math-expression-formula-field"
          renderEditor={(value, onChange) => (
            <Textarea
              id="math-expression-formula"
              value={value}
              spellCheck={false}
              autoCapitalize="off"
              readOnly={readOnly}
              aria-invalid={state.error ? true : undefined}
              className="h-full min-h-0 resize-none rounded-none border-0 font-mono text-sm field-sizing-fixed"
              onChange={(event) => onChange(event.target.value)}
              data-testid="math-expression-formula-field-editor"
            />
          )}
        />
        {errorText ? <FieldError data-testid="math-expression-formula-error">{errorText}</FieldError> : null}
      </Field>
      {typeRows.length > 0 ? <PropertyGrid title="Input Types" rows={typeRows} /> : null}
    </div>
  );
}
