import { describe, expect, it } from "vitest";
import { FrameBackpressure } from "./frame-backpressure";
import type { FrameMarker } from "./gpu-busy-probe";

/** Markers the test finishes by hand, as the GPU would, in submission order. */
function gpu() {
  const queue: { finished: boolean | null; disposed: boolean }[] = [];
  let frame = 0;
  const gate = new FrameBackpressure((submitted): FrameMarker => {
    const entry = { finished: false as boolean | null, disposed: false };
    queue.push(entry);
    return { submitted, done: () => entry.finished, dispose: () => { entry.disposed = true; } };
  }, () => frame);
  /** One Engine frame: each view asks to render, then the frame ends. */
  const run = (views = 1) => {
    frame += 1;
    let rendered = false;
    for (let view = 0; view < views; view++) rendered = gate.admit() || rendered;
    gate.frameEnd();
    return rendered;
  };
  return { gate, queue, run };
}

describe("frame backpressure", () => {
  it("renders while fewer than two frames are queued on the GPU, skips the render beyond, and resumes as frames finish", () => {
    const { gate, queue, run } = gpu();
    expect([run(), run()]).toEqual([true, true]);
    // Frames 1 and 2 still queued: frame 3 waits for frame 1, without blocking, once per Engine frame whatever its views.
    expect([run(2), run(2)]).toEqual([false, false]);
    expect(gate.stats()).toEqual({ mode: 2, inFlight: 2, skipped: 2 });
    queue[0]!.finished = true;
    expect(run()).toBe(true);
    expect(queue[0]!.disposed).toBe(true);
    expect(gate.stats()).toEqual({ mode: 2, inFlight: 2, skipped: 2 });
    // A skipped frame submitted no marker: only rendered frames are in flight.
    expect(queue).toHaveLength(3);
  });

  it("queues three frames in mode 3, none in off, and frees a marker that cannot tell (a lost context)", () => {
    const { gate, queue, run } = gpu();
    gate.setMode(3);
    expect([run(), run(), run(), run()]).toEqual([true, true, true, false]);
    queue[0]!.finished = null;
    expect(run()).toBe(true);
    gate.setMode("off");
    // Off drops what was queued and renders every frame without submitting markers.
    expect(queue.every((entry) => entry.disposed)).toBe(true);
    const submitted = queue.length;
    expect([run(), run(), run()]).toEqual([true, true, true]);
    expect(queue).toHaveLength(submitted);
    expect(gate.stats()).toEqual({ mode: "off", inFlight: 0, skipped: 1 });
  });

  it("submits nothing for a frame no view rendered, and renders every frame without a marker source", () => {
    const { gate, queue } = gpu();
    gate.frameEnd();
    expect(queue).toHaveLength(0);
    const unmarked = new FrameBackpressure(null, () => 0);
    expect([unmarked.admit(), unmarked.admit(), unmarked.admit()]).toEqual([true, true, true]);
    expect(unmarked.stats()).toEqual({ mode: 2, inFlight: 0, skipped: 0 });
  });
});
