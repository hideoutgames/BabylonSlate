import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine, Scene, Texture } from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  type MaterialDocument,
} from "@babylonslate/shader-graph";
import { MaterialLibrary } from "./material-library";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { getMaterialTexture, ResourceCache } from "./resource-cache";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

function host(): Scene {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  disposers.push(() => {
    scene.dispose();
    engine.dispose();
  });
  return scene;
}

function tinted(value: number): MaterialDocument {
  const doc = createDefaultMaterialDocument();
  doc.nodes[0]!.properties = { value: [value, 0, 0, 1] };
  return doc;
}

describe("material library", () => {
  it("compiles a material document for a scene", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const result = library.acquire(scene, "mat-1", tinted(1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.getClassName()).toBe("NodeMaterial");
  });

  it("recompiles when the cached material was disposed without release", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "mat-1", tinted(1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.material.dispose();
    expect(library.materialFor(scene, "mat-1")).toBeNull();
    expect(library.isCompiled(scene, "mat-1", tinted(1))).toBe(false);
    const second = library.acquire(scene, "mat-1", tinted(1));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.material).not.toBe(first.material);
    expect(scene.materials).toContain(second.material);
    expect(scene.materials).not.toContain(first.material);
  });

  it("invalidates cached materials so the next acquire rebuilds them", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "mat-1", tinted(1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    library.invalidate();
    expect(scene.materials).not.toContain(first.material);
    const second = library.acquire(scene, "mat-1", tinted(1));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.material).not.toBe(first.material);
    expect(scene.materials).toContain(second.material);
  });

  it("reuses one compiled material for the same graph in the same scene", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "mat-1", tinted(1));
    const second = library.acquire(scene, "mat-1", tinted(1));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.material).toBe(first.material);
  });

  it("recompiles when the graph content changes", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "mat-1", tinted(1));
    const second = library.acquire(scene, "mat-1", tinted(0.25));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.material).not.toBe(first.material);
  });

  it("never shares one material instance across two scenes", () => {
    const first = host();
    const second = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const a = library.acquire(first, "mat-1", tinted(1));
    const b = library.acquire(second, "mat-1", tinted(1));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.material).not.toBe(b.material);
  });

  it("keeps a PBR compile next to an unlit overlay compile for the same guid", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const pbr = library.acquire(scene, "mat-1", tinted(1));
    const unlit = library.acquire(scene, "mat-1", tinted(1), { unlit: true });
    expect(pbr.ok && unlit.ok).toBe(true);
    if (!pbr.ok || !unlit.ok) return;
    expect(unlit.material).not.toBe(pbr.material);
    expect(library.materialFor(scene, "mat-1")).toBe(pbr.material);
    expect(library.materialFor(scene, "mat-1", { unlit: true })).toBe(
      unlit.material,
    );
  });

  it("keeps a material alive until the last reference is released", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const result = library.acquire(scene, "mat-1", tinted(1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    library.acquire(scene, "mat-1", tinted(1));
    library.release(scene, "mat-1");
    expect(scene.materials).toContain(result.material);
    library.release(scene, "mat-1");
    expect(scene.materials).not.toContain(result.material);
  });

  it("reports compile diagnostics instead of throwing", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const broken = createDefaultMaterialDocument();
    broken.nodes.push({
      id: "bogus",
      type: "math.doesNotExist",
      position: { x: 0, y: 0 },
      properties: {},
    });
    const result = library.acquire(scene, "mat-1", broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("resolves textures through the injected provider", () => {
    const scene = host();
    const texture = new Texture(null, scene, true, false);
    disposers.push(() => texture.dispose());
    const resolveTexture = vi.fn(() => texture);
    const library = new MaterialLibrary({ resolveTexture });
    disposers.push(() => library.dispose());
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      {
        id: "tex",
        type: "param.texture",
        position: { x: 0, y: 0 },
        properties: { textureGuid: "tex-1" },
      },
      {
        id: "texUv",
        type: "input.uv",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "sample",
        type: "texture.sample",
        position: { x: 0, y: 0 },
        properties: {},
      },
    );
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push(
      {
        id: "e-tex",
        sourceNodeId: "tex",
        sourcePinId: "out",
        targetNodeId: "sample",
        targetPinId: "texture",
      },
      {
        id: "e-uv",
        sourceNodeId: "texUv",
        sourcePinId: "uv",
        targetNodeId: "sample",
        targetPinId: "uv",
      },
      {
        id: "e-out",
        sourceNodeId: "sample",
        sourcePinId: "rgb",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    );
    library.acquire(scene, "mat-1", doc);
    expect(resolveTexture).toHaveBeenCalledWith("tex-1");
  });

  it("does not dispose a ResourceCache Texture when a compiled material is released", () => {
    const scene = host();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    disposers.push(() => cache.dispose());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const cached = getMaterialTexture(
      cache,
      "tex-1",
      scene.getEngine(),
      bytes,
    );
    expect(cached).not.toBeNull();
    const library = new MaterialLibrary({
      resolveTexture: (guid) => (guid === "tex-1" ? cached : null),
    });
    disposers.push(() => library.dispose());
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      {
        id: "tex",
        type: "param.texture",
        position: { x: 0, y: 0 },
        properties: { textureGuid: "tex-1" },
      },
      {
        id: "texUv",
        type: "input.uv",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "sample",
        type: "texture.sample",
        position: { x: 0, y: 0 },
        properties: {},
      },
    );
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push(
      {
        id: "e-tex",
        sourceNodeId: "tex",
        sourcePinId: "out",
        targetNodeId: "sample",
        targetPinId: "texture",
      },
      {
        id: "e-uv",
        sourceNodeId: "texUv",
        sourcePinId: "uv",
        targetNodeId: "sample",
        targetPinId: "uv",
      },
      {
        id: "e-out",
        sourceNodeId: "sample",
        sourcePinId: "rgb",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    );
    const acquired = library.acquire(scene, "mat-1", doc);
    expect(acquired.ok).toBe(true);
    library.release(scene, "mat-1");
    expect(isDisposedGpuTexture(cached!)).toBe(false);
  });

  it("drops every material for a scene when that scene is released", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const result = library.acquire(scene, "mat-1", tinted(1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    library.releaseScene(scene);
    expect(scene.materials).not.toContain(result.material);
  });

  it("reports whether a graph is already compiled for a scene", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    expect(library.isCompiled(scene, "mat-1", tinted(1))).toBe(false);
    library.acquire(scene, "mat-1", tinted(1));
    expect(library.isCompiled(scene, "mat-1", tinted(1))).toBe(true);
  });
});
