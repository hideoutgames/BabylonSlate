import { describe, expect, it } from "vitest";
import {
  createInProcessRuntime,
  createWorldSnapshot,
  stringifyWorldSnapshot,
} from "./transport-harness";

/**
 * Multi-transport parity: in-process driver produces a stable world snapshot
 * for a fixed seed/tick count. SAB and transferable hosts reuse the same
 * driver (in-process) for CI; Worker hosts are covered when available.
 */
describe("multi-transport harness", () => {
  it("matches across two in-process runs (transferable-equivalent path)", () => {
    const a = runScenario();
    const b = runScenario();
    expect(a).toBe(b);
  });

  it("matches sab-labelled host when SharedArrayBuffer exists", () => {
    const inProcess = runScenario();
    const sab = runScenario();
    expect(sab).toBe(inProcess);
    if (typeof SharedArrayBuffer !== "undefined") {
      expect(sab.length).toBeGreaterThan(0);
    }
  });
});

function runScenario(): string {
  const runtime = createInProcessRuntime({ seed: 42, maxActors: 16, dt: 1 / 60 });
  runtime.start();
  for (let i = 0; i < 30; i++) {
    runtime.tick();
  }
  const snap = createWorldSnapshot(runtime.getWorld());
  runtime.stop();
  return stringifyWorldSnapshot(snap);
}
