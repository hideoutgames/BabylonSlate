import { LabelHint, MultilineTextField, PropertyGrid, type PropertyRow } from "@haptic/editor-kit";
import { Field, FieldError, FieldLabel } from "@haptic/ui/components/field";
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

const FORMULA_HINT = "Names you assign become outputs and other names become inputs; let names a value without a pin.";
const AUTO = "auto";

/**
 * A Math Expression node's Details: its Formula and, per input, a type that is either chosen here
 * or follows the wire into it (Auto, showing what it resolves to).
 */
export function MathExpressionDetails({ data, onFormula, onPatch }: {
  /** The node's data, with the input types the canvas derived from its wires. */
  data: Record<string, unknown>;
  onFormula: (formula: string) => void;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const formula = mathExpressionFormula(data);
  const state = mathExpressionNodeState(data);
  const inputs = state.pins?.signature.inputs ?? [];
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
        <LabelHint hint={FORMULA_HINT}>
          <FieldLabel htmlFor="math-expression-formula">Formula</FieldLabel>
        </LabelHint>
        <MultilineTextField
          id="math-expression-formula"
          title="Formula"
          value={formula}
          onChange={onFormula}
          data-testid="math-expression-formula-field"
          renderEditor={(value, onChange) => (
            <Textarea
              value={value}
              spellCheck={false}
              autoCapitalize="off"
              className="min-h-0 flex-1 font-mono text-sm"
              onChange={(event) => onChange(event.target.value)}
              data-testid="math-expression-formula-field-editor"
            />
          )}
          renderPreview={(value) => (
            <span className="line-clamp-6 font-mono text-xs whitespace-pre">{value.trim() ? value : "Empty"}</span>
          )}
        />
        {state.error ? <FieldError data-testid="math-expression-formula-error">{mathExpressionErrorText(state.error)}</FieldError> : null}
      </Field>
      {typeRows.length > 0 ? <PropertyGrid title="Input Types" rows={typeRows} /> : null}
    </div>
  );
}
