import { MeshBuilder } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEngine } from "./create-null-engine";
import { waitForPreviewMeshesReady, waitUntilReady } from "./preview-readiness";
import { SCENE_SHADER_WARM_TIMEOUT_MS, SCENE_THREAD_HELD_BUDGET_MS, SCENE_THREAD_HELD_MS } from "./stall-deadline";
import { installVirtualClock, POLL_MS } from "./virtual-clock-test-fixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Without KHR_parallel_shader_compile (SwiftShader, WebKit WebGL2) one probe links
// every effect before it returns, and a cold runner held the thread for 13 to 15 s.
describe("waitUntilReady", () => {
  it("keeps waiting after a probe held the thread past the bound, and succeeds when the next one is ready", async () => {
    const clock = installVirtualClock();
    let probes = 0;
    const ready = await waitUntilReady(() => {
      probes += 1;
      clock.advance(probes === 1 ? 15_000 : POLL_MS);
      return probes > 1;
    }, () => true);
    expect(ready).toBe(true);
    expect(clock.elapsed()).toBeGreaterThan(SCENE_SHADER_WARM_TIMEOUT_MS);
  });

  it("gives up at the bound when polling is all that takes time", async () => {
    const clock = installVirtualClock();
    const ready = await waitUntilReady(() => { clock.advance(POLL_MS); return false; }, () => true);
    expect(ready).toBe(false);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(SCENE_SHADER_WARM_TIMEOUT_MS);
    expect(clock.elapsed()).toBeLessThanOrEqual(SCENE_SHADER_WARM_TIMEOUT_MS + POLL_MS);
  });

  it("credits a held gap once, then applies the bound to what follows", async () => {
    const clock = installVirtualClock();
    let probes = 0;
    const ready = await waitUntilReady(() => { probes += 1; clock.advance(probes === 1 ? 15_000 : POLL_MS); return false; }, () => true);
    expect(ready).toBe(false);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(15_000 + SCENE_SHADER_WARM_TIMEOUT_MS);
    expect(clock.elapsed()).toBeLessThanOrEqual(15_000 + SCENE_SHADER_WARM_TIMEOUT_MS + POLL_MS);
  });

  // A credit without a ceiling would hold a wait that never succeeds (a texture that never arrives, on a host
  // where every probe is slow) forever.
  it("fails a wait whose every probe holds the thread once the credit budget is spent", async () => {
    const clock = installVirtualClock();
    const held = SCENE_THREAD_HELD_MS * 1.5;
    const ready = await waitUntilReady(() => { clock.advance(held); return false; }, () => true);
    expect(ready).toBe(false);
    expect(clock.elapsed()).toBeGreaterThan(SCENE_THREAD_HELD_BUDGET_MS);
    expect(clock.elapsed()).toBeLessThanOrEqual(SCENE_SHADER_WARM_TIMEOUT_MS + SCENE_THREAD_HELD_BUDGET_MS + held);
  });

  it("stops at once when the owner moves on, without another probe", async () => {
    installVirtualClock();
    const probe = vi.fn(() => false);
    expect(await waitUntilReady(probe, () => false)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("waitForPreviewMeshesReady", () => {
  function previewMesh() {
    const { engine, scene } = createTestEngine();
    const mesh = MeshBuilder.CreateBox("preview", {}, scene);
    return { mesh, dispose: () => { scene.dispose(); engine.dispose(); } };
  }

  it("waits out a mesh whose readiness probe links shaders for longer than the bound", async () => {
    const { mesh, dispose } = previewMesh();
    const clock = installVirtualClock();
    let probes = 0;
    vi.spyOn(mesh, "isReady").mockImplementation(() => { probes += 1; clock.advance(probes === 1 ? 15_000 : POLL_MS); return probes > 1; });
    expect(await waitForPreviewMeshesReady(mesh)).toBe(true);
    dispose();
  });

  it("reports a mesh that never becomes ready at the shader warm bound", async () => {
    const { mesh, dispose } = previewMesh();
    const clock = installVirtualClock();
    vi.spyOn(mesh, "isReady").mockImplementation(() => { clock.advance(POLL_MS); return false; });
    expect(await waitForPreviewMeshesReady(mesh)).toBe(false);
    expect(clock.elapsed()).toBeLessThanOrEqual(SCENE_SHADER_WARM_TIMEOUT_MS + POLL_MS);
    dispose();
  });
});
