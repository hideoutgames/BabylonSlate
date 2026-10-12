import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene, createDefaultSceneLayer, type SaveGameStorage } from "@babylonslate/core";
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
  it("keeps advancing after a frame throws", () => {
    const harness = createHost(withAnimationFrame);
    const advance = vi.fn().mockImplementationOnce(() => { throw new Error("tick failed"); });
    const scheduler = createWorkerScheduler(harness.host, advance);
    scheduler.start();
    expect(() => harness.runNext(16)).toThrow("tick failed");
    expect(harness.activeCount()).toBe(1);
    harness.runNext(20);
    expect(advance.mock.calls).toEqual([[0], [0.02]]);
    scheduler.stop();
  });
});

describe("worker entry snapshot transport", () => {
  type Post =
    | { kind: "snapshot"; frameId: number; buffer: ArrayBuffer }
    /** `batch` numbers the worker message the command arrived in. */
    | { kind: "command"; command: CommandMessage; batch: number };
  let send: ((control: ControlMessage) => void) | undefined;
  afterEach(async () => {
    send?.({ type: "stop" });
    send = undefined;
    // The stopped worker reports it a task later; let that land before the stubs go.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  /** Boot the real worker entry against a host that recycles only when told to. */
  async function bootWorker(load: Extract<ControlMessage, { type: "load" }>, before: ControlMessage[] = [], beforeImport?: () => Promise<void>) {
    vi.resetModules();
    await beforeImport?.();
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
    let batch = 0;
    vi.stubGlobal("postMessage", (message: BridgeWorkerMessage) => {
      if (message.channel === "snapshot") {
        const frameId = readSnapshotHeader(new Float32Array(message.payload)).frameId;
        posts.push({ kind: "snapshot", frameId, buffer: message.payload });
        return;
      }
      batch++;
      for (const command of message.channel === "commands" ? message.payload : [message.payload]) {
        posts.push({ kind: "command", command, batch });
        // Like the real hosts, acknowledge a layout change on a later task.
        if (command.type === "snapshotLayout") {
          queueMicrotask(() => deliver({ channel: "snapshotLayoutAck", generation: command.generation }));
        }
      }
    });
    const emitted: CommandMessage[] = [];
    let runtime!: RuntimeDriver;
    let saveStorage!: SaveGameStorage;
    const hud = { ...createDefaultSceneLayer(), actors: [createActor("badge", "Badge", { classId: "SceneLayerActor" })] };
    vi.mocked(createRuntimeFromLoad).mockImplementation((control, onCommand, storage) => {
      saveStorage = storage!;
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
      deliver, posts, emitted, runtime, saveStorage: () => saveStorage,
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

  it("sends a tick's commands as one batch in emission order, ahead of that tick's pose", async () => {
    const { deliver, posts, runtime, runFrames, snapshots } = await bootWorker(
      { type: "load", sceneAssetGuid: "main", scene: { ...createDefaultScene(), actors: [createActor("prop", "Prop")] } });
    runFrames(8);
    for (const pose of snapshots()) deliver({ channel: "recycleSnapshot", payload: pose.buffer });
    const advance = runtime.advance.bind(runtime);
    vi.spyOn(runtime, "advance").mockImplementation((elapsed) => {
      advance(elapsed);
      runtime.reportLog("first");
      runtime.reportLog("second");
    });

    const before = posts.length;
    runFrames(1);
    const frame = posts.slice(before);
    const poseAt = frame.findIndex((post) => post.kind === "snapshot");
    expect(poseAt).toBeGreaterThan(1);
    const commands = frame.slice(0, poseAt).flatMap((post) => post.kind === "command" ? [post] : []);
    const logs = commands.filter((post) => post.command.type === "log");
    expect(logs.map((post) => post.command.type === "log" && post.command.message)).toEqual(["first", "second"]);
    expect(new Set(commands.map((post) => post.batch)).size).toBe(1);
  });

  it("flushes queued commands before the pose that releases a held reply, which then follows the pose alone", async () => {
    const { deliver, posts, runtime, runFrames, kinds, snapshots } = await bootWorker({
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
    await inspect(1, { kind: "identities" });
    const hero = posts.flatMap((post) => post.kind === "command" && post.command.type === "runtimeInspectorResult" &&
      post.command.payload?.kind === "identities" ? post.command.payload.rows : []).find((row) => row.kind === "actor")!.identity;
    deliver({ channel: "control", payload: { type: "runtimeInspector", sessionGeneration: 4, requestId: 2,
      action: { kind: "setProperty", target: hero, sequence: 1, property: "health", value: 42 } } });
    for (let i = 0; i < 12; i++) await Promise.resolve();

    // The reply is held for the next pose; a log emitted now is still queued when the buffer returns.
    const before = posts.length;
    runtime.reportLog("before the pose");
    deliver({ channel: "recycleSnapshot", payload: snapshots()[0]!.buffer });
    const released = posts.slice(before);
    expect(kinds(released)).toEqual(["log", "snapshot", "runtimeInspectorResult"]);
    const [log, , reply] = released;
    if (log?.kind !== "command" || reply?.kind !== "command") throw new Error("unexpected posts");
    expect(reply.batch).not.toBe(log.batch);
  });

  it("pauses again after a single step whose tick throws", async () => {
    const { runtime, runFrames } = await bootWorker({ type: "load", sceneAssetGuid: "main", scene: { ...createDefaultScene(), actors: [createActor("prop", "Prop")] } });
    send!({ type: "setPaused", paused: true });
    const tickIndex = runtime.getWorld().clock.tickIndex;
    vi.spyOn(runtime, "tick").mockImplementationOnce(() => { throw new Error("tick failed"); });
    expect(() => send!({ type: "step" })).toThrow("tick failed");
    runFrames(3);
    expect(runtime.getWorld().clock.tickIndex).toBe(tickIndex);
  });

  it("reports the stop only after the host answers the save writes still in flight", async () => {
    const { deliver, posts, saveStorage } = await bootWorker({ type: "load", sceneAssetGuid: "main", scene: createDefaultScene() });
    const commands = () => posts.flatMap((post) => post.kind === "command" ? [post.command] : []);
    // An End Play save write the host has not answered yet.
    const written = saveStorage().write("slot", "end of play");
    // A write made outside any handler or tick is flushed at the end of the current task's microtasks.
    await Promise.resolve();
    const request = commands().find((command) => command.type === "saveStorageRequest");
    if (request?.type !== "saveStorageRequest") throw new Error("No save request");
    send!({ type: "stop" });
    send = undefined;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(commands().some((command) => command.type === "runtimeStopped")).toBe(false);
    deliver({ channel: "control", payload: { type: "saveStorageResponse", response: { id: request.request.id } } });
    await written;
    await vi.waitFor(() => expect(commands().some((command) => command.type === "runtimeStopped")).toBe(true));
  });

  it("ends a final capture with a failed result when stop supersedes it between chunks", async () => {
    const { deliver, posts, runFrames, kinds } = await bootWorker({ type: "load", sceneAssetGuid: "main", sessionGeneration: 4, sessionMode: "simulate",
      scene: { ...createDefaultScene(), actors: Array.from({ length: 120 }, (_, index) => createActor(`prop-${index}`, "Prop")) } });
    for (let i = 0; i < 100 && !kinds().includes("sceneRealized"); i++) {
      runFrames(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const commands = () => posts.flatMap((post) => post.kind === "command" ? [post.command] : []);
    deliver({ channel: "control", payload: { type: "quiesceSimulation", sessionGeneration: 4, requestId: 1 } });
    await vi.waitFor(() => expect(commands().some((command) => command.type === "simulationQuiesced")).toBe(true));
    const boundary = commands().find((command) => command.type === "simulationQuiesced");
    if (boundary?.type !== "simulationQuiesced" || !boundary.success) throw new Error("Simulation did not quiesce");
    deliver({ channel: "control", payload: { type: "captureSimulationState", sessionGeneration: 4, requestId: 2,
      renderRevision: boundary.commandRevision } });
    // The worker yields one task per chunk; stop right after the first one.
    const chunks = () => commands().filter((command) => command.type === "simulationCaptureChunk").length;
    for (let i = 0; i < 100 && chunks() === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chunks()).toBeGreaterThan(0);
    send!({ type: "stop" });
    await vi.waitFor(() => expect(commands().some((command) => command.type === "simulationCaptureResult")).toBe(true));
    const result = commands().find((command) => command.type === "simulationCaptureResult");
    expect(result).toMatchObject({ sessionGeneration: 4, requestId: 2, result: { ok: false } });
  });

  it("retries a layout whose transfer buffers failed to allocate, then resumes poses at the new capacity", async () => {
    let failures = 0;
    let restoreGrow = () => {};
    try {
      const { posts, emitted, runFrames, kinds } = await bootWorker({ type: "load", sceneAssetGuid: "main",
        scene: { ...createDefaultScene(), actors: Array.from({ length: 300 }, (_, index) => createActor(`prop-${index}`, "Prop")) } }, [], async () => {
        // The worker module's own bridge instance, loaded after the module reset.
        const { TransferablePingPong } = await import("@babylonslate/bridge");
        const grow = TransferablePingPong.prototype.grow;
        const spy = vi.spyOn(TransferablePingPong.prototype, "grow").mockImplementation(function (this: InstanceType<typeof TransferablePingPong>, capacity: number) {
          if (capacity > this.maxActors && failures++ < 2) throw new RangeError("Array buffer allocation failed");
          return grow.call(this, capacity);
        });
        restoreGrow = () => spy.mockRestore();
      });
      const settleFrame = async () => {
        runFrames(1);
        await new Promise((resolve) => setTimeout(resolve, 0));
      };
      for (let i = 0; i < 100 && !kinds().includes("snapshotLayout"); i++) await settleFrame();
      // Both failed allocations were retried; only the first was reported.
      expect(failures).toBe(3);
      expect(emitted.filter((command) => command.type === "diagnostic" &&
        command.message.includes("Unable to allocate transferable Actor snapshots"))).toHaveLength(1);
      const layoutAt = kinds().indexOf("snapshotLayout");
      const layout = posts[layoutAt]!;
      if (layout.kind !== "command" || layout.command.type !== "snapshotLayout") throw new Error("missing layout");
      // Realization may still be spawning when the layout lands; poses resume once it finishes.
      const resumed = () => posts.slice(layoutAt).flatMap((post) => post.kind === "snapshot" ? [post] : []);
      for (let i = 0; i < 100 && resumed().length === 0; i++) await settleFrame();
      expect(resumed().length).toBeGreaterThan(0);
      expect(resumed()[0]!.buffer.byteLength).toBe(snapshotFloatCount(layout.command.capacity) * 4);
    } finally {
      restoreGrow();
    }
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
