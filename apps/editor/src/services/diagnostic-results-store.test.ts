import { expect, it, vi } from "vitest";
import type { PerformanceProfile } from "@haptic/debugger";
import type { RenderFrameReport } from "@haptic/render";
import { DiagnosticResultsStore, PROFILE_HISTORY_BYTES, PROFILE_HISTORY_COUNT, type DiagnosticSessionPorts } from "./diagnostic-results-store";

const options = { durationMs: 10_000, byteBudget: 16 * 1024 * 1024 };
/** A recording with what the history reads: its length, frame count and retained bytes. */
const recording = (durationMs = 1000, retainedBytes = 1024) =>
  ({ kind: "haptic-performance", durationMs, retainedBytes, frames: { count: 60 } }) as unknown as PerformanceProfile;
const capture = (renderFrameId = 1) => ({ version: 1, frame: { renderFrameId } }) as unknown as RenderFrameReport;
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
  const profile = recording();
  first.publishProfile(profile);
  first.release();
  const second = store.bindSession(ports());
  const report = capture();
  second.publishFrame(report);
  const later = recording(1);
  first.publishProfile(later);
  first.publishError("late failure");
  expect(store.getSnapshot()).toMatchObject({ error: null, view: "frame", profile, frame: report });
  expect(store.getSnapshot().profile).toBe(profile);
});

it("opens a saved frame report beside the recording it does not replace", () => {
  const store = new DiagnosticResultsStore();
  const profile = recording();
  const report = capture();
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

it("keeps the newest recordings within the count and byte limits, and shows any of them", () => {
  const store = new DiagnosticResultsStore({ now: () => new Date(2026, 9, 23, 10, 4, 31) });
  const lease = store.bindSession(ports());
  const profiles = Array.from({ length: PROFILE_HISTORY_COUNT + 1 }, (_, index) => recording(1000 * (index + 1)));
  for (const profile of profiles) lease.publishProfile(profile);
  const history = store.getSnapshot().profiles;
  expect(history.map((entry) => entry.value)).toEqual(profiles.slice(1).reverse());
  expect(history[0]).toMatchObject({ name: "Recording 6 · 10:04:31", label: "Recording 6 · 10:04:31 · 6.00 s · 60 Frames" });
  store.show(history[2]!.id);
  expect(store.getSnapshot().profile).toBe(profiles[3]);
  // A recording that fills the byte limit leaves only itself.
  lease.publishProfile(recording(1000, PROFILE_HISTORY_BYTES - 512));
  expect(store.getSnapshot().profiles).toHaveLength(1);
});

it("keeps the baseline while new recordings arrive, until it leaves the history", () => {
  const store = new DiagnosticResultsStore();
  const lease = store.bindSession(ports());
  lease.publishProfile(recording());
  const baseline = store.getSnapshot().profiles[0]!.id;
  store.compareWith(baseline);
  lease.publishProfile(recording(2000));
  expect(store.getSnapshot().baselineId).toBe(baseline);
  for (let index = 0; index < PROFILE_HISTORY_COUNT; index++) lease.publishProfile(recording());
  expect(store.getSnapshot().baselineId).toBeNull();
});

it("keeps a recording once when Stop also returns the one it published, and adds an opened file under its name", async () => {
  const store = new DiagnosticResultsStore();
  const profile = recording();
  const lease = store.bindSession(ports({ stopProfile: vi.fn(async () => { lease.publishProfile(profile); return profile; }) }));
  await store.startProfile(options);
  await store.stopProfile();
  expect(store.getSnapshot().profiles).toHaveLength(1);
  store.importResult({ kind: "profile", profile: recording(2500) }, "baseline.babprofile.json");
  expect(store.getSnapshot().profiles[0]?.label).toBe("baseline.babprofile.json · 2.50 s · 60 Frames");
  expect(store.getSnapshot().profiles).toHaveLength(2);
});
