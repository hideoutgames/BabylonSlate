export function activate(api) {
  api.registerCommand({
    id: "glsl-to-material",
    title: "GLSL to Material",
    description: "Experimental. Converts straight-line fragment GLSL to editable nodes. Unsupported syntax is reported before creating a Material. UV and Time names are explicit optional bindings.",
    fields: [
      { id: "name", label: "Material Name", type: "text", defaultValue: "Converted Material", required: true },
      { id: "uv", label: "UV Variable", type: "text" },
      { id: "time", label: "Time Variable", type: "text" },
      { id: "source", label: "GLSL Source", type: "multiline", defaultValue: "void main() {\n  gl_FragColor = vec4(1.0);\n}", required: true },
    ],
    async execute(values) {
      const name = values.name.trim();
      if (!name || /[\\/:<>"|?*\u0000-\u001f]/.test(name) || name === "." || name === "..") {
        throw new Error("Enter a Material name without path separators or reserved characters.");
      }
      const bindings = {};
      if (values.uv.trim()) bindings[values.uv.trim()] = "uv";
      if (values.time.trim()) {
        if (values.time.trim() === values.uv.trim()) throw new Error("UV and Time must use different variable names.");
        bindings[values.time.trim()] = "time";
      }
      const result = await api.materials.convertGlsl(values.source, { name, bindings });
      if (!result.ok) {
        throw new Error(result.diagnostics.map((entry) => `${entry.line ? `Line ${entry.line}: ` : ""}${entry.message}`).join("\n"));
      }
      await api.assets.create(`assets/${name}.material.babasset`, {
        type: "Material", name, payload: result.document,
      });
      api.log(`Created Material: ${name}`);
    },
  });
}
