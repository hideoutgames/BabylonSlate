import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer } from "@babylonslate/core";
import {
  readSnapshotHeader,
  snapshotFloatCount,
  type BridgeHostMessage,
  type BridgeWorkerMessage,
  type CommandMessage,
  type ControlMessage,
  type RuntimeInspectorAction,
} from "@babylonslate/bridge";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";
import { createRuntimeFromLoad, runtimeOptionsFromLoadControl } from "./play-load";
import {
  createWorkerScheduler,
  type WorkerSchedulerHost,
} from "./worker-scheduler";

vi.mock("./play-load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./play-load")>()),
  createRuntimeFromLoad: vi.fn(),
}));

interface ScheduledCallback {
  callback: (now: number) => void;
  cancelled: boolean;
}

function createHost(withAnimationFrame: boolean) {
  let now = 100;
  let nextHandle = 1;
  const callbacks = new Map<number, ScheduledCallback>();
  const host: WorkerSchedulerHost = {
    performance: { now: () => now },
    setTimeout: (callback) => {
      const handle = nextHandle++;
      callbacks.set(handle, { callback, cancelled: false });
      return handle;
    },
    clearTimeout: (handle) => {
      const scheduled = callbacks.get(handle);
      if (scheduled) scheduled.cancelled = true;
    },
  };

  if (withAnimationFrame) {
    host.requestAnimationFrame = (callback) => {
      const handle = nextHandle++;
      callbacks.set(handle, { callback, cancelled: false });
      return handle;
    };
    host.cancelAnimationFrame = (handle) => {
      const scheduled = callbacks.get(handle);
      if (scheduled) scheduled.cancelled = true;
    };
  }

  const runNext = (advanceMs: number): void => {
    now += advanceMs;
    const entry = [...callbacks.entries()].find(
      ([, value]) => !value.cancelled,
    );
    if (!entry) throw new Error("No scheduled worker callback");
    callbacks.delete(entry[0]);
    entry[1].callback(now);
  };

  return {
    host,
    runNext,
    activeCount: () =>
      [...callbacks.values()].filter((item) => !item.cancelled).length,
  };
}

describe.each([
  ["requestAnimationFrame", true],
  ["monotonic timer fallback", false],
] as const)("worker entry scheduler with %s", (_label, withAnimationFrame) => {
  it("rebases a paused clock without replacing its scheduled callback", () => {
    const harness = createHost(withAnimationFrame);
    const elapsed: number[] = [];
    const scheduler = createWorkerScheduler(harness.host, value => elapsed.push(value));
    scheduler.start(); harness.runNext(16); harness.runNext(20);
    scheduler.resetClock(); harness.runNext(300_000); harness.runNext(25);
    expect(elapsed).toEqual([0, 0.02, 0, 0.025]);
    expect(harness.activeCount()).toBe(1);
    scheduler.stop();
  });
  it("boots, repeatedly advances elapsed time, and stops cleanly", () => {
    const harness = createHost(withAnimationFrame);
    const advance = vi.fn();
    const scheduler = createWorkerScheduler(harness.host, advance);

    scheduler.start();
    scheduler.start();
    expect(harness.activeCount()).toBe(1);

    harness.runNext(16);
    harness.runNext(20);
    harness.runNext(25);
    expect(advance.mock.calls).toEqual([[0], [0.02], [0.025]]);
    expect(harness.activeCount()).toBe(1);

    scheduler.stop();
    expect(harness.activeCount()).toBe(0);
    expect(() => harness.runNext(16)).toThrow("No scheduled worker callback");
    expect(advance).toHaveBeenCalledTimes(3);
  });
});

describe("worker entry snapshot transport", () => {
  type Post =
    | { kind: "snapshot"; frameId: number; buffer: ArrayBuffer }
    | { kind: "command"; command: CommandMessage };
  let send: ((control: ControlMessage) => void) | undefined;
  afterEach(() => {
    send?.({ type: "stop" });
    send = undefined;
    vi.unstubAllGlobals();
  });

  /** Boot the real worker entry against a host that recycles only when told to. */
  async function bootWorker(load: Extract<ControlMessage, { type: "load" }>, before: ControlMessage[] = []) {
    vi.resetModules();
    let now = 0;
    const frames: FrameRequestCallback[] = [];
    const host = {
      onmessage: undefined as ((event: { data: BridgeHostMessage }) => void) | undefined,
      performance: { now: () => now },
      requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
      cancelAnimationFrame() {},
      addEventListener() {},
    };
    vi.stubGlobal("self", host);
    const deliver = (data: BridgeHostMessage) => host.onmessage!({ data });
    const posts: Post[] = [];
    vi.stubGlobal("postMessage", (message: BridgeWorkerMessage) => {
      if (message.channel === "snapshot") {
        const frameId = readSnapshotHeader(new Float32Array(message.payload)).frameId;
        posts.push({ kind: "snapshot", frameId, buffer: message.payload });
        return;
      }
      const command = message.payload;
      posts.push({ kind: "command", command });
      // Like the real hosts, acknowledge a layout change on a later task.
      if (command.type === "snapshotLayout") {
        queueMicrotask(() => deliver({ channel: "snapshotLayoutAck", generation: command.generation }));
      }
    });
    const emitted: CommandMessage[] = [];
    let runtime!: RuntimeDriver;
    const hud = { ...createDefaultSceneLayer(), actors: [createActor("badge", "Badge", { classId: "SceneLayerActor" })] };
    vi.mocked(createRuntimeFromLoad).mockImplementation((control, onCommand) => {
      runtime = createInProcessRuntime({
        ...runtimeOptionsFromLoadControl(control),
        preferSoftwarePhysics: true,
        sceneLayerLibrary: { hud },
        onCommand: (command) => {
          emitted.push(command);
          onCommand(command);
        },
      });
      return runtime;
    });
    await import("./worker-entry");
    send = (payload) => deliver({ channel: "control", payload });
    send(load);
    for (const control of before) send(control);
    send({ type: "play" });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    return {
      deliver, posts, emitted, runtime,
      runFrames(count: number) {
        for (let i = 0; i < count; i++) {
          now += 1000 / 60;
          frames.shift()!(now);
        }
      },
      kinds: (list = posts) => list.map((post) => post.kind === "snapshot" ? "snapshot" : post.command.type),
      snapshots: () => posts.flatMap((post) => post.kind === "snapshot" ? [post] : []),
      newestFrame() {
        const buffer = new Float32Array(snapshotFloatCount(runtime.snapshotCapacity));
        expect(runtime.copySnapshot(buffer)).toBe(true);
        return readSnapshotHeader(buffer).frameId;
      },
    };
  }

  it("holds poses at two outstanding transfers, then publishes the newest one before held markers", async () => {
    const { deliver, posts, emitted, runtime, runFrames, kinds, snapshots, newestFrame } = await bootWorker(
      { type: "load", sceneAssetGuid: "main", scene: { ...createDefaultScene(), actors: [createActor("prop", "Prop")] } });

    // The host never recycles: after two poses, ticks keep simulating
    // without queueing more transfers.
    runFrames(8);
    expect(kinds().indexOf("snapshot")).toBeLessThan(kinds().indexOf("sceneRealized"));
    expect(snapshots()).toHaveLength(2);

    // A SceneLayer realized meanwhile waits for a pose that includes it.
    runtime.createSceneLayer("hud");
    for (let i = 0; i < 50 && !emitted.some((command) => command.type === "sceneLayerRealized"); i++) {
      runFrames(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(emitted.some((command) => command.type === "sceneLayerRealized")).toBe(true);
    runFrames(3);
    expect(snapshots()).toHaveLength(2);
    expect(kinds()).not.toContain("sceneLayerRealized");

    let newest = newestFrame();
    expect(newest).toBeGreaterThan(snapshots()[1]!.frameId);
    let before = posts.length;
    deliver({ channel: "recycleSnapshot", payload: snapshots()[0]!.buffer });
    expect(kinds(posts.slice(before))).toEqual(["snapshot", "sceneLayerRealized"]);
    expect(snapshots()[2]!.frameId).toBe(newest);

    // Without a held marker, a returned buffer carries the newest skipped pose at once.
    runFrames(2);
    expect(snapshots()).toHaveLength(3);
    newest = newestFrame();
    expect(newest).toBeGreaterThan(snapshots()[2]!.frameId);
    before = posts.length;
    deliver({ channel: "recycleSnapshot", payload: snapshots()[1]!.buffer });
    expect(kinds(posts.slice(before))).toEqual(["snapshot"]);
    expect(snapshots()[3]!.frameId).toBe(newest);
  });

  it("delivers a held runtime Inspector edit result right after the pose that shows the edit", async () => {
    const { deliver, posts, runFrames, kinds, snapshots } = await bootWorker({
      type: "load", sceneAssetGuid: "main", sessionGeneration: 4, sessionMode: "simulate",
      scene: { ...createDefaultScene(), actors: [createActor("hero", "Hero", { classId: "Hero" })] },
    }, [{ type: "loadScripts", scripts: [{ classId: "Hero", assetGuid: "hero-class", parentClassId: "Actor", source: "", anchors: [],
      entryPoints: [], variables: [{ name: "health", type: "float", defaultValue: 10 }] }] }]);
    const inspect = async (requestId: number, action: RuntimeInspectorAction) => {
      deliver({ channel: "control", payload: { type: "runtimeInspector", sessionGeneration: 4, requestId, action } });
      await vi.waitFor(() => expect(posts.some((post) => post.kind === "command" &&
        post.command.type === "runtimeInspectorResult" && post.command.requestId === requestId)).toBe(true));
    };
    runFrames(8);
    expect(snapshots()).toHaveLength(2);
    await inspect(1, { kind: "identities" });
    const identities = posts.flatMap((post) => post.kind === "command" && post.command.type === "runtimeInspectorResult" &&
      post.command.payload?.kind === "identities" ? post.command.payload.rows : []);
    const hero = identities.find((row) => row.kind === "actor")!.identity;

    deliver({ channel: "control", payload: { type: "runtimeInspector", sessionGeneration: 4, requestId: 2,
      action: { kind: "setProperty", target: hero, sequence: 1, property: "health", value: 42 } } });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    // Both transfers are still outstanding, so the reply waits rather than
    // letting a paused host redraw an older pose.
    expect(posts.some((post) => post.kind === "command" && post.command.type === "runtimeInspectorResult" &&
      post.command.requestId === 2)).toBe(false);

    const before = posts.length;
    deliver({ channel: "recycleSnapshot", payload: snapshots()[0]!.buffer });
    const released = posts.slice(before);
    expect(kinds(released)).toEqual(["snapshot", "runtimeInspectorResult"]);
    expect(released[1]).toMatchObject({ command: { requestId: 2, success: true, payload: { kind: "mutation", effectiveValue: 42 } } });
  });
});
