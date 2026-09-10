import { useState } from "react";
import { MultilineTextField, PinListEditor, PropertyGrid, type PinListRow } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Field, FieldLabel, FieldDescription } from "@babylonslate/ui/components/field";
import { customGlslInterface, customGlslInterfaceError, createTypeResolver, type CustomGlslPin, type MaterialDocument, type MaterialFunctionDocument, type MaterialGraphNode } from "@babylonslate/shader-graph";
import { CodeBodyEditor } from "./js-body-editor";
import { GlslCodePreview } from "./glsl-code-preview";

const TYPES = ["float", "vec2", "vec3", "vec4"] as const;
const LABELS = ["Float", "Vector 2", "Vector 3", "Vector 4"];

export function MaterialCustomGlsl({ node, document, setProperties, bodyLine }: {
  bodyLine?: number;
  node: MaterialGraphNode;
  document: MaterialDocument | MaterialFunctionDocument;
  setProperties: (properties: Record<string, unknown>) => void;
}) {
  const [selectedInput, selectInput] = useState<string | null>(null);
  const [selectedOutput, selectOutput] = useState<string | null>(null);
  const pins = customGlslInterface(node.properties);
  const body = typeof node.properties.body === "string" ? node.properties.body : "a + b";
  const error = customGlslInterfaceError(node.properties);
  const setPins = (key: "inputs" | "outputs", rows: PinListRow[]) => {
    const next: CustomGlslPin[] = rows.map((row) => ({ id: row.id, name: row.name, type: TYPES.includes(row.type as typeof TYPES[number]) ? row.type as typeof TYPES[number] : "float" }));
    setProperties({ [key]: key === "outputs" ? [pins!.outputs[0]!, ...next] : next });
  };
  const primary = pins?.outputs[0];
  return <div className="flex min-w-0 flex-col gap-2 px-3" data-testid="material-node-glsl-field">
    {pins ? <>
      {primary ? <PropertyGrid rows={[
        { id: "result-name", kind: "text", label: "Return Name", value: primary.name, onChange: (name) => setProperties({ outputs: [{ ...primary, name }, ...pins.outputs.slice(1)] }) },
        { id: "result-type", kind: "enum", label: "Return Type", value: primary.type, options: TYPES.map((value, i) => ({ value, label: LABELS[i]! })), onChange: (type) => setProperties({ outputs: [{ ...primary, type }, ...pins.outputs.slice(1)] }) },
      ]} /> : null}
      <PinListEditor title="Inputs" rows={pins.inputs} types={TYPES} showDefault={false} showOptional={false} selectedId={selectedInput} onSelect={selectInput} onChange={(rows) => setPins("inputs", rows)} testIdPrefix="custom-glsl-input" />
      <PinListEditor title="Additional Outputs" rows={pins.outputs.slice(1)} types={TYPES} showDefault={false} showOptional={false} selectedId={selectedOutput} onSelect={selectOutput} onChange={(rows) => setPins("outputs", rows)} testIdPrefix="custom-glsl-output" />
    </> : <Button variant="outline" onClick={() => {
      const resolved = createTypeResolver(document).genericOf(node.id);
      if (!resolved || resolved === "conflict" || resolved === "texture") return;
      setProperties({ customVersion: 2, inputs: [{ id: "a", name: "a", type: resolved }, { id: "b", name: "b", type: resolved }], outputs: [{ id: "out", name: "Result", type: resolved }], body: `return (${body});` });
    }}>Convert to Function Body</Button>}
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor="material-node-glsl">{pins ? "Function Body" : "Expression"}</FieldLabel>
      <MultilineTextField code id="material-node-glsl" title={pins ? "GLSL Function Body" : "GLSL Expression"}
        value={body} onChange={(body) => setProperties({ body })} data-testid="material-node-glsl"
        renderPreview={(value) => <GlslCodePreview value={value} />}
        renderEditor={(value, onChange) => <CodeBodyEditor value={value} onChange={onChange} language="glsl" bodyLine={bodyLine} names={pins ? [...pins.inputs, ...pins.outputs.slice(1)].map((pin) => pin.name) : ["a", "b"]} />}
      />
      <FieldDescription data-testid="material-node-glsl-signature">
        {pins ? "Use input names as variables. Return the primary output; assign additional output names before returning. Pin names are case sensitive. Renaming a pin requires updating its references in the code." : "Legacy expression: result = fn(a, b). Convert to add typed pins and statements."} GLSL/WebGL only. Use Render to compile.
      </FieldDescription>
      {error ? <FieldDescription role="alert">{error}</FieldDescription> : null}
    </Field>
  </div>;
}
