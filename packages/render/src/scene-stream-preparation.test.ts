import { NullEngine, Scene, MeshBuilder, StandardMaterial, RawTexture } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSceneStream } from "./scene-stream-preparation";
import { createSnapshotSceneBinding, retirePlaySlot } from "./snapshot-apply";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("streamed render resource preparation", () => {
  const engines: NullEngine[] = [];
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.dispose(); });
  function fixture() {
    const engine = new NullEngine(); engines.push(engine);
    const scene = new Scene(engine);
    const binding = createSnapshotSceneBinding();
    const root = MeshBuilder.CreateBox("streamed", {}, scene);
    const material = new StandardMaterial("streamed", scene);
    root.material = material;
    binding.meshes.set(1, root);
    binding.meshSorting.set(1, { actorGuid: "streamed" });
    const compile = vi.spyOn(material, "forceCompilationAsync").mockResolvedValue();
    const controller = new AbortController();
    const options = { signal: controller.signal, assertCurrent: () => {} };
    return { scene, binding, root, material, compile, controller, options };
  }

  it("waits for its model and sampled texture while unrelated loads remain pending", async () => {
    const f = fixture();
    const model = deferred();
    f.binding.slotAnimLoads!.set(1, model.promise);
    f.binding.slotAnimLoads!.set(2, new Promise(() => {}));
    const sibling = MeshBuilder.CreateBox("other stream", {}, f.scene);
    sibling.material = new StandardMaterial("other", f.scene);
    const siblingCompile = vi.spyOn(sibling.material, "forceCompilationAsync").mockImplementation(() => new Promise(() => {}));
    const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, f.scene);
    f.material.diffuseTexture = texture;
    const textureReady = vi.spyOn(texture, "isReady").mockReturnValue(false);
    let ready = false;
    const work = prepareSceneStream(f.scene, f.binding, [1], f.options).then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    model.resolve();
    await vi.waitFor(() => expect(textureReady).toHaveBeenCalled());
    expect(ready).toBe(false);
    expect(f.compile).not.toHaveBeenCalled();
    textureReady.mockReturnValue(true);
    await work;
    expect(ready).toBe(true);
    expect(f.compile).toHaveBeenCalledWith(f.root);
    expect(siblingCompile).not.toHaveBeenCalled();
  });

  it("settles cancellation without waiting for a hanging model and never warms its late result", async () => {
    const f = fixture();
    const model = deferred();
    f.binding.slotAnimLoads!.set(1, model.promise);
    const work = prepareSceneStream(f.scene, f.binding, [1], f.options);
    const rejected = expect(work).rejects.toThrow("unloaded");
    f.controller.abort(new Error("unloaded"));
    await rejected;
    model.resolve();
    await Promise.resolve();
    expect(f.compile).not.toHaveBeenCalled();
  });

  it("does not acknowledge a despawned actor or a failed material", async () => {
    const f = fixture();
    const model = deferred();
    f.binding.slotAnimLoads!.set(1, model.promise);
    const work = prepareSceneStream(f.scene, f.binding, [1], f.options);
    const rejected = expect(work).rejects.toThrow("replaced");
    retirePlaySlot(f.binding, 1);
    model.resolve();
    await rejected;
    expect(f.compile).not.toHaveBeenCalled();
    const other = fixture();
    other.compile.mockRejectedValue(new Error("shader failed"));
    await expect(prepareSceneStream(other.scene, other.binding, [1], other.options)).rejects.toThrow("shader failed");
  });

  it("fails a stalled native import and ignores a late successful completion", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const model = deferred();
    f.binding.slotAnimLoads!.set(1, model.promise);
    const progress = vi.fn();
    const work = prepareSceneStream(f.scene, f.binding, [1], { ...f.options, onProgress: progress });
    const rejected = expect(work).rejects.toThrow("made no progress");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    model.resolve();
    await Promise.resolve();
    expect(progress).not.toHaveBeenCalled();
    expect(f.compile).not.toHaveBeenCalled();
  });

  it("keeps assignment validation linear while preparing a batch of mesh consumers", async () => {
    const f = fixture();
    const slots = Array.from({ length: 64 }, (_, index) => index + 1);
    for (const slot of slots) {
      if (slot !== 1) {
        const root = MeshBuilder.CreateBox(`streamed-${slot}`, {}, f.scene);
        root.material = f.material;
        f.binding.meshes.set(slot, root);
        f.binding.meshSorting.set(slot, { actorGuid: `streamed-${slot}` });
      }
      f.binding.slotAnimLoads!.set(slot, Promise.resolve());
    }
    const assignmentReads = vi.spyOn(f.binding.meshSorting, "get");
    await prepareSceneStream(f.scene, f.binding, slots, f.options);
    expect(f.compile).toHaveBeenCalledTimes(slots.length);
    // Count work rather than elapsed time: rescanning all slots at every native
    // completion would exceed this generous linear budget even on a fast host.
    expect(assignmentReads.mock.calls.length).toBeLessThanOrEqual(slots.length * 16);
  });

  it.each([1, 2])("rejects slot %s reuse during a later shader wait before acknowledging readiness", async (replacedSlot) => {
    const f = fixture();
    const next = MeshBuilder.CreateBox("second streamed mesh", {}, f.scene);
    const material = new StandardMaterial("second streamed material", f.scene);
    next.material = material;
    f.binding.meshes.set(2, next);
    f.binding.meshSorting.set(2, { actorGuid: "second" });
    const shader = deferred();
    const compile = vi.spyOn(material, "forceCompilationAsync").mockReturnValue(shader.promise);
    const progress = vi.fn();
    const work = prepareSceneStream(f.scene, f.binding, [1, 2], { ...f.options, onProgress: progress });
    const rejected = expect(work).rejects.toThrow("replaced");
    await vi.waitFor(() => expect(compile).toHaveBeenCalled());
    f.binding.meshSorting.set(replacedSlot, { actorGuid: "replacement" });
    shader.resolve();
    await rejected;
    expect(progress).not.toHaveBeenCalledWith(0.95);
  });
});
