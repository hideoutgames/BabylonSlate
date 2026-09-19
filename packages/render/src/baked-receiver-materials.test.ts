import { afterEach, describe, expect, it } from "vitest";
import {
  MeshBuilder,
  MultiMaterial,
  NullEngine,
  PBRMaterial,
  PointLight,
  RawTexture,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import type {
  BakedLightingSource,
  BakedReceiverBinding,
} from "@babylonslate/core";
import { CelMaterial } from "./cel-material";
import { BakedReceiverMaterials } from "./baked-receiver-materials";
import type { RuntimeIrradianceBinding } from "./scene-baked-lighting";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function host() {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

const contributions = (
  entries: Array<{
    sourceId: string;
    term: "directAndIndirect" | "indirectOnly" | "environmentDiffuse";
  }>,
): BakedReceiverBinding["contributions"] => entries;

function bindingFor(
  scene: Scene,
  entries: BakedReceiverBinding["contributions"],
): RuntimeIrradianceBinding {
  return {
    texture: RawTexture.CreateRGBATexture(
      new Uint8Array(16).fill(255),
      1,
      1,
      scene,
      false,
    ),
    receiver: {
      identity: {
        actorId: "receiver",
        componentId: "mesh",
        primitive: { kind: "mesh" },
      },
      mobility: "static",
      hashes: { geometry: "g", uv: "u", transforms: "t", materials: "m" },
      atlasGuid: "atlas",
      scale: [1, 1],
      offset: [0, 0],
      contributions: entries,
    },
    assetGuid: "bake",
  };
}

const sources = new Map<string, BakedLightingSource>([
  [
    "sun",
    {
      id: "sun",
      kind: "light",
      actorId: "lamp",
      componentId: "light",
      mobility: "static",
      inputHash: "h",
    },
  ],
]);

describe("baked receiver materials", () => {
  it("clones the PBR material, attaches the baked plugin and excludes only directAndIndirect lights", () => {
    const scene = host();
    const pbr = new PBRMaterial("albedo", scene);
    const mesh = MeshBuilder.CreateBox("receiver", {}, scene);
    mesh.material = pbr;
    const direct = new PointLight("direct", Vector3.Zero(), scene);
    const indirect = new PointLight("indirect", Vector3.Zero(), scene);
    const all = new Map<string, BakedLightingSource>(sources);
    all.set("fill", {
      id: "fill",
      kind: "light",
      actorId: "fill",
      componentId: "light",
      mobility: "stationary",
      inputHash: "h",
    });
    const receivers = new BakedReceiverMaterials(scene);
    const variant = receivers.apply(
      mesh,
      bindingFor(
        scene,
        contributions([
          { sourceId: "sun", term: "directAndIndirect" },
          { sourceId: "fill", term: "indirectOnly" },
        ]),
      ),
      all,
      (source) => (source.actorId === "lamp" ? direct : indirect),
    );
    expect(variant).not.toBeNull();
    expect(variant).not.toBe(pbr);
    expect(mesh.material).toBe(variant);
    expect(variant!.pluginManager!.getPlugin("SlateBakedIrradiance")).not.toBeNull();
    expect(direct.excludedMeshes).toContain(mesh);
    expect(indirect.excludedMeshes).not.toContain(mesh);
  });

  it("zeroes PBR environment intensity only when the atlas carries environment irradiance", () => {
    const scene = host();
    const receivers = new BakedReceiverMaterials(scene);
    const baked = MeshBuilder.CreateBox("baked-env", {}, scene);
    baked.material = new PBRMaterial("env", scene);
    const withEnvironment = receivers.apply(
      baked,
      bindingFor(
        scene,
        contributions([{ sourceId: "sky", term: "environmentDiffuse" }]),
      ),
      sources,
      () => null,
    );
    expect((withEnvironment as PBRMaterial).environmentIntensity).toBe(0);
    const directOnly = MeshBuilder.CreateBox("direct-only", {}, scene);
    const directMaterial = new PBRMaterial("direct", scene);
    directMaterial.environmentIntensity = 0.5;
    directOnly.material = directMaterial;
    const withoutEnvironment = receivers.apply(
      directOnly,
      bindingFor(
        scene,
        contributions([{ sourceId: "sun", term: "directAndIndirect" }]),
      ),
      sources,
      () => null,
    );
    expect((withoutEnvironment as PBRMaterial).environmentIntensity).toBe(0.5);
  });

  it("leaves unlit and lighting-disabled receivers on their original material", () => {
    const scene = host();
    const receivers = new BakedReceiverMaterials(scene);
    const binding = bindingFor(
      scene,
      contributions([{ sourceId: "sun", term: "directAndIndirect" }]),
    );
    const unlit = MeshBuilder.CreateBox("unlit", {}, scene);
    const unlitMaterial = new PBRMaterial("unlit", scene);
    unlitMaterial.unlit = true;
    unlit.material = unlitMaterial;
    expect(receivers.apply(unlit, binding, sources, () => null)).toBeNull();
    expect(unlit.material).toBe(unlitMaterial);
    const flat = MeshBuilder.CreateBox("flat", {}, scene);
    const flatMaterial = new StandardMaterial("flat", scene);
    flatMaterial.disableLighting = true;
    flat.material = flatMaterial;
    expect(receivers.apply(flat, binding, sources, () => null)).toBeNull();
    expect(flat.material).toBe(flatMaterial);
    const adapter = MeshBuilder.CreateBox("adapter", {}, scene);
    const cel = new CelMaterial(new PBRMaterial("cel-source", scene), scene);
    cel.disableLighting = true;
    adapter.material = cel;
    expect(receivers.apply(adapter, binding, sources, () => null)).toBeNull();
    expect(adapter.material).toBe(cel);
  });

  it("re-wraps a CEL adapter around the same source and restores it on release", () => {
    const scene = host();
    const receivers = new BakedReceiverMaterials(scene);
    const mesh = MeshBuilder.CreateBox("cel", {}, scene);
    const cel = new CelMaterial(new PBRMaterial("source", scene), scene);
    mesh.material = cel;
    const variant = receivers.apply(
      mesh,
      bindingFor(
        scene,
        contributions([{ sourceId: "sun", term: "directAndIndirect" }]),
      ),
      sources,
      () => null,
    );
    expect(variant).toBeInstanceOf(CelMaterial);
    expect(variant).not.toBe(cel);
    expect(variant!.pluginManager!.getPlugin("SlateBakedIrradiance")).not.toBeNull();
    expect(mesh.material).toBe(variant);
    receivers.release();
    expect(mesh.material).toBe(cel);
  });

  it("clones MultiMaterial children and restores the shared material on release", () => {
    const scene = host();
    const receivers = new BakedReceiverMaterials(scene);
    const multi = new MultiMaterial("multi", scene);
    const pbr = new PBRMaterial("pbr", scene);
    const standard = new StandardMaterial("standard", scene);
    multi.subMaterials = [pbr, standard];
    const mesh = MeshBuilder.CreateBox("multi-mesh", {}, scene);
    mesh.material = multi;
    const variant = receivers.apply(
      mesh,
      bindingFor(
        scene,
        contributions([{ sourceId: "sun", term: "directAndIndirect" }]),
      ),
      sources,
      () => null,
    ) as MultiMaterial;
    expect(variant).toBeInstanceOf(MultiMaterial);
    expect(variant.subMaterials[0]).not.toBe(pbr);
    expect(variant.subMaterials[1]).not.toBe(standard);
    expect(
      variant.subMaterials[0]!.pluginManager!.getPlugin("SlateBakedIrradiance"),
    ).not.toBeNull();
    receivers.release();
    expect(mesh.material).toBe(multi);
  });

  it("re-wraps around a foreign material assignment and restores the newer material on release", () => {
    const scene = host();
    const receivers = new BakedReceiverMaterials(scene);
    const mesh = MeshBuilder.CreateBox("retarget", {}, scene);
    const pbr = new PBRMaterial("pbr", scene);
    mesh.material = pbr;
    const binding = bindingFor(
      scene,
      contributions([{ sourceId: "sun", term: "directAndIndirect" }]),
    );
    receivers.apply(mesh, binding, sources, () => null);
    const replacement = new StandardMaterial("replacement", scene);
    mesh.material = replacement;
    expect(mesh.material).not.toBe(replacement);
    expect(mesh.material!.name).toBe("baked:replacement");
    receivers.release();
    expect(mesh.material).toBe(replacement);
    expect(scene.materials).toContain(pbr);
  });

  it("restores the original material and removes exclusions on release", () => {
    const scene = host();
    const receivers = new BakedReceiverMaterials(scene);
    const mesh = MeshBuilder.CreateBox("release", {}, scene);
    const pbr = new PBRMaterial("pbr", scene);
    mesh.material = pbr;
    const light = new PointLight("lamp", Vector3.Zero(), scene);
    receivers.apply(
      mesh,
      bindingFor(
        scene,
        contributions([{ sourceId: "sun", term: "directAndIndirect" }]),
      ),
      sources,
      () => light,
    );
    const variant = mesh.material!;
    expect(light.excludedMeshes).toContain(mesh);
    receivers.release();
    expect(mesh.material).toBe(pbr);
    expect(light.excludedMeshes).not.toContain(mesh);
    expect(scene.materials).not.toContain(variant);
    // A released owner is terminal: later applies are ignored, not rebound.
    expect(
      receivers.apply(
        mesh,
        bindingFor(
          scene,
          contributions([{ sourceId: "sun", term: "directAndIndirect" }]),
        ),
        sources,
        () => light,
      ),
    ).toBeNull();
    expect(mesh.material).toBe(pbr);
  });
});
