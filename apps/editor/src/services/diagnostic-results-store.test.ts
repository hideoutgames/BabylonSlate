import { expect, it, vi } from "vitest";
import type { PerformanceProfile } from "@babylonslate/debugger";
import type { RenderFrameReport } from "@babylonslate/render";
import { DiagnosticResultsStore, type DiagnosticSessionPorts } from "./diagnostic-results-store";

const options = { durationMs: 10_000, byteBudget: 16 * 1024 * 1024 };
function ports(overrides: Partial<DiagnosticSessionPorts> = {}): DiagnosticSessionPorts {
  return { mode: "play", startProfile: vi.fn(async () => {}), stopProfile: vi.fn(async () => null),
    captureFrame: vi.fn(async () => { throw new Error("Unavailable"); }), ...overrides };
}
it("opens old results without collecting and enforces Simulation capability in dispatch", async () => {
  const store = new DiagnosticResultsStore();
  const session = ports({ mode: "simulate" });
  store.bindSession(session);
  store.open();
  expect(session.startProfile).not.toHaveBeenCalled();
  expect(session.captureFrame).not.toHaveBeenCalled();
  await store.startProfile(options);
  await store.captureFrame();
  expect(session.startProfile).not.toHaveBeenCalled();
  expect(session.captureFrame).not.toHaveBeenCalled();
  expect(store.getSnapshot().error).toContain("Use Play or Preview Build");
});
it("keeps one result and ignores a previous session's late collection", async () => {
  const store = new DiagnosticResultsStore();
  const first = store.bindSession(ports());
  const profile = { kind: "babylonslate-performance" } as PerformanceProfile;
  first.publishProfile(profile);
  first.release();
  expect(store.getSnapshot().result).toEqual({ kind: "profile", profile });
  const second = store.bindSession(ports());
  const report = { version: 1 } as RenderFrameReport;
  second.publishFrame(report);
  first.publishProfile(profile);
  first.publishError("late failure");
  expect(store.getSnapshot()).toMatchObject({ error: null, result: { kind: "frame", report } });
});
it("rejects concurrent operations and restores the idle UI after a transport failure", async () => {
  const store = new DiagnosticResultsStore();
  const session = ports();
  const lease = store.bindSession(session);
  await store.startProfile(options);
  await store.captureFrame();
  expect(session.captureFrame).not.toHaveBeenCalled();
  expect(store.getSnapshot().active).toBe("profile");
  lease.publishError("The player disconnected.");
  expect(store.getSnapshot()).toMatchObject({ active: null, busy: false, error: "The player disconnected." });
});
it("hands input to the result surface without changing session camera ownership", async () => {
  const store = new DiagnosticResultsStore();
  const setSurfaceOpen = vi.fn(async () => {});
  store.bindSession(ports({ setSurfaceOpen }));
  store.open(); await Promise.resolve(); store.close();
  expect(setSurfaceOpen.mock.calls).toEqual([[true], [false]]);
});
it("does not re-suppress input when the dialog closes during a game-input release", async () => {
  const store = new DiagnosticResultsStore();
  let release!: () => void;
  const setSurfaceOpen = vi.fn(async () => {});
  store.bindSession(ports({ releaseInput: () => new Promise<void>(resolve => { release = resolve; }), setSurfaceOpen }));
  store.open(); store.close(); release();
  await Promise.resolve();
  expect(setSurfaceOpen.mock.calls).toEqual([[false]]);
});
it("preserves recording controls when input suppression reports an error", async () => {
  const store = new DiagnosticResultsStore();
  store.bindSession(ports({ setSurfaceOpen: async () => { throw new Error("Input boundary failed."); } }));
  await store.startProfile(options);
  store.open();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(store.getSnapshot()).toMatchObject({ active: "profile", busy: false, error: "Input boundary failed." });
});
