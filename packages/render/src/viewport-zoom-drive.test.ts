import { beforeEach, describe, expect, it } from "vitest";
import {
  createViewportZoomDrive,
  type ViewportZoomDriveOptions,
} from "./viewport-zoom-drive";

const FRAME_MS = 1000 / 60;

describe("createViewportZoomDrive", () => {
  let frames: { id: number; callback: FrameRequestCallback }[];
  let nextFrameId: number;
  let nowMs: number;
  let factors: number[];
  let acquired: string[];
  let released: number;

  beforeEach(() => {
    frames = [];
    nextFrameId = 1;
    nowMs = 0;
    factors = [];
    acquired = [];
    released = 0;
  });

  function create(options: ViewportZoomDriveOptions = {}) {
    return createViewportZoomDrive(
      { zoom: (factor: number) => void factors.push(factor) },
      {
        scheduler: {
          acquireContinuous: (reason: string) => {
            acquired.push(reason);
            return () => {
              released += 1;
            };
          },
        },
        requestFrame: (callback) => {
          const id = nextFrameId++;
          frames.push({ id, callback });
          return id;
        },
        cancelFrame: (id) => {
          frames = frames.filter((frame) => frame.id !== id);
        },
        ...options,
      },
    );
  }

  function pump(dtMs: number): void {
    const frame = frames.shift();
    if (!frame) throw new Error("no scheduled zoom frame");
    nowMs += dtMs;
    frame.callback(nowMs);
  }

  /** Pump frames until the drive stops asking for them; returns how many ran. */
  function drain(dtMs = FRAME_MS, limit = 600): number {
    let count = 0;
    while (frames.length > 0) {
      if (count >= limit) throw new Error("zoom drive never settled");
      pump(count === 0 ? 0 : dtMs);
      count += 1;
    }
    return count;
  }

  const product = () => factors.reduce((total, factor) => total * factor, 1);

  it("glides a quick tap over several frames to exactly one 1.2 step, then ends", () => {
    const drive = create();
    drive.start(1);
    drive.stop();
    expect(factors).toHaveLength(0);

    const ran = drain();

    expect(ran).toBeGreaterThan(5);
    expect(factors.length).toBeGreaterThan(5);
    expect(product()).toBeCloseTo(1.2, 10);
    expect(frames).toHaveLength(0);
    expect(acquired).toEqual(["viewport-zoom"]);
    expect(released).toBe(1);
  });

  it("zooms out a tap by the reciprocal step", () => {
    const drive = create();
    drive.step(-1);
    drain();
    expect(product()).toBeCloseTo(1 / 1.2, 10);
    for (const factor of factors) expect(factor).toBeLessThan(1);
  });

  it("zooms continuously at three times per second while held, and stops at once on release", () => {
    const drive = create();
    drive.start(1);
    pump(0);
    for (let i = 0; i < 60; i += 1) pump(FRAME_MS);
    expect(factors).toHaveLength(60);
    expect(product()).toBeCloseTo(3, 6);

    // A stalled frame counts at most 50 ms.
    pump(500);
    expect(product()).toBeCloseTo(3 * 3 ** 0.05, 6);

    const before = factors.length;
    drive.stop();
    expect(frames).toHaveLength(0);
    expect(released).toBe(1);
    expect(factors).toHaveLength(before);
  });

  it("finishes a press released mid-step without a speed change", () => {
    const drive = create();
    drive.start(1);
    pump(0);
    pump(FRAME_MS);
    pump(FRAME_MS);
    const heldStep = factors[1];
    drive.stop();
    expect(frames).toHaveLength(1);
    pump(FRAME_MS);
    expect(factors[2]).toBeCloseTo(heldStep, 12);
    drain();
    expect(product()).toBeCloseTo(1.2, 10);
  });

  it("applies the whole step inside start under instantStep, and a quick release adds nothing", () => {
    const drive = create({ instantStep: () => true });
    drive.start(1);
    expect(factors).toHaveLength(1);
    expect(factors[0]).toBeCloseTo(1.2, 12);

    drive.stop();
    expect(frames).toHaveLength(0);
    expect(released).toBe(1);
    expect(factors).toHaveLength(1);
  });

  it("keeps zooming an instant press that is held past one step, without a jump", () => {
    const drive = create({ instantStep: () => true });
    drive.start(1);
    pump(0);
    for (let i = 0; i < 9; i += 1) pump(FRAME_MS);
    // 150 ms at 3x/s is still under the 1.2 already applied.
    expect(factors).toHaveLength(1);
    for (let i = 0; i < 51; i += 1) pump(FRAME_MS);
    expect(product()).toBeCloseTo(3, 6);
  });

  it("ignores start while disabled", () => {
    const drive = create({ isEnabled: () => false });
    drive.start(1);
    drive.step(-1);
    expect(frames).toHaveLength(0);
    expect(acquired).toHaveLength(0);
    expect(factors).toHaveLength(0);
  });

  it("ends a hold without zooming when it becomes disabled", () => {
    let enabled = true;
    const drive = create({ isEnabled: () => enabled });
    drive.start(1);
    pump(0);
    pump(FRAME_MS);
    const before = factors.length;
    enabled = false;
    pump(FRAME_MS);
    expect(factors).toHaveLength(before);
    expect(frames).toHaveLength(0);
    expect(released).toBe(1);
    drive.stop();
    expect(released).toBe(1);
  });

  it("restarts in the other direction mid-glide with one loop and one lease", () => {
    const drive = create();
    drive.step(1);
    pump(0);
    pump(FRAME_MS);
    expect(factors.length).toBeGreaterThan(0);

    factors = [];
    drive.step(-1);
    expect(frames).toHaveLength(1);
    expect(acquired).toEqual(["viewport-zoom"]);

    drain();
    expect(product()).toBeCloseTo(1 / 1.2, 10);
    expect(released).toBe(1);
  });

  it("cancels the frame and releases the lease on dispose, and stays inert", () => {
    const drive = create();
    drive.start(1);
    pump(0);
    pump(FRAME_MS);
    drive.dispose();
    expect(frames).toHaveLength(0);
    expect(released).toBe(1);

    const before = factors.length;
    drive.start(1);
    drive.step(-1);
    drive.dispose();
    expect(frames).toHaveLength(0);
    expect(acquired).toHaveLength(1);
    expect(released).toBe(1);
    expect(factors).toHaveLength(before);
  });
});
