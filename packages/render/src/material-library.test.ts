import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshBuilder, NullEngine, PointLight, Scene, Texture, TextureBlock, Vector3, type Effect, type Material } from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  materializeMaterialInstance,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@haptic/shader-graph";
import { MaterialLibrary } from "./material-library";
import { acquireAuthoredMaterialVariant, MaterialCompileStalled } from "./material-compiler";
import { syncSceneLighting } from "./scene-lighting";
import { invalidateShadowReceiverHandoffs } from "./shadow-receiver-handoff";
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

  it("waits for the replacement when a texture parameter is replaced while the build prepares it", async () => {
    const f = textureLibrary();
    const obsolete = deferredTextureSource();
    f.sources.set("obsolete", obsolete.source);
    f.sources.set("winner", new Uint8Array([8, 9, 10]));
    const acquired = f.library.acquire(f.scene, "material", textureDocument("first"));
    if (!acquired.ok) throw new Error("Material did not compile");
    expect(f.library.setParameter(f.scene, "material", "Albedo", { kind: "texture", textureAssetGuid: "obsolete" })).toBe(true);
    // Let the compile settle, so the build is waiting on the parameter's texture.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.library.setParameter(f.scene, "material", "Albedo", { kind: "texture", textureAssetGuid: "winner" })).toBe(true);
    obsolete.finish();
    expect(await acquired.ready).toEqual([]);
    expect(f.library.materialFor(f.scene, "material")).toBe(acquired.material);
    expect(f.scene.materials).toContain(acquired.material);
    expect((acquired.material.getBlockByName("sample") as TextureBlock).texture).toBe(f.leases.get("winner")!.resource);
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

  it("leaves the shaders of a first acquisition to its host", async () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "material", tinted(1));
    if (!first.ok) throw new Error("Expected a compiled material");
    // Resolving a Material binds it at once. Nothing it replaces is on screen, and the host compiles the variants it
    // draws under its final lighting and fog (a load's warm-up, a frame's readiness probe).
    const mesh = MeshBuilder.CreatePlane("bound", {}, scene);
    mesh.material = first.material;
    const compile = vi.spyOn(first.material, "forceCompilationAsync");
    expect(await first.ready).toEqual([]);
    expect(compile).not.toHaveBeenCalled();
    expect(library.isReady(scene, "material", tinted(1))).toBe(true);
  });

  it("retires a first acquisition whose program cannot link, reporting the compiler's log once", async () => {
    const scene = host();
    const onTextureError = vi.fn();
    const library = new MaterialLibrary({ onTextureError });
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "material", tinted(1));
    if (!first.ok) throw new Error("Expected a compiled material");
    const mesh = MeshBuilder.CreatePlane("bound", {}, scene);
    mesh.material = first.material;
    expect(await first.ready).toEqual([]);
    // Nothing compiled it, so the Engine first fails to link it when a probe or a draw creates its Effect.
    // Babylon keeps the thrown Error's stack as the compile error: the shader log, then JS frames.
    const log = "FRAGMENT SHADER ERROR: 0:12: 'albedo' : undeclared identifier";
    const stack = `Error: ${log}\n    at Effect._processCompilationErrors (http://localhost/index.js:1:1)\n    at Effect._prepareEffect (http://localhost/index.js:2:2)`;
    const effect = { getCompilationError: () => stack } as Effect;
    first.material.onError?.(effect, stack);
    first.material.onError?.(effect, stack);
    await Promise.resolve();
    expect(onTextureError).toHaveBeenCalledTimes(1);
    expect(onTextureError).toHaveBeenCalledWith({ code: "material.compile.failed", message: log, severity: "error" });
    // The mesh falls back to the default Material instead of waiting forever on a program that cannot draw.
    expect(mesh.material).toBeNull();
    expect(scene.materials).not.toContain(first.material);
    expect(library.materialFor(scene, "material")).toBeNull();
    const retry = library.acquire(scene, "material", tinted(2));
    expect(retry.ok && retry.material).not.toBe(first.material);
  });

  it.each(["outlineMask", "captureDepth", "shadowDepth"] as const)(
    "retires the generation when its %s program cannot link, naming the program",
    async (kind) => {
      const scene = host();
      const onTextureError = vi.fn();
      const library = new MaterialLibrary({ onTextureError });
      disposers.push(() => library.dispose());
      const first = library.acquire(scene, "material", tinted(1));
      if (!first.ok) throw new Error("Expected a compiled material");
      const mesh = MeshBuilder.CreatePlane("bound", {}, scene);
      mesh.material = first.material;
      await first.ready;
      // The outline, capture and shadow passes each compile their own program; none of them can draw without it.
      const variant = acquireAuthoredMaterialVariant(first.material, kind);
      if (!variant) throw new Error("Expected an authored surface variant");
      expect(await variant.compiled.ready).toEqual([]);
      const log = "FRAGMENT SHADER ERROR: 0:4: undeclared identifier";
      variant.compiled.material.onError?.({ getCompilationError: () => log } as Effect, log);
      await Promise.resolve();
      expect(onTextureError).toHaveBeenCalledTimes(1);
      const [diagnostic] = onTextureError.mock.calls[0] as [{ code: string; message: string }];
      expect(diagnostic.code).toBe("material.compile.failed");
      expect(diagnostic.message).toMatch(/^[A-Za-z ]+ program: FRAGMENT SHADER ERROR/);
      expect(mesh.material).toBeNull();
      expect(library.materialFor(scene, "material")).toBeNull();
      await variant.release();
    },
  );

  /** Count the NodeMaterials compiled from now on (Babylon's own notification is deferred). */
  function compiles(scene: Scene) {
    const added = vi.spyOn(scene, "addMaterial");
    return () => added.mock.calls.length;
  }

  it("fails a plan whose program could not link at once, until its hash changes", async () => {
    const scene = host();
    const onTextureError = vi.fn();
    const library = new MaterialLibrary({ onTextureError });
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "material", tinted(1));
    if (!first.ok) throw new Error("Expected a compiled material");
    await first.ready;
    const log = "FRAGMENT SHADER ERROR: 0:2: syntax error";
    first.material.onError?.({ getCompilationError: () => log } as Effect, log);
    await Promise.resolve();
    const compiled = compiles(scene);
    // The Engine would hand a second compile of the same program its failed Effect, with no error to report.
    const again = library.acquire(scene, "material", tinted(1));
    expect(again).toEqual({ ok: false, diagnostics: [{ code: "material.compile.failed", message: log, severity: "error" }] });
    expect(library.resolve(scene, "material", tinted(1))).toBeNull();
    // Per-component copies compile the same program, so they fail at once too.
    expect(library.acquire(scene, "material", tinted(1), { instanceKey: "actor" }).ok).toBe(false);
    expect(compiled()).toBe(0);
    expect(onTextureError).toHaveBeenCalledTimes(1);
    expect(library.acquire(scene, "material", tinted(2)).ok).toBe(true);
    expect(compiled()).toBe(1);
  });

  /** A bound Material whose program the Engine cannot link, retired and latched. */
  async function latchedFailure() {
    const scene = host();
    const library = new MaterialLibrary({ onTextureError: vi.fn() });
    disposers.push(() => library.dispose());
    new PointLight("key", new Vector3(0, 1, 0), scene);
    const first = library.acquire(scene, "material", tinted(1));
    if (!first.ok) throw new Error("Expected a compiled material");
    await first.ready;
    const log = "VERTEX SHADER ERROR: 0:3: too many varying variables";
    first.material.onError?.({ getCompilationError: () => log } as Effect, log);
    await Promise.resolve();
    expect(library.acquire(scene, "material", tinted(1)).ok).toBe(false);
    return { scene, library };
  }

  it("keeps a failed plan latched through a lighting refresh that changes no light", async () => {
    const { scene, library } = await latchedFailure();
    // Retiring the Material is itself a refresh of the Scene's lighting.
    syncSceneLighting(scene);
    expect(library.acquire(scene, "material", tinted(1)).ok).toBe(false);
  });

  it("compiles a failed plan again once the Scene's lights change", async () => {
    const { scene, library } = await latchedFailure();
    // A varying or uniform limit is hit by the lights the receivers bind: the same plan may link without one.
    scene.lights[0]!.dispose();
    syncSceneLighting(scene);
    expect(library.acquire(scene, "material", tinted(1)).ok).toBe(true);
  });

  it("compiles a failed plan again once a shadow map changes what its receivers bind", async () => {
    const { scene, library } = await latchedFailure();
    invalidateShadowReceiverHandoffs(scene);
    expect(library.acquire(scene, "material", tinted(1)).ok).toBe(true);
  });

  it("forgets failed plans on request without touching the published generations", async () => {
    const { scene, library } = await latchedFailure();
    const other = library.acquire(scene, "other", tinted(3));
    if (!other.ok) throw new Error("Expected a compiled material");
    await other.ready;
    library.forgetFailures(scene);
    expect(library.acquire(scene, "material", tinted(1)).ok).toBe(true);
    expect(library.materialFor(scene, "other")).toBe(other.material);
  });

  it("retires an adopted instance that cannot link, under its component's key", async () => {
    const scene = host();
    const onTextureError = vi.fn();
    const library = new MaterialLibrary({ onTextureError });
    disposers.push(() => library.dispose());
    const staged = library.acquire(scene, "material", tinted(1), { instanceKey: "runtime-edit:1" });
    if (!staged.ok) throw new Error("Expected a compiled material");
    await staged.ready;
    const mesh = MeshBuilder.CreatePlane("bound", {}, scene);
    mesh.material = staged.material;
    library.adoptPreparedInstance(scene, "material", "runtime-edit:1", "slot|component", staged.material).commit();
    // A define change after the commit (a new shadow caster) makes the Engine link the program again, and it fails.
    const log = "VERTEX SHADER ERROR: 0:3: too many varying variables";
    staged.material.onError?.({ getCompilationError: () => log } as Effect, log);
    await Promise.resolve();
    expect(onTextureError).toHaveBeenCalledTimes(1);
    expect(mesh.material).toBeNull();
    expect(library.materialFor(scene, "material", { instanceKey: "slot|component" })).toBeNull();
  });

  it("compiles a plan that failed again once its dependencies are marked dirty", async () => {
    const scene = host();
    const library = new MaterialLibrary({ onTextureError: vi.fn() });
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "material", tinted(1));
    if (!first.ok) throw new Error("Expected a compiled material");
    await first.ready;
    first.material.onError?.({ getCompilationError: () => "ERROR: 0:1" } as Effect, "ERROR: 0:1");
    await Promise.resolve();
    expect(library.acquire(scene, "material", tinted(1)).ok).toBe(false);
    library.markDirty();
    expect(library.acquire(scene, "material", tinted(1)).ok).toBe(true);
  });

  it("fails a replacement that failed to build at once, keeping the published generation", async () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "material", tinted(1));
    if (!first.ok) throw new Error("Expected a compiled material");
    await first.ready;
    const invalid = tinted(0.2);
    invalid.nodes.push({ id: "normal", type: "shading.normalMap", position: { x: 0, y: 0 }, properties: {} });
    invalid.edges.push({ id: "normal-output", sourceNodeId: "normal", sourcePinId: "normal", targetNodeId: "output", targetPinId: "normal" });
    const failed = library.acquire(scene, "material", invalid);
    const diagnostics = failed.ok ? await failed.ready : failed.diagnostics;
    expect(diagnostics.length).toBeGreaterThan(0);
    const compiled = compiles(scene);
    expect(library.acquire(scene, "material", invalid)).toEqual({ ok: false, diagnostics });
    expect(library.resolve(scene, "material", invalid)).toBe(first.material);
    expect(compiled()).toBe(0);
  });

  it("tries a replacement again after its warm-up only stalled", async () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "material", tinted(1));
    if (!first.ok) throw new Error("Expected a compiled material");
    await first.ready;
    const mesh = MeshBuilder.CreatePlane("shown", {}, scene);
    mesh.material = first.material;
    const next = library.acquire(scene, "material", tinted(2));
    if (!next.ok) throw new Error("Expected the replacement material");
    vi.spyOn(next.material, "forceCompilationAsync").mockRejectedValue(new MaterialCompileStalled());
    expect(await next.ready).toEqual([{ code: "material.compile.stalled", message: "Material shader compilation timed out", severity: "error" }]);
    // Nothing finished linking for its whole bound, which says nothing about the program.
    expect(library.acquire(scene, "material", tinted(2)).ok).toBe(true);
  });

  it("warns about a retired Material when its host takes no diagnostics", async () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = library.acquire(scene, "material", tinted(1));
      if (!first.ok) throw new Error("Expected a compiled material");
      await first.ready;
      const log = "VERTEX SHADER ERROR: 0:3: syntax error";
      first.material.onError?.({ getCompilationError: () => log } as Effect, log);
      await Promise.resolve();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(log));
    } finally { warn.mockRestore(); }
  });

  it("keeps a retired generation's holders accounted, so a stale release spares its successor", async () => {
    const scene = host();
    const library = new MaterialLibrary({ onTextureError: vi.fn() });
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "material", tinted(1));
    if (!first.ok) throw new Error("Expected a compiled material");
    await first.ready;
    first.material.onError?.({ getCompilationError: () => "ERROR: 0:1" } as Effect, "ERROR: 0:1");
    await Promise.resolve();
    expect(library.materialFor(scene, "material")).toBeNull();
    // The Scene resolves the key again, while the first holder still has to release its reference.
    const again = library.acquire(scene, "material", tinted(2));
    if (!again.ok) throw new Error("Expected a fresh generation");
    await again.ready;
    library.release(scene, "material");
    expect(library.materialFor(scene, "material")).toBe(again.material);
    library.release(scene, "material");
    expect(library.materialFor(scene, "material")).toBeNull();
  });

  it("retires every material that shares a program the Engine cannot link", async () => {
    const scene = host();
    const onTextureError = vi.fn();
    const library = new MaterialLibrary({ onTextureError });
    disposers.push(() => library.dispose());
    const root = library.acquire(scene, "material", tinted(1));
    const instance = library.acquire(scene, "material", tinted(1), { instanceKey: "actor" });
    if (!root.ok || !instance.ok) throw new Error("Expected compiled materials");
    const rootMesh = MeshBuilder.CreatePlane("root", {}, scene);
    const instanceMesh = MeshBuilder.CreatePlane("instance", {}, scene);
    rootMesh.material = root.material;
    instanceMesh.material = instance.material;
    await Promise.all([root.ready, instance.ready]);
    expect(instance.material.buildId).toBe(root.material.buildId);
    // The Engine creates one Effect for both and hands only its first requester's `onError` the failure, then
    // raises it for the Engine.
    const log = "FRAGMENT SHADER ERROR: 0:7: syntax error";
    const effect = { name: { vertex: `nodeMaterial${root.material.buildId}` }, getCompilationError: () => log } as unknown as Effect;
    root.material.onError?.(effect, log);
    scene.getEngine().onEffectErrorObservable.notifyObservers({ effect, errors: log });
    await Promise.resolve();
    expect(rootMesh.material).toBeNull();
    expect(instanceMesh.material).toBeNull();
    expect(onTextureError).toHaveBeenCalledTimes(2);
    expect(library.materialFor(scene, "material", { instanceKey: "actor" })).toBeNull();
  });

  it("warms a first acquisition for its bound meshes when its host captures right after, failing with the compiler's log", async () => {
    const scene = host();
    const library = new MaterialLibrary({ warmFirstAcquisition: true });
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "material", tinted(1));
    if (!first.ok) throw new Error("Expected a compiled material");
    const mesh = MeshBuilder.CreatePlane("bound", {}, scene);
    mesh.material = first.material;
    const log = "FRAGMENT SHADER ERROR: 0:9: undeclared identifier";
    // Babylon rejects a failed compile with the shader log itself, a string.
    const compile = vi.spyOn(first.material, "forceCompilationAsync").mockRejectedValue(log);
    expect(await first.ready).toEqual([{ code: "material.compile.failed", message: log, severity: "error" }]);
    expect(compile).toHaveBeenCalledWith(mesh);
  });

  it("compiles a replacement for its meshes while the published generation stays bound", async () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const first = library.acquire(scene, "material", tinted(1));
    if (!first.ok) throw new Error("Expected a compiled material");
    await first.ready;
    const mesh = MeshBuilder.CreatePlane("shown", {}, scene);
    mesh.material = first.material;
    const next = library.acquire(scene, "material", tinted(2));
    if (!next.ok) throw new Error("Expected the replacement material");
    let boundWhileCompiling: Material | null = null;
    const compile = vi.spyOn(next.material, "forceCompilationAsync").mockImplementation(async () => {
      boundWhileCompiling = mesh.material;
    });
    expect(await next.ready).toEqual([]);
    expect(compile).toHaveBeenCalledWith(mesh);
    expect(boundWhileCompiling).toBe(first.material);
    expect(mesh.material).toBe(next.material);
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

  it("moves meshes from a superseded unpublished build to its replacement", async () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const mesh = MeshBuilder.CreateBox("box", {}, scene);
    const first = library.resolve(scene, "material", tinted(1));
    if (!first) throw new Error("Expected a pending material");
    mesh.material = first;
    const second = library.resolve(scene, "material", tinted(0.25));
    expect(second).not.toBe(first);
    expect(mesh.material).toBe(second);
    expect(scene.materials).not.toContain(first);
    const ready = library.acquire(scene, "material", tinted(0.25));
    if (!ready.ok) throw new Error("Expected the replacement material");
    expect(await ready.ready).toEqual([]);
    expect(library.materialFor(scene, "material")).toBe(second);
    library.release(scene, "material");
    library.release(scene, "material");
    expect(scene.materials).not.toContain(second);
  });

  it("cancels pending builds for every variant of an asset", async () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const unlit = library.acquire(scene, "material", tinted(1), { unlit: true });
    const instance = library.acquire(scene, "material", tinted(1), { instanceKey: "actor" });
    const other = library.acquire(scene, "other", tinted(1), { unlit: true });
    if (!unlit.ok || !instance.ok || !other.ok) throw new Error("Expected pending materials");
    library.cancelPending(scene, "material");
    expect(await unlit.ready).toEqual([expect.objectContaining({ code: "material.compile.cancelled" })]);
    expect(await instance.ready).toEqual([expect.objectContaining({ code: "material.compile.cancelled" })]);
    expect(scene.materials).not.toContain(unlit.material);
    expect(scene.materials).not.toContain(instance.material);
    expect(await other.ready).toEqual([]);
  });

  it("recompiles the same graph when its material functions change", () => {
    const scene = host();
    const boosted = createDefaultMaterialFunctionDocument("Tint");
    boosted.nodes.push({ id: "boost", type: "math.multiply", position: { x: 0, y: 0 }, properties: {} });
    boosted.edges = [
      { id: "e-in-boost", sourceNodeId: "inputs", sourcePinId: "in_value", targetNodeId: "boost", targetPinId: "a" },
      { id: "e-boost-out", sourceNodeId: "boost", sourcePinId: "out", targetNodeId: "outputs", targetPinId: "out_value" },
    ];
    let functions: Record<string, MaterialFunctionDocument> = { tint: createDefaultMaterialFunctionDocument("Tint") };
    const library = new MaterialLibrary({ functions: () => functions });
    disposers.push(() => library.dispose());
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "tint" } });
    doc.edges = [
      { id: "e-color-call", sourceNodeId: "baseColor", sourcePinId: "out", targetNodeId: "call", targetPinId: "in_value" },
      { id: "e-call-out", sourceNodeId: "call", sourcePinId: "out_value", targetNodeId: "output", targetPinId: "baseColor" },
    ];
    const first = library.acquire(scene, "mat-1", doc);
    if (!first.ok) throw new Error("Expected a compiled material");
    expect(library.isCompiled(scene, "mat-1", doc)).toBe(true);
    functions = { tint: boosted };
    expect(library.isCompiled(scene, "mat-1", doc)).toBe(false);
    const second = library.acquire(scene, "mat-1", doc);
    if (!second.ok) throw new Error("Expected a compiled material");
    expect(second.material).not.toBe(first.material);
  });

  it("recompiles a material document that was edited in place", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "tint", type: "const.vec3", position: { x: 0, y: 0 }, properties: { value: [1, 0, 0] } });
    const first = library.acquire(scene, "mat-1", doc);
    if (!first.ok) throw new Error("Expected a compiled material");
    expect(library.isCompiled(scene, "mat-1", doc)).toBe(true);
    doc.edges = [
      ...doc.edges.filter((edge) => !(edge.targetNodeId === "output" && edge.targetPinId === "baseColor")),
      { id: "e-tint-out", sourceNodeId: "tint", sourcePinId: "out", targetNodeId: "output", targetPinId: "baseColor" },
    ];
    expect(library.isCompiled(scene, "mat-1", doc)).toBe(false);
    const second = library.acquire(scene, "mat-1", doc);
    if (!second.ok) throw new Error("Expected a compiled material");
    expect(second.material).not.toBe(first.material);
  });

  it("reports readiness while resolving, including after an in-place edit", async () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const doc = createDefaultMaterialDocument();
    doc.nodes.push({ id: "tint", type: "const.vec3", position: { x: 0, y: 0 }, properties: { value: [1, 0, 0] } });
    const pending = library.resolveWithReadiness(scene, "mat-1", doc);
    if (!pending) throw new Error("Expected a pending material");
    expect(pending.ready).toBe(false);
    expect(library.isReady(scene, "mat-1", doc)).toBe(false);
    const acquired = library.acquire(scene, "mat-1", doc);
    if (!acquired.ok) throw new Error("Expected the pending material");
    await acquired.ready;
    const published = library.resolveWithReadiness(scene, "mat-1", doc);
    expect(published?.material).toBe(pending.material);
    expect(published?.ready).toBe(true);
    expect(library.isReady(scene, "mat-1", doc)).toBe(true);
    doc.edges = [
      ...doc.edges.filter((edge) => !(edge.targetNodeId === "output" && edge.targetPinId === "baseColor")),
      { id: "e-tint-out", sourceNodeId: "tint", sourcePinId: "out", targetNodeId: "output", targetPinId: "baseColor" },
    ];
    // The edit recompiles; the last published generation stays bound but is no longer ready.
    const edited = library.resolveWithReadiness(scene, "mat-1", doc);
    expect(edited?.material).toBe(pending.material);
    expect(edited?.ready).toBe(false);
    expect(library.isReady(scene, "mat-1", doc)).toBe(false);
    const replacement = library.acquire(scene, "mat-1", doc);
    if (!replacement.ok) throw new Error("Expected the edited material to compile");
    await replacement.ready;
    const settled = library.resolveWithReadiness(scene, "mat-1", doc);
    expect(settled?.material).toBe(replacement.material);
    expect(settled?.material).not.toBe(pending.material);
    expect(settled?.ready).toBe(true);
    expect(library.resolveWithReadiness(scene, "missing", { ...doc, nodes: [], edges: [] })).toBeNull();
  });

  it("compiles a Material Instance as its own material on its root Material's GPU program", async () => {
    const scene = host();
    const library = new MaterialLibrary();
    const root = createDefaultMaterialDocument();
    root.nodes.push({ id: "tint", type: "param.color", position: { x: 0, y: 0 }, properties: { name: "Tint", value: [1, 1, 1, 1] } });
    root.edges = [{ id: "tint-base", sourceNodeId: "tint", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "baseColor" }];
    const instance = materializeMaterialInstance(root, "root", { Tint: { kind: "color", value: [1, 0, 0, 1] } });
    const parent = library.acquire(scene, "root", root);
    const child = library.acquire(scene, "inst", instance);
    if (!parent.ok || !child.ok) throw new Error("acquire failed");
    expect(await parent.ready).toEqual([]);
    expect(await child.ready).toEqual([]);
    expect(child.material).not.toBe(parent.material);
    expect(child.material.name).toBe("material:inst");
    expect(child.material.buildId).toBe(parent.material.buildId);
    expect(library.getParameter(scene, "inst", "Tint")).toEqual({ kind: "color", value: [1, 0, 0, 1] });
    expect(library.getParameter(scene, "root", "Tint")).toEqual({ kind: "color", value: [1, 1, 1, 1] });
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

  it("releases texture leases when a scene is disposed without releaseScene and never tracks it again", async () => {
    const f = textureLibrary();
    const layer = new Scene(f.scene.getEngine());
    const acquired = f.library.acquire(layer, "material", textureDocument("first"));
    if (!acquired.ok) throw new Error("Material did not compile");
    expect(await acquired.ready).toEqual([]);
    expect(f.cache.resourceStats().leases).toBe(1);
    layer.dispose();
    expect(f.cache.resourceStats().leases).toBe(0);
    expect(f.library.acquire(layer, "material", textureDocument("first")).ok).toBe(false);
    expect(f.library.isCompiled(layer, "material", textureDocument("first"))).toBe(false);
    expect(f.cache.resourceStats().leases).toBe(0);
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
