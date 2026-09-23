import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshBuilder, NullEngine, Scene, Texture, TextureBlock } from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  type MaterialDocument,
} from "@babylonslate/shader-graph";
import { MaterialLibrary } from "./material-library";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { acquireMaterialTexture, ResourceCache, type ResourceLease } from "./resource-cache";

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

function textureDocument(textureGuid: string): MaterialDocument {
  const doc = createDefaultMaterialDocument();
  doc.nodes.push(
    { id: "texture", type: "param.texture", position: { x: 0, y: 0 }, properties: { name: "Albedo", textureGuid } },
    { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
    { id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: {} },
  );
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
  doc.edges.push(
    { id: "texture-sample", sourceNodeId: "texture", sourcePinId: "out", targetNodeId: "sample", targetPinId: "texture" },
    { id: "uv-sample", sourceNodeId: "uv", sourcePinId: "uv", targetNodeId: "sample", targetPinId: "uv" },
    { id: "sample-output", sourceNodeId: "sample", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "baseColor" },
  );
  return doc;
}

/** Delay the real cache's header measurement, after NullEngine's upload is ready. */
function deferredTextureSource() {
  const source = new Blob([new Uint8Array([5, 6, 7])]);
  const header = source.slice(0, 64 * 1024);
  let finish!: (value: ArrayBuffer) => void;
  const bytes = new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
  const read = vi.spyOn(header, "arrayBuffer").mockReturnValue(bytes);
  const slice = vi.spyOn(source, "slice").mockReturnValue(header);
  disposers.push(() => { finish(new ArrayBuffer(0)); read.mockRestore(); slice.mockRestore(); });
  return { source, finish: () => finish(new ArrayBuffer(0)) };
}

function textureLibrary() {
  const scene = host();
  const cache = new ResourceCache({ byteCeiling: 16 * 1024 * 1024 });
  disposers.push(() => cache.dispose());
  const sources = new Map<string, Uint8Array | Blob>([["first", new Uint8Array([1, 2, 3])]]);
  const leases = new Map<string, ResourceLease<Texture>>();
  const onTextureError = vi.fn();
  const library = new MaterialLibrary({
    acquireTexture: (guid) => {
      const source = sources.get(guid);
      if (!source) return null;
      const lease = acquireMaterialTexture(cache, guid, scene.getEngine(), source)!;
      leases.set(guid, lease);
      return lease;
    },
    textureIdentity: (guid) => sources.has(guid) ? guid : undefined,
    onTextureError,
  });
  disposers.push(() => library.dispose());
  return { scene, cache, sources, leases, library, onTextureError };
}

describe("material library", () => {
  it("keeps compile-time texture preparation alive when an initial override replaces its binding", async () => {
    const f = textureLibrary();
    const initial = deferredTextureSource();
    f.sources.set("first", initial.source);
    f.sources.set("next", new Uint8Array([4, 5, 6]));
    const acquired = f.library.acquire(f.scene, "material", textureDocument("first"));
    if (!acquired.ok) throw new Error("Material did not compile");
    expect(f.library.setParameter(f.scene, "material", "Albedo", { kind: "texture", textureAssetGuid: "next" })).toBe(true);
    await f.leases.get("next")!.ready;
    initial.finish();
    expect(await acquired.ready).toEqual([]);
    expect(f.library.isReady(f.scene, "material", textureDocument("first"))).toBe(true);
    expect((acquired.material.getBlockByName("sample") as TextureBlock).texture).toBe(f.leases.get("next")!.resource);
    expect(f.onTextureError).not.toHaveBeenCalled();
  });

  it("preserves the working texture parameter when native-ready replacement fails delayed admission", async () => {
    const f = textureLibrary();
    const deferred = deferredTextureSource();
    const material = f.library.acquire(f.scene, "material", textureDocument("first"));
    if (!material.ok) throw new Error("Material did not compile");
    await material.ready;
    const sample = material.material.getBlockByName("sample") as TextureBlock;
    const working = sample.texture;
    f.sources.set("next", deferred.source);
    f.cache.setByteCeiling(f.cache.accountedBytes() + 1);

    expect(f.library.setParameter(f.scene, "material", "Albedo", { kind: "texture", textureAssetGuid: "next" })).toBe(true);
    const next = f.leases.get("next")!;
    expect(next.resource.isReady()).toBe(true);
    expect(sample.texture).toBe(working);
    expect(f.cache.resourceStats().leases).toBe(2);
    deferred.finish();
    await expect(next.ready).rejects.toThrow("byte budget");
    expect(sample.texture).toBe(working);
    expect(working?.isReady()).toBe(true);
    expect(f.library.getParameter(f.scene, "material", "Albedo")).toEqual({ kind: "texture", textureAssetGuid: "first" });
    expect(isDisposedGpuTexture(next.resource)).toBe(true);
    expect(f.cache.resourceStats().leases).toBe(1);
    expect(f.onTextureError).toHaveBeenCalledOnce();
  });

  it("preserves the current texture when resetting its default fails delayed admission", async () => {
    const f = textureLibrary();
    const deferred = deferredTextureSource();
    const material = f.library.acquire(f.scene, "material", textureDocument("first"));
    if (!material.ok) throw new Error("Material did not compile");
    await material.ready;
    const sample = material.material.getBlockByName("sample") as TextureBlock;
    f.sources.set("next", new Uint8Array([4, 5, 6]));
    expect(f.library.setParameter(f.scene, "material", "Albedo", { kind: "texture", textureAssetGuid: "next" })).toBe(true);
    await f.leases.get("next")!.ready;
    const working = sample.texture;
    expect(working).toBe(f.leases.get("next")!.resource);
    f.cache.flushUnreferenced();
    f.sources.set("first", deferred.source);
    f.cache.setByteCeiling(f.cache.accountedBytes() + 1);

    expect(f.library.resetParameter(f.scene, "material", "Albedo")).toBe(true);
    const reset = f.leases.get("first")!;
    expect(reset.resource.isReady()).toBe(true);
    expect(sample.texture).toBe(working);
    deferred.finish();
    await expect(reset.ready).rejects.toThrow("byte budget");
    expect(sample.texture).toBe(working);
    expect(f.library.getParameter(f.scene, "material", "Albedo")).toEqual({ kind: "texture", textureAssetGuid: "next" });
    expect(f.cache.resourceStats().leases).toBe(1);
  });

  it("ignores a superseded native-ready parameter completion", async () => {
    const f = textureLibrary();
    const deferred = deferredTextureSource();
    const material = f.library.acquire(f.scene, "material", textureDocument("first"));
    if (!material.ok) throw new Error("Material did not compile");
    await material.ready;
    const sample = material.material.getBlockByName("sample") as TextureBlock;
    f.sources.set("obsolete", deferred.source);
    f.sources.set("winner", new Uint8Array([8, 9, 10]));
    f.library.setParameter(f.scene, "material", "Albedo", { kind: "texture", textureAssetGuid: "obsolete" });
    f.library.setParameter(f.scene, "material", "Albedo", { kind: "texture", textureAssetGuid: "winner" });
    await f.leases.get("winner")!.ready;
    expect(sample.texture).toBe(f.leases.get("winner")!.resource);
    deferred.finish();
    await expect(f.leases.get("obsolete")!.ready).rejects.toThrow("final owner");
    expect(sample.texture).toBe(f.leases.get("winner")!.resource);
    expect(f.cache.resourceStats().leases).toBe(1);
    expect(f.onTextureError).not.toHaveBeenCalled();
  });

  it("retains the published material generation until its native-ready texture passes admission", async () => {
    const f = textureLibrary();
    const deferred = deferredTextureSource();
    const first = f.library.acquire(f.scene, "material", textureDocument("first"));
    if (!first.ok) throw new Error("Material did not compile");
    await first.ready;
    const mesh = MeshBuilder.CreatePlane("working", {}, f.scene);
    mesh.material = first.material;
    f.sources.set("next", deferred.source);
    f.cache.setByteCeiling(f.cache.accountedBytes() + 1);
    const document = textureDocument("next");
    const next = f.library.acquire(f.scene, "material", document);
    if (!next.ok) throw new Error("Replacement did not compile");
    expect(f.leases.get("next")!.resource.isReady()).toBe(true);
    expect(f.library.materialFor(f.scene, "material")).toBe(first.material);
    expect(f.library.isReady(f.scene, "material", document)).toBe(false);
    expect(mesh.material).toBe(first.material);
    deferred.finish();
    expect(await next.ready).toEqual([expect.objectContaining({ message: expect.stringContaining("byte budget") })]);
    expect(f.library.materialFor(f.scene, "material")).toBe(first.material);
    expect(mesh.material).toBe(first.material);
    expect(f.scene.materials).toContain(first.material);
    expect(f.scene.materials).not.toContain(next.material);
    expect(f.cache.resourceStats().leases).toBe(1);
  });

  it("settles cancelled material preparation without waiting for a pending texture header", async () => {
    const f = textureLibrary();
    const deferred = deferredTextureSource();
    f.sources.set("pending", deferred.source);
    const material = f.library.acquire(f.scene, "material", textureDocument("pending"));
    if (!material.ok) throw new Error("Material did not compile");
    f.library.release(f.scene, "material");
    expect(await material.ready).toEqual([expect.objectContaining({ code: "material.compile.cancelled" })]);
    expect(f.scene.materials).not.toContain(material.material);
    expect(f.cache.resourceStats().leases).toBe(0);
  });

  it("retains the displayed material while dependencies are marked dirty", async () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "material", tinted(1));
    if (!first.ok) throw new Error("Expected a compiled material");
    await first.ready;
    expect(library.isReady(scene, "material", tinted(1))).toBe(true);
    library.markDirty();
    expect(library.isReady(scene, "material", tinted(1))).toBe(false);
    expect(library.materialFor(scene, "material")).toBe(first.material);
    expect(library.isCompiled(scene, "material", tinted(1))).toBe(false);
    library.release(scene, "material");
    expect(scene.materials).not.toContain(first.material);
  });
  it("retains the last good material when a replacement fails asynchronously", async () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "material", tinted(1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await first.ready).toEqual([]);
    const invalid = tinted(0.2);
    invalid.nodes.push({ id: "normal", type: "shading.normalMap", position: { x: 0, y: 0 }, properties: {} });
    invalid.edges.push({ id: "normal-output", sourceNodeId: "normal", sourcePinId: "normal", targetNodeId: "output", targetPinId: "normal" });
    const replacement = library.acquire(scene, "material", invalid);
    if (replacement.ok) expect((await replacement.ready).length).toBeGreaterThan(0);
    expect(library.materialFor(scene, "material")).toBe(first.material);
    expect(scene.materials).toContain(first.material);
  });
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

  it("validates a resolved plan before taking a cached material reference", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const document = tinted(1);
    const first = library.acquire(scene, "material", document);
    if (!first.ok) throw new Error("Expected a compiled material");
    const denied = library.acquire(scene, "material", document, {
      validatePlan: (plan) => {
        expect(plan.hash).toBe(first.plan.hash);
        return { severity: "error", code: "material.capability", message: "Buffer unavailable" };
      },
    });
    expect(denied).toEqual({ ok: false, diagnostics: [expect.objectContaining({ message: "Buffer unavailable" })] });
    library.release(scene, "material");
    expect(library.materialFor(scene, "material")).toBeNull();
    expect(scene.materials).not.toContain(first.material);
  });

  it("retires only the replaced asset for an owner while preserving its pending successor", async () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const previous = library.acquire(scene, "old", tinted(1), { instanceKey: "actor" });
    const unrelated = library.acquire(scene, "old", tinted(1), { instanceKey: "other-actor" });
    if (!previous.ok || !unrelated.ok) throw new Error("Expected initial private materials");
    await Promise.all([previous.ready, unrelated.ready]);
    const successor = library.acquire(scene, "next", tinted(0.25), { instanceKey: "actor" });
    const obsolete = library.acquire(scene, "old", tinted(0.5), { instanceKey: "actor" });
    if (!successor.ok || !obsolete.ok) throw new Error("Expected pending private materials");

    library.releaseInstance("actor", "old");
    expect(await obsolete.ready).toEqual([expect.objectContaining({ code: "material.compile.cancelled" })]);
    expect(await successor.ready).toEqual([]);
    expect(scene.materials).not.toContain(previous.material);
    expect(scene.materials).not.toContain(obsolete.material);
    expect(library.materialFor(scene, "next", { instanceKey: "actor" })).toBe(successor.material);
    expect(library.materialFor(scene, "old", { instanceKey: "other-actor" })).toBe(unrelated.material);

    library.releaseInstance("actor");
    expect(scene.materials).not.toContain(successor.material);
    expect(scene.materials).toContain(unrelated.material);
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
        properties: { name: "Albedo", textureGuid: "tex-1" },
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

  it("releases material texture ownership without disposing an independent view's lease", async () => {
    const scene = host();
    const cache = new ResourceCache({ byteCeiling: 8 * 1024 * 1024 });
    disposers.push(() => cache.dispose());
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const cachedLease = acquireMaterialTexture(
      cache,
      "tex-1",
      scene.getEngine(),
      bytes,
    );
    const cached = cachedLease?.resource ?? null;
    expect(cached).not.toBeNull();
    const acquire = vi.fn((guid: string) => guid === "tex-1" ? acquireMaterialTexture(cache, guid, scene.getEngine(), bytes) : null);
    const library = new MaterialLibrary({ acquireTexture: acquire, textureIdentity: () => "installed-source" });
    disposers.push(() => library.dispose());
    const doc = createDefaultMaterialDocument();
    doc.nodes.push(
      {
        id: "tex",
        type: "param.texture",
        position: { x: 0, y: 0 },
        properties: { name: "Albedo", textureGuid: "tex-1" },
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
    if (!acquired.ok) throw new Error("Material did not compile");
    await acquired.ready;
    expect(library.isReady(scene, "mat-1", doc)).toBe(true);
    expect(acquire).toHaveBeenCalledOnce();
    expect(cache.resourceStats().leases).toBe(2);
    library.release(scene, "mat-1");
    expect(cache.resourceStats().leases).toBe(1);
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
