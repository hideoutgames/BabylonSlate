import { describe, expect, it } from "vitest";
import { createDefaultMaterialDocument, type MaterialDocument, type MaterialGraphNode } from "./document";
import {
  nameNewNamedReroutes,
  namedRerouteDeclarations,
  remapPastedNamedReroutes,
  renameNamedReroute,
  uniqueNamedRerouteName,
} from "./named-reroute";
import { createTypeResolver } from "./resolve";
import { hydrateMaterialGraphForEditor, materialGraphToSerialized } from "./serialize-material";
import { materialNodePreviewOutputs } from "./node-preview";
import { listUnconnectedMaterialPinDefaults } from "./pin-defaults";

const wire = (id: string, sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) =>
  ({ id, sourceNodeId, sourcePinId, targetNodeId, targetPinId });
const declaration = (id: string, name: string, color: number[] = [1, 0, 0]): MaterialGraphNode =>
  ({ id, type: "reroute.declaration", position: { x: 0, y: 0 }, properties: { name, color } });
const usage = (id: string, declarationId: string): MaterialGraphNode =>
  ({ id, type: "reroute.usage", position: { x: 0, y: 0 }, properties: { declarationId } });
const parameter = (id: string, name: string): MaterialGraphNode =>
  ({ id, type: "param.float", position: { x: 0, y: 0 }, properties: { name } });

describe("Named Reroute names", () => {
  it("counts up from Reroute among declarations only", () => {
    expect(uniqueNamedRerouteName([])).toBe("Reroute");
    // A parameter's name is another namespace.
    expect(uniqueNamedRerouteName([parameter("p", "Reroute")])).toBe("Reroute");
    expect(uniqueNamedRerouteName([declaration("a", "Reroute")])).toBe("Reroute_1");
    expect(uniqueNamedRerouteName([declaration("a", "Reroute"), declaration("b", "Reroute_1")])).toBe("Reroute_2");
    expect(uniqueNamedRerouteName([declaration("a", "Mask"), declaration("b", "Mask_1")], "Mask_1")).toBe("Mask_2");
    expect(uniqueNamedRerouteName([declaration("a", "Reroute")], "Reroute", "a")).toBe("Reroute");
  });

  it("renames to a free name, ignoring blanks and leaving the nodes as they are when nothing changes", () => {
    const nodes = [declaration("a", "Base"), declaration("b", "Mask"), usage("u", "a")];
    expect(renameNamedReroute(nodes, "b", "  Base ").find((node) => node.id === "b")?.properties.name).toBe("Base_1");
    expect(renameNamedReroute(nodes, "b", " Detail ").find((node) => node.id === "b")?.properties.name).toBe("Detail");
    expect(renameNamedReroute(nodes, "b", "   ")).toBe(nodes);
    expect(renameNamedReroute(nodes, "b", "Mask")).toBe(nodes);
    expect(renameNamedReroute(nodes, "u", "Other")).toBe(nodes);
  });

  it("names and colours only declarations the previous graph lacked, in turn through the default colours", () => {
    const previous = [declaration("a", "Reroute", [1, 1, 1])];
    const nodes = [
      ...previous,
      declaration("pasted", "Reroute", [0, 0, 1]),
      { id: "new1", type: "reroute.declaration", position: { x: 0, y: 0 }, properties: {} },
      { id: "new2", type: "reroute.declaration", position: { x: 0, y: 0 }, properties: { name: "  " } },
    ];
    expect(nameNewNamedReroutes(previous, nodes).map((node) => [node.id, node.properties])).toEqual([
      ["a", { name: "Reroute", color: [1, 1, 1] }],
      ["pasted", { name: "Reroute_1", color: [0, 0, 1] }],
      ["new1", { name: "Reroute_2", color: [0.9, 0.8, 0.25] }],
      ["new2", { name: "Reroute_3", color: [0.35, 0.75, 0.35] }],
    ]);
    const unchanged = [...previous, usage("u", "a")];
    expect(nameNewNamedReroutes(previous, unchanged)).toBe(unchanged);
  });

  it("wraps the default colours after eight declarations", () => {
    const previous = Array.from({ length: 8 }, (_, index) => declaration(`d${index}`, `R${index}`));
    const added = { id: "ninth", type: "reroute.declaration", position: { x: 0, y: 0 }, properties: {} };
    expect(nameNewNamedReroutes(previous, [...previous, added]).at(-1)?.properties.color).toEqual([0.9, 0.3, 0.3]);
  });

  it("lists declarations by name, then id", () => {
    const nodes = [declaration("z", "Beta", [0, 1, 0]), usage("u", "z"), declaration("b", "Alpha"), declaration("a", "Beta"), { ...declaration("c", "Gamma"), properties: { name: "Gamma" } }];
    expect(namedRerouteDeclarations(nodes)).toEqual([
      { nodeId: "b", name: "Alpha", color: [1, 0, 0] },
      { nodeId: "a", name: "Beta", color: [1, 0, 0] },
      { nodeId: "z", name: "Beta", color: [0, 1, 0] },
      { nodeId: "c", name: "Gamma", color: [0.9, 0.3, 0.3] },
    ]);
  });
});

describe("pasting Named Reroutes", () => {
  const canvas = (node: MaterialGraphNode) => ({ id: node.id, type: "pinNode", data: { ...node.properties, __nodeType: node.type } });

  it("points pasted usages at the declaration pasted with them and leaves the rest", () => {
    const pasted = [
      canvas(declaration("r-copy", "Reroute")),
      canvas(usage("u-copy", "r")),
      canvas(usage("other-copy", "kept")),
      canvas(parameter("p-copy", "Scale")),
    ];
    const idMap = new Map([["r", "r-copy"], ["u", "u-copy"], ["other", "other-copy"], ["p", "p-copy"]]);
    expect(remapPastedNamedReroutes(pasted, idMap).map((node) => [node.id, node.data.declarationId])).toEqual([
      ["r-copy", undefined],
      ["u-copy", "r-copy"],
      ["other-copy", "kept"],
      ["p-copy", undefined],
    ]);
  });

  it("keeps a usage pasted without its declaration, and returns the same array", () => {
    const pasted = [canvas(usage("u-copy", "r"))];
    expect(remapPastedNamedReroutes(pasted, new Map([["u", "u-copy"]]))).toBe(pasted);
  });
});

describe("Named Reroute types", () => {
  function graph(): MaterialDocument {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      { id: "scalar", type: "const.float", position: { x: 0, y: 0 }, properties: { value: [1] } },
      { id: "albedo", type: "param.texture", position: { x: 0, y: 0 }, properties: { name: "Albedo" } },
      declaration("f", "Scalar"), usage("fu", "f"),
      declaration("c", "Color"), usage("cu", "c"), usage("cu2", "c"),
      declaration("t", "Texture"), usage("tu", "t"),
      declaration("e", "Empty"), usage("eu", "e"),
      usage("lost", "gone"),
      { id: "add", type: "math.add", position: { x: 0, y: 0 }, properties: {} },
    );
    doc.edges.push(
      wire("e-scalar-f", "scalar", "out", "f", "in"),
      wire("e-color-c", "baseColor", "out", "c", "in"),
      wire("e-albedo-t", "albedo", "out", "t", "in"),
      wire("e-fu-add", "fu", "out", "add", "a"),
      wire("e-cu-add", "cu", "out", "add", "b"),
    );
    return doc;
  }

  it("carries the declaration's wired type to every usage and into generic nodes downstream", () => {
    const resolver = createTypeResolver(graph());
    const types = ["f", "fu", "c", "cu", "cu2", "t", "tu", "e", "eu", "lost"].map((id) => [id, resolver.namedRerouteType(id)]);
    expect(types).toEqual([
      ["f", "float"], ["fu", "float"], ["c", "vec3"], ["cu", "vec3"], ["cu2", "vec3"],
      ["t", "texture"], ["tu", "texture"], ["e", null], ["eu", null], ["lost", null],
    ]);
    expect(["fu", "cu", "tu", "eu", "lost"].map((id) => resolver.outputType(id, "out"))).toEqual(["float", "vec3", "texture", "float", "float"]);
    expect(resolver.inputType("t", "in")).toBe("texture");
    expect(resolver.outputType("add", "out")).toBe("vec3");
  });

  it("previews a usage unless it carries a Texture; a declaration has nothing to preview", () => {
    const doc = graph();
    expect(materialNodePreviewOutputs(doc, "cu")).toEqual([{ pinId: "out", name: "Out" }]);
    expect(materialNodePreviewOutputs(doc, "tu")).toEqual([]);
    expect(materialNodePreviewOutputs(doc, "c")).toEqual([]);
  });

  it("terminates on a declaration that reads itself and on a loop between two", () => {
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      declaration("self", "Self"), usage("selfUse", "self"),
      declaration("x", "X"), usage("xu", "x"), declaration("y", "Y"), usage("yu", "y"),
      { id: "add", type: "math.add", position: { x: 0, y: 0 }, properties: {} },
    );
    doc.edges.push(
      wire("e-self", "selfUse", "out", "self", "in"),
      wire("e-yu-add", "yu", "out", "add", "a"), wire("e-add-x", "add", "out", "x", "in"), wire("e-xu-y", "xu", "out", "y", "in"),
    );

    const resolver = createTypeResolver(doc);
    expect(["self", "selfUse", "x", "xu", "y", "yu"].map((id) => resolver.namedRerouteType(id) ?? "float")).toEqual(["float", "float", "float", "float", "float", "float"]);
    const hydrated = hydrateMaterialGraphForEditor(materialGraphToSerialized(doc));
    expect(hydrated.nodes.find((node) => node.id === "xu")?.data.title).toBe("X");
    expect(materialNodePreviewOutputs(doc, "xu")).toEqual([{ pinId: "out", name: "Out" }]);
    expect(listUnconnectedMaterialPinDefaults(doc, "add")).toEqual([{ pinId: "b", name: "B", type: "float", value: [0] }]);
    expect(listUnconnectedMaterialPinDefaults(doc, "self")).toEqual([]);
  });
});
