import { describe, expect, it, vi } from "vitest";
import { ScalabilitySession, type ScalabilityAcknowledgement, type ScalabilityTransaction } from "@haptic/core";
import { RuntimeScalability } from "./runtime-scalability";

function fixture() {
  const initial = new ScalabilitySession({}, 60).transaction();
  const applied: ScalabilityTransaction[] = [];
  const acknowledgements: ScalabilityAcknowledgement[] = [];
  const work: { resolve(): void; reject(error: Error): void }[] = [];
  const released = vi.fn();
  const retainResources = vi.fn(() => released);
  const controller = new RuntimeScalability(initial, {
    apply: (transaction) => applied.push(transaction),
    prepare: (assertCurrent) => new Promise<void>((resolve, reject) => work.push({ resolve: () => { try { assertCurrent(); resolve(); } catch (error) { reject(error); } }, reject })),
    read: (transaction) => ({ revision: transaction.revision, status: "applied", message: "Ready", effective: transaction.settings }),
    publish: (ack) => acknowledgements.push(ack), invalidate: vi.fn(), retainResources,
  });
  const session = new ScalabilitySession({}, 60, {}, (transaction) => controller.enqueue(transaction));
  return { controller, session, applied, acknowledgements, work, retainResources, released };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe("view runtime scalability queue", () => {
  it("coalesces requests at the existing frame boundary and acknowledges only a presented ready frame", async () => {
    const f = fixture();
    f.session.request({ kind: "patch", frameCap: 30 });
    f.session.request({ kind: "patch", render: { effects: { exposure: 2 } } });
    expect(f.applied).toHaveLength(0);
    f.controller.advance();
    expect(f.applied).toHaveLength(1);
    expect(f.applied[0]?.settings).toMatchObject({ frameCap: 30, render: { effects: { exposure: 2 } } });
    expect(f.controller.canPresent).toBe(false);
    f.work[0]!.resolve(); await flush();
    expect(f.acknowledgements).toHaveLength(0);
    expect(f.controller.canPresent).toBe(true);
    f.controller.presented();
    expect(f.acknowledgements).toMatchObject([{ revision: 2, status: "applied" }]);
  });
  it("cancels stale preparation and handles a newer request after readiness but before presentation", async () => {
    const f = fixture();
    f.session.request({ kind: "patch", frameCap: 30 }); f.controller.advance();
    f.session.request({ kind: "patch", frameCap: 20 });
    f.work[0]!.resolve(); await flush(); f.controller.advance();
    f.work[1]!.resolve(); await flush();
    f.session.request({ kind: "patch", frameCap: 25 }); f.controller.advance();
    f.work[2]!.resolve(); await flush(); f.controller.presented();
    expect(f.acknowledgements).toMatchObject([{ revision: 3, effective: { frameCap: 25 } }]);
  });
  it("restores the last confirmed request on allocation failure without acknowledging the failed settings", async () => {
    const f = fixture();
    f.controller.presented();
    f.session.request({ kind: "patch", render: { effects: { exposure: 2 } } }); f.controller.advance();
    f.work[0]!.reject(new Error("Target allocation failed")); await flush();
    expect(f.controller.canPresent).toBe(false);
    f.controller.advance();
    expect(f.applied[1]?.settings.render.effects?.exposure).toBe(1);
    f.work[1]!.resolve(); await flush(); f.controller.presented();
    expect(f.acknowledgements).toMatchObject([{ revision: 0, status: "applied" }, { revision: 1, status: "failed" }]);
  });
  it("releases queued work on disposal and never publishes late completions", async () => {
    const f = fixture();
    f.session.request({ kind: "patch", frameCap: 30 }); f.controller.advance();
    f.controller.dispose(); f.work[0]!.resolve(); await flush();
    f.controller.advance(); f.controller.presented();
    expect(f.acknowledgements).toHaveLength(0);
    expect(f.applied).toHaveLength(1);
  });
  it("stops retrying a failed restoration until a new explicit request arrives", async () => {
    const f = fixture();
    f.session.request({ kind: "patch", frameCap: 30 }); f.controller.advance();
    f.work[0]!.reject(new Error("Allocation failed")); await flush(); f.controller.advance();
    f.work[1]!.reject(new Error("Device lost")); await flush();
    for (let frame = 0; frame < 20; frame++) f.controller.advance();
    expect(f.applied).toHaveLength(2);
    expect(f.controller.canPresent).toBe(false);
    f.session.request({ kind: "patch", frameCap: 20 }); f.controller.advance();
    f.work[2]!.resolve(); await flush(); f.controller.presented();
    expect(f.acknowledgements.at(-1)).toMatchObject({ revision: 2, status: "applied" });
  });
  it("applies a request that changes nothing drawn without retaining, preparing or holding, acknowledged at the next presented frame", async () => {
    const f = fixture();
    f.controller.presented();
    // Reflection Shadows are already off at the default level: only its label changes. Then the frame cap alone.
    for (const [request, effective] of [
      [() => f.session.executeQuality("shadows", "reflections", "off"), { render: { shadows: { reflections: false, preset: "custom" } } }],
      [() => f.session.request({ kind: "patch", frameCap: 30 }), { frameCap: 30 }],
    ] as const) {
      const revision = f.applied.length + 1;
      request();
      f.controller.advance();
      expect(f.applied).toHaveLength(revision);
      expect(f.controller.canPresent).toBe(true);
      expect(f.acknowledgements.at(-1)?.revision).toBe(revision - 1);
      f.controller.presented();
      expect(f.acknowledgements.at(-1)).toMatchObject({ revision, status: "applied", effective });
    }
    expect([f.work.length, f.retainResources.mock.calls.length]).toEqual([0, 0]);
    // A drawn change retains, prepares and holds. Undone while it prepares, it leaves the view prepared for neither: the
    // undo prepares too, though it draws what the last presented frame drew, and only then releases what was retained.
    f.session.request({ kind: "patch", render: { effects: { exposure: 2 } } }); f.controller.advance();
    expect(f.controller.canPresent).toBe(false);
    f.session.request({ kind: "patch", render: { effects: { exposure: 1 } } });
    f.work[0]!.resolve(); await flush();
    f.controller.advance();
    expect(f.work).toHaveLength(2);
    expect(f.controller.canPresent).toBe(false);
    f.work[1]!.resolve(); await flush(); f.controller.presented();
    expect(f.acknowledgements.at(-1)).toMatchObject({ revision: 4, effective: { render: { effects: { exposure: 1 } } } });
    expect([f.retainResources.mock.calls.length, f.released.mock.calls.length]).toEqual([1, 1]);
  });
});
