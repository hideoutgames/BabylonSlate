import { afterEach, describe, expect, it } from "vitest";
import { HemisphericLight, Material, MeshBuilder, NullEngine, Scene, StandardMaterial, Vector3, type Mesh } from "@babylonjs/core";
import { shareHelperProgram } from "./helper-program";

const engines: NullEngine[] = [];
afterEach(() => {
  while (engines.length) engines.pop()!.dispose();
});

function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

/** The define set Babylon keys the material's Effect by for this mesh. */
function definesFor(material: Material, mesh: Mesh): string {
  const subMesh = mesh.subMeshes[0]!;
  mesh.material = material;
  mesh.computeWorldMatrix(true);
  material.isReadyForSubMesh(mesh, subMesh);
  return subMesh.materialDefines!.toString();
}

function unlit(scene: Scene, name: string, transparencyMode: number | null): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.disableLighting = true;
  material.transparencyMode = transparencyMode;
  return material;
}

describe("shared helper programs", () => {
  it("keys an unlit helper's program the same for any mesh scale and transparency mode", () => {
    const scene = fixture();
    const uniform = MeshBuilder.CreateBox("uniform", {}, scene);
    const stretched = MeshBuilder.CreateBox("stretched", {}, scene);
    stretched.scaling.set(3, 1, 0.5);

    // Control: unpinned, the stretched mesh and the transparency mode each change the key.
    const stock = definesFor(unlit(scene, "stock", null), uniform);
    expect(definesFor(unlit(scene, "stock-stretched", null), stretched)).toContain("#define NONUNIFORMSCALING");
    expect(definesFor(unlit(scene, "stock-blend", Material.MATERIAL_ALPHABLEND), uniform)).toContain(
      "#define ALPHATEST_AFTERALLALPHACOMPUTATIONS",
    );
    expect(stock).not.toContain("NONUNIFORMSCALING");

    const keys = new Set([
      definesFor(shareHelperProgram(unlit(scene, "plain", null)), uniform),
      definesFor(shareHelperProgram(unlit(scene, "plain-stretched", null)), stretched),
      definesFor(shareHelperProgram(unlit(scene, "blend", Material.MATERIAL_ALPHABLEND)), uniform),
      definesFor(shareHelperProgram(unlit(scene, "blend-stretched", Material.MATERIAL_ALPHABLEND)), stretched),
    ]);
    expect(keys.size).toBe(1);
  });

  it("keeps the defines a lit or alpha-tested helper's program reads", () => {
    const scene = fixture();
    new HemisphericLight("sky", Vector3.Up(), scene);
    const stretched = MeshBuilder.CreateBox("stretched", {}, scene);
    stretched.scaling.set(3, 1, 0.5);
    const lit = shareHelperProgram(new StandardMaterial("lit", scene));
    expect(definesFor(lit, stretched)).toContain("#define NONUNIFORMSCALING");

    const cutout = shareHelperProgram(unlit(scene, "cutout", Material.MATERIAL_ALPHATEST));
    cutout.needAlphaTestingForMesh = () => true;
    const defines = definesFor(cutout, MeshBuilder.CreateBox("cutout-box", {}, scene));
    expect(defines).toContain("#define ALPHATEST\n");
    expect(defines).toContain("#define ALPHATEST_AFTERALLALPHACOMPUTATIONS");
  });

  it("attaches one plugin however often a material is shared", () => {
    const scene = fixture();
    const material = unlit(scene, "once", null);
    shareHelperProgram(material);
    shareHelperProgram(material);
    expect(material.pluginManager!._plugins.filter((plugin) => plugin.name === "SlateHelperProgram")).toHaveLength(1);
  });
});
