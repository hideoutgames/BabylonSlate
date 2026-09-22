import { describe, expect, it } from "vitest";
import { renderingApplicationPolicy, ScalabilitySession, type ScalabilityTransaction } from "./scalability";

function session() {
  const transactions: ScalabilityTransaction[] = [];
  const settings = new ScalabilitySession({ mode: "cel", width: 800, height: 450 }, 30, { shadowOverrides: { distance: 75 } }, (value) => transactions.push(value));
  return { settings, transactions };
}
describe("runtime scalability session", () => {
  it("validates outline transactions atomically and preserves their style across presets and scene changes", () => {
    const { settings, transactions } = session();
    const before = settings.requested;
    expect(settings.request({ kind: "patch", render: { cel: { outlinesEnabled: false, outlineColor: [1, NaN, 0] } } }).status).toBe("failed");
    expect(settings.requested).toEqual(before);
    expect(transactions).toHaveLength(0);
    const result = settings.request({ kind: "patch", render: { cel: { outlinesEnabled: false, outlineColor: [-1, 0.123456, 2], outlineWidth: 99 } } });
    expect(result.message).toContain("clamped");
    expect(settings.requested.render.cel).toMatchObject({ outlinesEnabled: false, outlineColor: [0, 0.123456, 1], outlineWidth: 8 });
    settings.request({ kind: "patch", render: { cel: { outlinesEnabled: false, outlineColor: [0, 0.123456, 1], outlineWidth: 8 } } });
    expect(transactions).toHaveLength(1);
    settings.request({ kind: "preset", preset: "low" });
    settings.setScene({ celShading: { outlinesEnabled: true, outlineColor: [1, 0, 0], outlineWidth: 2 } });
    expect(settings.requested.render.cel).toMatchObject({ outlinesEnabled: false, outlineColor: [0, 0.123456, 1], outlineWidth: 8 });
    expect(settings.snapshot().effective).toBeNull();
    const pending = settings.transaction();
    settings.acknowledge({ revision: pending.revision, status: "applied", message: "Ready", effective: pending.settings });
    expect(settings.snapshot().effective?.render.cel?.outlineWidth).toBe(8);
    settings.request({ kind: "reset" });
    expect(settings.requested.render.cel).toMatchObject({ outlinesEnabled: true, outlineColor: [1, 0, 0], outlineWidth: 2 });
    expect(session().settings.requested.render.cel).toMatchObject({ outlinesEnabled: true, outlineColor: [0.03, 0.03, 0.03], outlineWidth: 1 });
    for (const path of ["cel.outlinesEnabled", "cel.outlineColor", "cel.outlineWidth"]) expect(renderingApplicationPolicy(path)).toBe("live");
  });
  it("keeps requested values separate from renderer-confirmed values and ignores stale completions", () => {
    const { settings } = session();
    expect(settings.snapshot().effective).toBeNull();
    const first = settings.request({ kind: "patch", frameCap: 20 });
    const second = settings.request({ kind: "patch", frameCap: 25 });
    expect(settings.acknowledge({ ...first, status: "applied", effective: { ...settings.requested, frameCap: 20 } })).toBe(false);
    expect(settings.snapshot().effective).toBeNull();
    expect(settings.acknowledge({ ...second, status: "applied", effective: settings.requested })).toBe(true);
    expect(settings.snapshot().effective?.frameCap).toBe(25);
    expect(settings.acknowledge({ ...second, status: "applied", effective: settings.requested })).toBe(false);
  });
  it("cooperates with console overrides, preserves artistic settings and resets the session", () => {
    const { settings } = session();
    settings.executeQuality("lighting", "budget", "3");
    settings.request({ kind: "preset", preset: "low", group: "shadows" });
    settings.request({ kind: "patch", frameCap: 20 });
    expect(settings.requested.render.quality?.lighting.maxLocalLights).toBe(3);
    expect(settings.requested.render.mode).toBe("cel");
    settings.request({ kind: "reset" });
    expect(settings.requested.frameCap).toBe(30);
    expect(settings.requested.render.shadows?.distance).toBe(75);
    expect(settings.overrides).toEqual({});
  });
  it("treats repeated requests as no-ops, including identical console requests", () => {
    const { settings, transactions } = session();
    for (let i = 0; i < 20; i++) settings.request({ kind: "preset", preset: "low" });
    for (let i = 0; i < 20; i++) settings.executeQuality("resolution", "scale", "0.5");
    for (let i = 0; i < 20; i++) settings.request({ kind: "patch", render: { effects: { fxaa: true } } });
    expect(transactions).toHaveLength(3);
  });
  it("rejects nonfinite values and unknown keys atomically without resetting valid settings", () => {
    const { settings, transactions } = session();
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(settings.request({ kind: "patch", render: { width: value }, frameCap: 45 }).status).toBe("failed");
      expect(settings.request({ kind: "patch", frameCap: value }).status).toBe("failed");
    }
    expect(settings.request({ kind: "patch", render: { effects: { fxaa: "yes" } } } as never).status).toBe("failed");
    expect(settings.request({ kind: "patch", render: { editorOnly: true } } as never).status).toBe("failed");
    expect(settings.request({ kind: "patch", render: { mode: "smooth" } } as never).status).toBe("failed");
    expect(settings.requested.frameCap).toBe(30);
    expect(transactions).toHaveLength(0);
  });
  it("normalizes finite out-of-range values and retains only explicitly overridden fields", () => {
    const { settings } = session();
    const result = settings.request({ kind: "patch", render: { width: 0.1, effects: { bloom: { weight: 999 } }, quality: { textures: { anisotropy: 99 } } } });
    expect(result.message).toContain("clamped");
    expect(settings.requested.render.width).toBe(1);
    expect(settings.requested.render.effects?.bloom.weight).toBe(10);
    expect(settings.overrides).toMatchObject({ width: 1, effects: { bloom: { weight: 10 } }, quality: { textures: { anisotropy: 16 } } });
    expect(settings.overrides.effects?.bloom).not.toHaveProperty("enabled");
  });
  it("requires restart for backend changes and does not partially apply their transaction", () => {
    const { settings, transactions } = session();
    expect(settings.request({ kind: "patch", render: { gpuBackend: "webgpu", mode: "pbr" }, frameCap: 50 }).status).toBe("restartRequired");
    expect(settings.requested.render.gpuBackend).toBe("webgl2");
    expect(settings.requested.render.mode).toBe("cel");
    expect(settings.requested.frameCap).toBe(30);
    expect(transactions).toHaveLength(0);
  });
  it("keeps overrides across scenes, while unoverridden scene fields follow their owner", () => {
    const { settings } = session();
    settings.request({ kind: "patch", render: { shadows: { enabled: false } }, frameCap: 20 });
    settings.setScene({ shadowOverrides: { distance: 120 }, celShading: { shadowBands: 7 }, environmentLighting: { enabled: false } });
    expect(settings.requested.render.shadows).toMatchObject({ enabled: false, distance: 120 });
    expect(settings.requested.frameCap).toBe(20);
    expect(settings.requested.render.cel?.shadowBands).toBe(7);
    expect(settings.requested.render.environmentLighting?.enabled).toBe(false);
  });
  it("returns detached data and retains the previous confirmed settings after a failed rebuild", () => {
    const { settings } = session();
    settings.acknowledge({ revision: 0, status: "applied", message: "Ready", effective: settings.requested });
    const result = settings.request({ kind: "patch", render: { effects: { fxaa: true } } });
    settings.acknowledge({ ...result, status: "failed", message: "Allocation failed" });
    const snapshot = settings.snapshot();
    expect(snapshot.effective?.render.effects?.fxaa).toBe(false);
    snapshot.requested.render.width = 10;
    expect(settings.requested.render.width).toBe(800);
  });
});
