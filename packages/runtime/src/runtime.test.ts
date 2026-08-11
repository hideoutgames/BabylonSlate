import { describe, expect, it } from "vitest";
import {
  parseStackFrames,
  lookupAnchor,
  type AnchorEntry,
  type StackFrame,
} from "./stack-map";
import { LogRingBuffer } from "./log-ring";
import { loadCompiledModule } from "./module-loader";
import { createInProcessRuntime } from "./driver";
import {
  readSnapshotHeader,
  snapshotFloatCount,
} from "@babylonslate/bridge";

describe("stack parser", () => {
  it("parses V8 and WebKit frames", () => {
    const v8 = parseStackFrames(
      "Error: boom\n    at foo (babylonslate:///abc.js:10:5)\n    at bar (file:///other.js:1:1)",
    );
    expect(v8[0]).toMatchObject({
      url: "babylonslate:///abc.js",
      line: 10,
      column: 5,
    });
    const webkit = parseStackFrames(
      "foo@babylonslate:///abc.js:12:3\nbar@native",
    );
    expect(webkit[0]).toMatchObject({
      url: "babylonslate:///abc.js",
      line: 12,
      column: 3,
    });
  });

  it("looks up the nearest preceding anchor", () => {
    const anchors: AnchorEntry[] = [
      { line: 1, column: 0, assetGuid: "a", graphId: "g", nodeId: "n1" },
      { line: 10, column: 0, assetGuid: "a", graphId: "g", nodeId: "n2" },
      { line: 20, column: 0, assetGuid: "a", graphId: "g", nodeId: "n3" },
    ];
    expect(lookupAnchor(anchors, 15, 0)?.nodeId).toBe("n2");
    expect(lookupAnchor(anchors, 1, 0)?.nodeId).toBe("n1");
    expect(lookupAnchor(anchors, 0, 0)).toBeNull();
  });
});

describe("log ring", () => {
  it("caps entries and preserves newest", () => {
    const ring = new LogRingBuffer(2);
    ring.push({
      severity: "log",
      category: "test",
      message: "a",
      frameId: 1,
    });
    ring.push({
      severity: "log",
      category: "test",
      message: "b",
      frameId: 2,
    });
    ring.push({
      severity: "error",
      category: "test",
      message: "c",
      frameId: 3,
    });
    expect(ring.entries().map((e) => e.message)).toEqual(["b", "c"]);
  });
});

describe("module loader", () => {
  it("evaluates a fixture module via Function fallback", async () => {
    const source = `
      export function run() { return 41 + 1; }
      //# sourceURL=babylonslate:///fixture.js
    `;
    const mod = await loadCompiledModule(source, "fixture");
    expect(mod.run()).toBe(42);
  });
});

describe("in-process runtime driver", () => {
  it("ticks a world and writes snapshot headers", () => {
    const runtime = createInProcessRuntime({
      seed: 7,
      maxActors: 8,
      dt: 1 / 60,
    });
    runtime.start();
    for (let i = 0; i < 5; i++) {
      runtime.tick();
    }
    const buf = new Float32Array(snapshotFloatCount(8));
    expect(runtime.copySnapshot(buf)).toBe(true);
    const header = readSnapshotHeader(buf);
    expect(header.tickIndex).toBe(5);
    expect(header.actorCount).toBeGreaterThan(0);
    runtime.stop();
  });
});
