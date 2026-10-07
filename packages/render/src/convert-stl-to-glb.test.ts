import { afterEach, describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { importModel } from "@babylonslate/assets";
import { convertStlImportBatch, convertStlToGlb } from "./convert-stl-to-glb";
import { isGltfModelBytes } from "./model-mesh";

const TRIANGLE_STL = `solid tri
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid tri
`;

/** 80-byte header, facet count, then normal + 3 vertices + attribute word. */
function binaryTriangle(): Uint8Array {
  const bytes = new Uint8Array(84 + 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, 1, true);
  const floats = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0];
  floats.forEach((value, index) => view.setFloat32(84 + index * 4, value, true));
  return bytes;
}

function glbPositionCount(glb: Uint8Array): number {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + view.getUint32(12, true))));
  const position = json.meshes[0].primitives[0].attributes.POSITION;
  return json.accessors[position].count;
}

describe("convertStlToGlb", () => {
  const engines: NullEngine[] = [];
  afterEach(() => {
    while (engines.length > 0) engines.pop()?.dispose();
  });
  const engine = () => {
    const created = new NullEngine();
    engines.push(created);
    return created;
  };

  it("converts ASCII and binary STL triangles into Model GLBs", async () => {
    for (const source of [new TextEncoder().encode(TRIANGLE_STL), binaryTriangle()]) {
      const glb = await convertStlToGlb(source, { engine: engine() });
      expect(isGltfModelBytes(glb)).toBe(true);
      expect(glbPositionCount(glb)).toBe(3);
      const results = await importModel(glb, { fileName: "part.glb", existingGuids: new Set() });
      expect(results.map((result) => result.type)).toContain("Model");
    }
  });

  it("converts STL files in a mixed batch and reports files without geometry", async () => {
    const { files, errors } = await convertStlImportBatch(
      [
        { name: "Bracket.STL", bytes: new TextEncoder().encode(TRIANGLE_STL) },
        { name: "empty.stl", bytes: new TextEncoder().encode("not an stl") },
        { name: "unrelated.png", bytes: new Uint8Array([1, 2, 3]) },
      ],
      { engine: engine() },
    );
    expect(files.map((file) => file.name)).toEqual(["Bracket.glb", "unrelated.png"]);
    expect(errors).toEqual(["empty.stl: STL conversion produced no meshes."]);
  });
});
