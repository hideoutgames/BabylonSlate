import { expect, it, vi } from "vitest";
import type { PerformanceProfile } from "@haptic/debugger";
import type { RenderFrameReport } from "@haptic/render";
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
it("keeps the latest recording when a frame is captured, and ignores a previous session's late collection", async () => {
  const store = new DiagnosticResultsStore();
  const first = store.bindSession(ports());
  const profile = { kind: "haptic-performance" } as PerformanceProfile;
  first.publishProfile(profile);
  first.release();
  const second = store.bindSession(ports());
  const report = { version: 1 } as RenderFrameReport;
  second.publishFrame(report);
  const later = { kind: "haptic-performance", durationMs: 1 } as PerformanceProfile;
  first.publishProfile(later);
  first.publishError("late failure");
  expect(store.getSnapshot()).toMatchObject({ error: null, view: "frame", profile, frame: report });
  expect(store.getSnapshot().profile).toBe(profile);
});

it("opens a saved frame report beside the recording it does not replace", () => {
  const store = new DiagnosticResultsStore();
  const profile = { kind: "haptic-performance" } as PerformanceProfile;
  const report = { version: 1 } as RenderFrameReport;
  store.importResult({ kind: "profile", profile });
  store.importResult({ kind: "frame", report });
  expect(store.getSnapshot()).toMatchObject({ view: "frame", profile, frame: report });
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
