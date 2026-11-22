import { describe, expect, it } from "vitest";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
} from "./document";
import {
  hydrateMaterialGraphForEditor,
  materialAddNodePalette,
  materialGraphToSerialized,
  materialNodeTitle,
  materialPaletteNodes,
  materialPinsAreCompatible,
  namedReroutePaletteNodes,
  pinsForMaterialNode,
  serializedToMaterialFunctionGraph,
  serializedToMaterialGraph,
  type MaterialGraphPin,
} from "./serialize-material";

describe("material graph serialization", () => {
  it("shows the widest connected numeric type on generic pins", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      { id: "pair", type: "const.vec2", position: { x: 0, y: 0 }, properties: {} },
      { id: "add", type: "math.add", position: { x: 0, y: 0 }, properties: {} },
    );
    doc.edges.push(
      { id: "a", sourceNodeId: "pair", sourcePinId: "out", targetNodeId: "add", targetPinId: "a" },
      { id: "b", sourceNodeId: "baseColor", sourcePinId: "out", targetNodeId: "add", targetPinId: "b" },
    );
    const node = hydrateMaterialGraphForEditor(materialGraphToSerialized(doc)).nodes.find((entry) => entry.id === "add")!;
    expect(node.data.__pins).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "a", type: { kind: "vec3" }, typeLabel: "V3" }),
      expect.objectContaining({ id: "out", type: { kind: "vec3" }, typeLabel: "V3" }),
    ]));
  });
  it("gives a pasted parameter a free _N name while the original keeps its own", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "roughness", type: "param.float", position: { x: 0, y: 0 }, properties: { name: "Roughness", value: [0.4] } });
    const graph = materialGraphToSerialized(doc);
    graph.nodes.push({ ...graph.nodes.find((node) => node.id === "roughness")!, id: "roughness-copy" });
    const pasted = serializedToMaterialGraph(graph, doc);
    expect(pasted.nodes.find((node) => node.id === "roughness")?.properties.name).toBe("Roughness");
    expect(pasted.nodes.find((node) => node.id === "roughness-copy")?.properties.name).toBe("Roughness_1");
    expect(pasted.nodes.find((node) => node.id === "roughness-copy")?.properties.value).toEqual([0.4]);
  });
  it.each(["param.color", "input.vertexColor", "input.particleColor", "input.sceneColor", "texture.sample", "texture.triplanar"])(
    "gives %s the RGBA, RGB and A outputs every color source has", (type) => {
      const outputs = pinsForMaterialNode(type).filter((pin) => pin.direction === "out");
      expect(outputs.filter((pin) => ["RGBA", "RGB", "A"].includes(pin.name)).map((pin) => [pin.name, pin.type.kind])).toEqual([
        ["RGBA", "vec4"], ["RGB", "vec3"], ["A", "float"],
      ]);
    });
  it("offers every node but the output node in Add Node, which each Material already has one of", () => {
    for (const domain of ["surface", "landscape", "postProcess", "particle", "text", "ui"] as const) {
      const ids = materialAddNodePalette(domain).map((node) => node.id);
      expect(ids.filter((id) => id.startsWith("output."))).toEqual([]);
      // Named Reroutes are listed per graph by namedReroutePaletteNodes.
      expect(ids.filter((id) => id.startsWith("reroute."))).toEqual([]);
      expect(ids).toContain("math.add");
    }
  });
  it("round-trips a document through the graph shell shape", () => {
    const doc = createDefaultMaterialDocument();
    const next = serializedToMaterialGraph(materialGraphToSerialized(doc), doc);
    expect(next.nodes.map((node) => node.id)).toEqual(
      doc.nodes.map((node) => node.id),
    );
    expect(next.edges.map((edge) => edge.id)).toEqual(
      doc.edges.map((edge) => edge.id),
    );
  });

  it("preserves node positions through a round trip", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes[0]!.position = { x: 123, y: -45 };
    const next = serializedToMaterialGraph(materialGraphToSerialized(doc), doc);
    expect(next.nodes[0]?.position).toEqual({ x: 123, y: -45 });
  });

  it("preserves document settings that are not part of the canvas", () => {
    const doc = createDefaultMaterialDocument();
    doc.blendMode = "translucent";
    doc.preview = { mesh: "cube", customMeshGuid: null };
    const next = serializedToMaterialGraph(materialGraphToSerialized(doc), doc);
    expect(next.blendMode).toBe("translucent");
    expect(next.preview.mesh).toBe("cube");
  });

  it("hydrates catalog pins so Add Node is not an empty box", () => {
    const hydrated = hydrateMaterialGraphForEditor(
      materialGraphToSerialized(createDefaultMaterialDocument()),
    );
    const output = hydrated.nodes.find(
      (node) => node.type === "output.surface",
    );
    const pins = output?.data.__pins as Array<{ id: string; direction: string }>;
    expect(pins.some((pin) => pin.id === "baseColor" && pin.direction === "in")).toBe(
      true,
    );
  });

  it("hydrates catalog defaultValue and colorHint onto editor pins", () => {
    const hydrated = hydrateMaterialGraphForEditor(
      materialGraphToSerialized(createDefaultMaterialDocument()),
    );
    const output = hydrated.nodes.find(
      (node) => node.type === "output.surface",
    );
    const pins = output?.data.__pins as Array<{
      id: string;
      defaultValue?: number[];
      colorHint?: boolean;
    }>;
    const roughness = pins.find((pin) => pin.id === "roughness");
    const baseColor = pins.find((pin) => pin.id === "baseColor");
    const worldPositionOffset = pins.find(
      (pin) => pin.id === "worldPositionOffset",
    );
    expect(roughness?.defaultValue).toEqual([0.5]);
    expect(baseColor?.colorHint).toBe(true);
    expect(baseColor?.defaultValue).toEqual([0.8, 0.8, 0.8]);
    expect(worldPositionOffset?.defaultValue).toEqual([0, 0, 0]);
    expect(output?.data["default:roughness"]).toBeUndefined();
  });

  it("strips editor-only keys when converting back to the document", () => {
    const hydrated = hydrateMaterialGraphForEditor(
      materialGraphToSerialized(createDefaultMaterialDocument()),
    );
    const doc = serializedToMaterialGraph(hydrated);
    expect(doc.nodes[0]?.properties.__pins).toBeUndefined();
    expect(doc.nodes[0]?.properties.__nodeType).toBeUndefined();
  });

  it("hydrates function call pins from the called function interface", () => {
    const fn = createDefaultMaterialFunctionDocument("Tint");
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({
      id: "call",
      type: "function.call",
      position: { x: 0, y: 0 },
      properties: { functionGuid: "fn-1" },
    });
    const hydrated = hydrateMaterialGraphForEditor(
      materialGraphToSerialized(doc),
      { functions: { "fn-1": fn } },
    );
    const call = hydrated.nodes.find((node) => node.id === "call");
    const pins = call?.data.__pins as Array<{ id: string; direction: string }>;
    expect(pins.some((pin) => pin.id === "in_value" && pin.direction === "in")).toBe(
      true,
    );
    expect(
      pins.some((pin) => pin.id === "out_value" && pin.direction === "out"),
    ).toBe(true);
    expect(call?.data.title).toBe("Tint");
  });

  it("hydrates function plumbing pins from the function interface", () => {
    const fn = createDefaultMaterialFunctionDocument("Tint");
    const pins = pinsForMaterialNode("function.input", { functionInterface: fn });
    expect(pins.map((pin) => pin.id)).toEqual(["in_value"]);
    expect(pins[0]?.direction).toBe("out");
  });

  it("lists palette nodes for the requested domain with pins attached", () => {
    const palette = materialPaletteNodes("surface");
    const multiply = palette.find((entry) => entry.id === "math.multiply");
    expect(multiply?.pins.some((pin) => pin.id === "a")).toBe(true);
    expect(multiply?.searchAliases).toContain("×");
    expect(palette.find((entry) => entry.id === "math.add")?.searchAliases).toContain("+");
    expect(palette.find((entry) => entry.id === "math.sqrt")?.searchAliases).toContain("sqrt(x)");
    expect(palette.find((entry) => entry.id === "vector.dot")?.searchAliases).toContain("·");
    expect(palette.find((entry) => entry.id === "vector.cross")?.searchAliases).toContain("×");
    expect(palette.find((entry) => entry.id === "logic.select")?.searchAliases).toContain("?:");
    expect(palette.find((entry) => entry.id === "noise.perlin")?.searchAliases).toContain("PerlinNoise");
    expect(palette.some((entry) => entry.id === "output.postProcess")).toBe(
      false,
    );
    expect(palette.some((entry) => entry.id === "output.interface")).toBe(
      false,
    );
  });

  it("lists Particle Color on the particle palette and hides surface terminals", () => {
    const palette = materialPaletteNodes("particle");
    expect(palette.some((entry) => entry.id === "input.particleColor")).toBe(
      true,
    );
    expect(palette.some((entry) => entry.id === "output.particle")).toBe(true);
    expect(palette.some((entry) => entry.id === "output.surface")).toBe(false);
    expect(palette.some((entry) => entry.id === "input.worldPosition")).toBe(
      false,
    );
  });

  it("lists the User Interface nodes on the User Interface palette with their typed pins", () => {
    const palette = materialPaletteNodes("ui");
    const ids = palette.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(["output.ui", "input.ui", "ui.roundedRectangle", "ui.ellipse", "ui.linearProgress", "ui.radialProgress"]));
    expect(ids).not.toContain("output.surface");
    expect(ids).not.toContain("input.worldPosition");
    expect(materialAddNodePalette("ui").map((entry) => entry.id)).not.toContain("output.ui");
    expect(materialPaletteNodes("surface").map((entry) => entry.id)).not.toContain("ui.roundedRectangle");
    expect(pinsForMaterialNode("ui.roundedRectangle").map((pin) => [pin.direction, pin.id, pin.type.kind])).toEqual([
      ["in", "position", "vec2"], ["in", "size", "vec2"], ["in", "radius", "vec4"], ["in", "border", "float"],
      ["out", "fill", "float"], ["out", "borderMask", "float"], ["out", "distance", "float"],
    ]);
  });

  it("lets a Float widen into a vector pin on the canvas", () => {
    const float = {
      id: "out",
      name: "Out",
      kind: "data" as const,
      direction: "out" as const,
      type: { kind: "float" },
    };
    const vec3 = {
      id: "baseColor",
      name: "Base Color",
      kind: "data" as const,
      direction: "in" as const,
      type: { kind: "vec3" },
    };
    expect(materialPinsAreCompatible(float, vec3)).toBe(true);
  });

  it("allows truncation to a narrower vector on the canvas", () => {
    const vec4 = {
      id: "out",
      name: "Out",
      kind: "data" as const,
      direction: "out" as const,
      type: { kind: "vec4" },
    };
    const vec3 = {
      id: "baseColor",
      name: "Base Color",
      kind: "data" as const,
      direction: "in" as const,
      type: { kind: "vec3" },
    };
    expect(materialPinsAreCompatible(vec4, vec3)).toBe(true);
  });

  it("lets a generic pin accept any numeric value", () => {
    const generic = {
      id: "a",
      name: "A",
      kind: "data" as const,
      direction: "in" as const,
      type: { kind: "generic" },
    };
    const vec2 = {
      id: "out",
      name: "Out",
      kind: "data" as const,
      direction: "out" as const,
      type: { kind: "vec2" },
    };
    expect(materialPinsAreCompatible(vec2, generic)).toBe(true);
  });

  it("never connects a texture to a numeric pin", () => {
    const texture = {
      id: "out",
      name: "Out",
      kind: "data" as const,
      direction: "out" as const,
      type: { kind: "texture" },
    };
    const generic = {
      id: "a",
      name: "A",
      kind: "data" as const,
      direction: "in" as const,
      type: { kind: "generic" },
    };
    expect(materialPinsAreCompatible(texture, generic)).toBe(false);
  });

  it("titles a node on its own as the canvas does, from its properties and the functions it calls", () => {
    const fn = { ...createDefaultMaterialFunctionDocument(), name: "Wave Blend" };
    expect(materialNodeTitle({ type: "vector.swizzle", properties: { components: "zx" } })).toBe("Swizzle (ZX)");
    expect(materialNodeTitle({ type: "vector.mask", properties: { r: true, b: true } })).toBe("Component Mask (XZ)");
    expect(materialNodeTitle({ type: "param.float", properties: { name: "Roughness Scale" } })).toBe("Roughness Scale");
    expect(materialNodeTitle({ type: "function.call", properties: { functionGuid: "wave" } }, { functions: { wave: fn } })).toBe("Wave Blend");
    expect(materialNodeTitle({ type: "noise.perlin", properties: {} })).toBe("Perlin Noise");
  });
});

describe("Named Reroutes on the canvas", () => {
  const wire = (id: string, sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) =>
    ({ id, sourceNodeId, sourcePinId, targetNodeId, targetPinId });
  const declaration = (id: string, name: string, color: number[]) =>
    ({ id, type: "reroute.declaration", position: { x: 0, y: 0 }, properties: { name, color } });
  const usage = (id: string, declarationId: string) =>
    ({ id, type: "reroute.usage", position: { x: 0, y: 0 }, properties: { declarationId } });

  function rerouted() {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      { id: "albedo", type: "param.texture", position: { x: 0, y: 0 }, properties: { name: "Albedo", textureGuid: "tex" } },
      { id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: {} },
      declaration("tex", "Albedo Texture", [1, 0, 0]), usage("texUse", "tex"),
      declaration("empty", "Empty", [0, 0.5, 1]), usage("emptyUse", "empty"),
      usage("lost", "gone"),
    );
    doc.edges.push(wire("e-albedo-tex", "albedo", "out", "tex", "in"), wire("e-use-sample", "texUse", "out", "sample", "texture"));
    return doc;
  }

  it("titles and colours declarations and their usages and types their pins by what the declaration carries", () => {
    const nodes = new Map(hydrateMaterialGraphForEditor(materialGraphToSerialized(rerouted())).nodes.map((node) => [node.id, node.data]));
    const summary = (id: string) => {
      const data = nodes.get(id)!;
      return { title: data.title, header: data.__headerColor, pins: (data.__pins as { id: string; type: unknown; typeLabel: string }[]).map((pin) => [pin.id, pin.type, pin.typeLabel]) };
    };
    expect(summary("tex")).toEqual({ title: "Albedo Texture", header: "rgb(255, 0, 0)", pins: [["in", { kind: "texture", wildcard: true }, "Texture"]] });
    expect(summary("texUse")).toEqual({ title: "Albedo Texture", header: "rgb(255, 0, 0)", pins: [["out", { kind: "texture" }, "Texture"]] });
    expect(summary("empty")).toEqual({ title: "Empty", header: "rgb(0, 128, 255)", pins: [["in", { kind: "wildcard" }, "Any"]] });
    expect(summary("emptyUse")).toEqual({ title: "Empty", header: "rgb(0, 128, 255)", pins: [["out", { kind: "wildcard" }, "Numeric"]] });
    expect(summary("lost")).toEqual({ title: "Missing Reroute", header: undefined, pins: [["out", { kind: "wildcard" }, "Numeric"]] });
  });

  it("never saves the header colour or title it hydrates", () => {
    const doc = rerouted();
    const saved = serializedToMaterialGraph(hydrateMaterialGraphForEditor(materialGraphToSerialized(doc)), doc);
    expect(saved.nodes.find((node) => node.id === "tex")?.properties).toEqual({ name: "Albedo Texture", color: [1, 0, 0] });
    expect(saved.nodes.find((node) => node.id === "texUse")?.properties).toEqual({ declarationId: "tex" });
  });

  it("connects any output to a declaration's input and a usage as the type it carries", () => {
    const pins = new Map(hydrateMaterialGraphForEditor(materialGraphToSerialized(rerouted())).nodes.flatMap((node) =>
      (node.data.__pins as MaterialGraphPin[]).map((pin): [string, MaterialGraphPin] => [`${node.id}.${pin.id}`, pin])));
    const connects = (from: string, to: string) => materialPinsAreCompatible(pins.get(from)!, pins.get(to)!);
    expect(connects("albedo.out", "empty.in")).toBe(true);
    // A wired declaration shows its type yet still takes another.
    expect(connects("baseColor.out", "tex.in")).toBe(true);
    expect(connects("texUse.out", "sample.texture")).toBe(true);
    expect(connects("texUse.out", "output.metallic")).toBe(false);
    expect(connects("emptyUse.out", "output.metallic")).toBe(true);
    expect(connects("emptyUse.out", "sample.texture")).toBe(false);
  });

  it("lists Create Named Reroute… first, then one usage row per declaration by name", () => {
    const doc = rerouted();
    doc.nodes.push(declaration("b", "Blend", [0, 1, 0]));
    const rows = namedReroutePaletteNodes(doc);
    expect(rows.map((row) => ({ id: row.id, nodeType: row.nodeType, title: row.title, nodeTitle: row.nodeTitle, category: row.category, headerColor: row.headerColor, defaultData: row.defaultData, pins: row.pins.map((pin) => [pin.id, pin.direction, pin.type]) }))).toEqual([
      {
        id: "reroute.declaration", nodeType: "reroute.declaration", title: "Create Named Reroute…", nodeTitle: "Reroute", category: "Reroute",
        // Three declarations already: the fourth default colour.
        headerColor: "rgb(89, 191, 89)",
        defaultData: { name: "Reroute", color: [0.35, 0.75, 0.35], __material: true, __headerColor: "rgb(89, 191, 89)" },
        pins: [["in", "in", { kind: "wildcard" }]],
      },
      {
        id: "reroute.usage:tex", nodeType: "reroute.usage", title: "Albedo Texture", nodeTitle: "Albedo Texture", category: "Reroute", headerColor: "rgb(255, 0, 0)",
        defaultData: { declarationId: "tex", __material: true, __headerColor: "rgb(255, 0, 0)" }, pins: [["out", "out", { kind: "texture" }]],
      },
      {
        id: "reroute.usage:b", nodeType: "reroute.usage", title: "Blend", nodeTitle: "Blend", category: "Reroute", headerColor: "rgb(0, 255, 0)",
        defaultData: { declarationId: "b", __material: true, __headerColor: "rgb(0, 255, 0)" }, pins: [["out", "out", { kind: "wildcard" }]],
      },
      {
        id: "reroute.usage:empty", nodeType: "reroute.usage", title: "Empty", nodeTitle: "Empty", category: "Reroute", headerColor: "rgb(0, 128, 255)",
        defaultData: { declarationId: "empty", __material: true, __headerColor: "rgb(0, 128, 255)" }, pins: [["out", "out", { kind: "wildcard" }]],
      },
    ]);
  });

  it("names and colours declarations added or pasted into a Material or Material Function", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(declaration("first", "Reroute", [1, 1, 1]));
    const graph = materialGraphToSerialized(doc);
    graph.nodes.push(
      { id: "pasted", type: "reroute.declaration", position: { x: 0, y: 0 }, data: { name: "Reroute", color: [0, 0, 1] } },
      { id: "added", type: "reroute.declaration", position: { x: 0, y: 0 }, data: {} },
    );
    const saved = serializedToMaterialGraph(graph, doc);
    expect(saved.nodes.filter((node) => node.type === "reroute.declaration").map((node) => [node.id, node.properties])).toEqual([
      ["first", { name: "Reroute", color: [1, 1, 1] }],
      ["pasted", { name: "Reroute_1", color: [0, 0, 1] }],
      ["added", { name: "Reroute_2", color: [0.9, 0.8, 0.25] }],
    ]);

    const fn = createDefaultMaterialFunctionDocument("Body");
    const fnGraph = materialGraphToSerialized(fn);
    fnGraph.nodes.push({ id: "inner", type: "reroute.declaration", position: { x: 0, y: 0 }, data: {} });
    expect(serializedToMaterialFunctionGraph(fnGraph, fn).nodes.find((node) => node.id === "inner")?.properties).toEqual({ name: "Reroute", color: [0.9, 0.3, 0.3] });
  });

  it("titles a usage on its own by its declaration when given the graph", () => {
    const doc = rerouted();
    expect(materialNodeTitle({ type: "reroute.usage", properties: { declarationId: "tex" } }, { graphNodes: doc.nodes })).toBe("Albedo Texture");
    expect(materialNodeTitle({ type: "reroute.usage", properties: { declarationId: "gone" } }, { graphNodes: doc.nodes })).toBe("Missing Reroute");
    expect(materialNodeTitle({ type: "reroute.declaration", properties: { name: "Blend" } })).toBe("Blend");
  });
});
