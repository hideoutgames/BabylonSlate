import { expect, it, vi } from "vitest";
import { collectReadinessBlockers, MAX_READINESS_BLOCKERS, noteReadinessBlocker } from "./readiness-blockers";

it("names what a probe found unready in the order it met them, each once", () => {
  const names = ["stale"];
  const result = collectReadinessBlockers(names, () => {
    noteReadinessBlocker(() => 'mesh "a"');
    noteReadinessBlocker(() => 'texture "b"');
    noteReadinessBlocker(() => 'mesh "a"');
    return false;
  });
  expect(result).toBe(false);
  expect(names).toEqual(['mesh "a"', 'texture "b"']);
});

it("keeps the first names only and stops describing once it is full", () => {
  const names: string[] = [];
  const describe = vi.fn((index: number) => `mesh "${index}"`);
  collectReadinessBlockers(names, () => {
    for (let index = 0; index < MAX_READINESS_BLOCKERS + 3; index += 1) noteReadinessBlocker(() => describe(index));
  });
  expect(names).toEqual(Array.from({ length: MAX_READINESS_BLOCKERS }, (_, index) => `mesh "${index}"`));
  expect(describe).toHaveBeenCalledTimes(MAX_READINESS_BLOCKERS);
});

it("describes nothing while no probe collects", () => {
  const describe = vi.fn(() => "unread");
  noteReadinessBlocker(describe);
  expect(describe).not.toHaveBeenCalled();
});

it("gives a nested probe's names to the outermost collector and stops collecting when the probe throws", () => {
  const outer: string[] = [];
  const inner = ["untouched"];
  expect(() => collectReadinessBlockers(outer, () => {
    collectReadinessBlockers(inner, () => noteReadinessBlocker(() => 'render target "mirror"'));
    throw new Error("probe failed");
  })).toThrow("probe failed");
  expect(outer).toEqual(['render target "mirror"']);
  expect(inner).toEqual(["untouched"]);
  const describe = vi.fn(() => "late");
  noteReadinessBlocker(describe);
  expect(describe).not.toHaveBeenCalled();
});
