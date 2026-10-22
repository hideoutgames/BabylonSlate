import { useState } from "react";
import { MultilineTextField, PinListEditor, PropertyGrid, type PinListRow } from "@haptic/editor-kit";
import { Field, FieldLabel, FieldDescription } from "@haptic/ui/components/field";
import { customGlslInterface, customGlslInterfaceError, type CustomGlslPin, type MaterialGraphNode } from "@haptic/shader-graph";
import { CodeBodyEditor } from "./js-body-editor";
import { GlslCodePreview } from "./glsl-code-preview";

const TYPES = ["float", "vec2", "vec3", "vec4"] as const;
const INPUT_TYPES = [...TYPES, "texture"] as const;
const LABELS = ["Float", "Vector 2", "Vector 3", "Vector 4"];

export function MaterialCustomGlsl({ node, setProperties, bodyLine }: {
  bodyLine?: number;
  node: MaterialGraphNode;
  setProperties: (properties: Record<string, unknown>) => void;
}) {
  const [selectedInput, selectInput] = useState<string | null>(null);
  const [selectedOutput, selectOutput] = useState<string | null>(null);
  const pins = customGlslInterface(node.properties);
  const body = typeof node.properties.body === "string" ? node.properties.body : "";
  const error = customGlslInterfaceError(node.properties);
  const setPins = (key: "inputs" | "outputs", rows: PinListRow[]) => {
    const allowed = key === "inputs" ? INPUT_TYPES : TYPES;
    const next: CustomGlslPin[] = rows.map((row) => ({ id: row.id, name: row.name, type: (allowed as readonly string[]).includes(row.type) ? row.type as CustomGlslPin["type"] : "float" }));
    setProperties({ [key]: key === "outputs" ? [pins.outputs[0]!, ...next] : next });
  };
  const primary = pins.outputs[0];
  return <div className="flex min-w-0 flex-col gap-2 px-3" data-testid="material-node-glsl-field">
    {primary ? <PropertyGrid rows={[
      { id: "result-name", kind: "text", label: "Return Name", value: primary.name, onChange: (name) => setProperties({ outputs: [{ ...primary, name }, ...pins.outputs.slice(1)] }) },
      { id: "result-type", kind: "enum", label: "Return Type", value: primary.type, options: TYPES.map((value, i) => ({ value, label: LABELS[i]! })), onChange: (type) => setProperties({ outputs: [{ ...primary, type }, ...pins.outputs.slice(1)] }) },
    ]} /> : null}
    <PinListEditor title="Inputs" rows={pins.inputs} types={INPUT_TYPES} showDefault={false} showOptional={false} selectedId={selectedInput} onSelect={selectInput} onChange={(rows) => setPins("inputs", rows)} itemLabel="Input" testIdPrefix="custom-glsl-input" />
    <PinListEditor title="Additional Outputs" rows={pins.outputs.slice(1)} types={TYPES} showDefault={false} showOptional={false} selectedId={selectedOutput} onSelect={selectOutput} onChange={(rows) => setPins("outputs", rows)} itemLabel="Output" testIdPrefix="custom-glsl-output" />
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor="material-node-glsl">Function Body</FieldLabel>
      <MultilineTextField code id="material-node-glsl" title="GLSL Function Body"
        value={body} onChange={(body) => setProperties({ body })} data-testid="material-node-glsl"
        renderPreview={(value) => <GlslCodePreview value={value} />}
        renderEditor={(value, onChange) => <CodeBodyEditor value={value} onChange={onChange} language="glsl" bodyLine={bodyLine} names={[...pins.inputs, ...pins.outputs.slice(1)].map((pin) => pin.name)} />}
      />
      <FieldDescription data-testid="material-node-glsl-signature">
        Use input names as variables. Return the primary output; assign additional output names before returning. Pin names are case sensitive. Renaming a pin requires updating its references in the code. GLSL/WebGL only. Use Render to compile.
      </FieldDescription>
      {error ? <FieldDescription role="alert">{error}</FieldDescription> : null}
    </Field>
  </div>;
}
