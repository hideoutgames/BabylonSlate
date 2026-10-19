import { MeshBuilder } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEngine } from "./create-null-engine";
import { waitForPreviewMeshesReady, waitUntilReady } from "./preview-readiness";
import { createHeldThreadBudget, SCENE_SHADER_WARM_TIMEOUT_MS, SCENE_THREAD_HELD_BUDGET_MS } from "./stall-deadline";
import { installVirtualClock, POLL_MS } from "./virtual-clock-test-fixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Without KHR_parallel_shader_compile (SwiftShader) one probe links
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
    const held = 10_000;
    const ready = await waitUntilReady(() => { clock.advance(held); return false; }, () => true);
    expect(ready).toBe(false);
    expect(clock.elapsed()).toBeGreaterThan(SCENE_THREAD_HELD_BUDGET_MS);
    expect(clock.elapsed()).toBeLessThanOrEqual(SCENE_SHADER_WARM_TIMEOUT_MS + SCENE_THREAD_HELD_BUDGET_MS + held);
  });

  // A one-shot capture waits several times in a row; all of them spend the credit of the one capture.
  it("spends one shared budget across sequential waits", async () => {
    const clock = installVirtualClock();
    const held = 10_000;
    const budget = createHeldThreadBudget();
    const hold = () => { clock.advance(held); return false; };
    expect(await waitUntilReady(hold, () => true, undefined, budget)).toBe(false);
    const spentFirst = clock.elapsed();
    expect(spentFirst).toBeGreaterThan(SCENE_THREAD_HELD_BUDGET_MS);
    // Nothing is left to credit: the next wait ends at its bound, within the one probe that crossed it.
    expect(await waitUntilReady(hold, () => true, undefined, budget)).toBe(false);
    expect(clock.elapsed() - spentFirst).toBeLessThanOrEqual(SCENE_SHADER_WARM_TIMEOUT_MS + held);
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

  // SwiftShader (no KHR_parallel_shader_compile) links each variant inside the probe that requests it: links shorter
  // than SCENE_THREAD_HELD_MS earn no held-thread credit, but every one that finishes is progress on the Engine.
  describe("while short synchronous links keep finishing shaders", () => {
    /** Each probe takes 500 ms; while `linking(probe)` it also finishes one more shader variant on the Engine. */
    function linkingMesh(linking: (probe: number) => boolean, ready: (probe: number) => boolean) {
      const made = previewMesh();
      const effects = (made.mesh.getEngine() as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects;
      const clock = installVirtualClock();
      let probes = 0;
      let lastLink = 0;
      vi.spyOn(made.mesh, "isReady").mockImplementation(() => {
        probes += 1;
        clock.advance(500);
        if (linking(probes)) {
          effects[`linked-${probes}`] = { isReady: () => true, getCompilationError: () => "" };
          lastLink = clock.elapsed();
        }
        return ready(probes);
      });
      return { ...made, clock, lastLink: () => lastLink };
    }

    it("keeps waiting past the bound and succeeds once the mesh is ready", async () => {
      const { mesh, clock, dispose } = linkingMesh(() => true, (probe) => probe > 30);
      expect(await waitForPreviewMeshesReady(mesh)).toBe(true);
      expect(clock.elapsed()).toBeGreaterThan(3 * SCENE_SHADER_WARM_TIMEOUT_MS);
      dispose();
    });

    it("gives up once links stop finishing, within two bounds of the last one", async () => {
      const { mesh, clock, lastLink, dispose } = linkingMesh((probe) => probe <= 20, () => false);
      expect(await waitForPreviewMeshesReady(mesh)).toBe(false);
      expect(clock.elapsed() - lastLink()).toBeGreaterThanOrEqual(SCENE_SHADER_WARM_TIMEOUT_MS);
      expect(clock.elapsed() - lastLink()).toBeLessThanOrEqual(2 * SCENE_SHADER_WARM_TIMEOUT_MS + 500);
      dispose();
    });
  });
});
