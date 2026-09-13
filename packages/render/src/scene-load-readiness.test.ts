import { describe, expect, it, vi } from "vitest";
import { createSceneLoadReadiness } from "./scene-load-readiness";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const handle = {
    whenEditorModelsReady: vi.fn(async () => {}),
    whenMaterialTexturesReady: vi.fn(async () => {}),
    prewarmSceneMaterials: vi.fn(async () => {}),
    presentFirstFrame: vi.fn(async () => {}),
  };
  const activate = vi.fn();
  const onReady = vi.fn();
  const onFailed = vi.fn();
  const readiness = createSceneLoadReadiness({ handle, activate, onReady, onFailed });
  const command = (type: string, sceneLoadId = 1) => ({ type, sceneAssetGuid: "scene", sceneLoadId });
  return { handle, activate, onReady, onFailed, readiness, command };
}

describe("runtime scene readiness", () => {
  it("waits for the complete assignment batch, textures, shaders and first frame before acknowledgement", async () => {
    const { handle, readiness, onReady, command } = fixture();
    const textures = deferred();
    const presentation = deferred();
    handle.whenMaterialTexturesReady.mockReturnValueOnce(textures.promise);
    handle.presentFirstFrame.mockReturnValueOnce(presentation.promise);
    readiness.receive(command("activeScene"));
    readiness.receive(command("assignMesh"));
    await Promise.resolve();
    expect(handle.whenEditorModelsReady).not.toHaveBeenCalled();
    readiness.receive(command("sceneRealized"));
    readiness.receive(command("sceneRealized"));
    await vi.waitFor(() => expect(handle.whenMaterialTexturesReady).toHaveBeenCalledOnce());
    expect(handle.prewarmSceneMaterials).not.toHaveBeenCalled();
    textures.resolve();
    await vi.waitFor(() => expect(handle.presentFirstFrame).toHaveBeenCalledOnce());
    expect(onReady).not.toHaveBeenCalled();
    presentation.resolve();
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ sceneAssetGuid: "scene", sceneLoadId: 1 }));
    expect(handle.whenEditorModelsReady).toHaveBeenCalledOnce();
  });

  it("ignores the previous same-scene batch while the replacement finishes", async () => {
    const { handle, readiness, onReady, activate, command } = fixture();
    const oldTextures = deferred();
    handle.whenMaterialTexturesReady.mockReturnValueOnce(oldTextures.promise);
    readiness.receive(command("activeScene"));
    readiness.receive(command("sceneRealized"));
    await vi.waitFor(() => expect(handle.whenMaterialTexturesReady).toHaveBeenCalledOnce());
    readiness.receive(command("activeScene", 2));
    readiness.receive(command("activeScene", 1));
    readiness.receive(command("sceneRealized", 1));
    readiness.receive(command("sceneRealized", 2));
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    oldTextures.resolve();
    await oldTextures.promise;
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ sceneLoadId: 2 }));
    expect(handle.prewarmSceneMaterials).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it.each(["activate", "models", "textures", "shaders", "frame"] as const)(
    "reports %s failure without successful acknowledgement", async (stage) => {
      const { handle, readiness, onReady, onFailed, activate, command } = fixture();
      const failure = new Error("Scene resource unavailable");
      if (stage === "activate") activate.mockImplementationOnce(() => { throw failure; });
      if (stage === "models") handle.whenEditorModelsReady.mockRejectedValueOnce(failure);
      if (stage === "textures") handle.whenMaterialTexturesReady.mockRejectedValueOnce(failure);
      if (stage === "shaders") handle.prewarmSceneMaterials.mockRejectedValueOnce(failure);
      if (stage === "frame") handle.presentFirstFrame.mockRejectedValueOnce(failure);
      readiness.receive(command("activeScene"));
      readiness.receive(command("sceneRealized"));
      await vi.waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ sceneLoadId: 1 }), failure));
      expect(onReady).not.toHaveBeenCalled();
    },
  );

  it("disposal suppresses pending warming failures and prevents late presentation", async () => {
    const { handle, readiness, onReady, onFailed, command } = fixture();
    const shaders = deferred();
    handle.prewarmSceneMaterials.mockReturnValueOnce(shaders.promise);
    readiness.receive(command("activeScene"));
    readiness.receive(command("sceneRealized"));
    await vi.waitFor(() => expect(handle.prewarmSceneMaterials).toHaveBeenCalledOnce());
    readiness.dispose();
    shaders.reject(new Error("Obsolete scene was disposed"));
    await Promise.resolve();
    expect(handle.presentFirstFrame).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });
});
