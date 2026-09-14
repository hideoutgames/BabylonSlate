import { expect, it } from "vitest";
import { PostProcessRetirement } from "./post-process-retirement";

function signal() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("reports uncertainty without permitting resource release, then permits confirmed late release", async () => {
  const reported = signal();
  const released = signal();
  const retirement = new PostProcessRetirement();
  retirement.add({ whenDisposed: () => reported.promise, whenReleased: () => released.promise });
  let resourcesReleased = false;
  const completion = retirement.whenReleased().then(() => { resourcesReleased = true; });
  reported.reject(new Error("native compilation deadline"));
  await expect(retirement.whenDisposed()).rejects.toThrow("native compilation deadline");
  expect(resourcesReleased).toBe(false);
  released.resolve();
  await completion;
  expect(resourcesReleased).toBe(true);
  await expect(retirement.whenDisposed()).rejects.toThrow("native compilation deadline");
});

it("waits for older retired generations even after the latest one releases", async () => {
  const older = signal();
  const newer = signal();
  const retirement = new PostProcessRetirement();
  for (const release of [older, newer]) retirement.add({ whenDisposed: () => release.promise, whenReleased: () => release.promise });
  let completed = false;
  const done = retirement.whenReleased().then(() => { completed = true; });
  newer.resolve();
  await newer.promise;
  expect(completed).toBe(false);
  older.resolve();
  await done;
  expect(completed).toBe(true);
});

it("never treats a failed actual cleanup as release permission after its promise settles", async () => {
  const failure = Promise.reject(new Error("native cleanup failed"));
  const retirement = new PostProcessRetirement();
  retirement.add({ whenDisposed: () => failure, whenReleased: () => failure });
  await expect(retirement.whenReleased()).rejects.toThrow("native cleanup failed");
  await expect(retirement.whenReleased()).rejects.toThrow("native cleanup failed");
});
