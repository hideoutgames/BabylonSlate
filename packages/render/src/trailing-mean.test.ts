import { describe, expect, it } from "vitest";
import { TrailingMean } from "./trailing-mean";

describe("TrailingMean", () => {
  it("averages the last values added, the oldest leaving as each new one arrives", () => {
    const mean = new TrailingMean(4);
    expect(mean.mean()).toBeNull();
    mean.add(1);
    mean.add(0);
    expect(mean.mean()).toBe(0.5);
    for (const value of [0, 1, 0]) mean.add(value);
    // The first 1 has left: 0, 0, 1, 0.
    expect(mean.mean()).toBe(0.25);
    for (const value of [3, 3, 3, 3]) mean.add(value);
    expect(mean.mean()).toBe(3);
  });

  it("ignores a value that is not a finite number", () => {
    const mean = new TrailingMean(2);
    mean.add(2);
    mean.add(Number.NaN);
    mean.add(Number.POSITIVE_INFINITY);
    expect(mean.mean()).toBe(2);
  });
});
