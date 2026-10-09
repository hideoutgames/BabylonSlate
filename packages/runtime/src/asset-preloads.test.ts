import { expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import { RuntimeAssetPreloads } from "./asset-preloads";

it("deduplicates automatic preparation per owner and retries failed work after releasing ownership", async () => {
  const commands: CommandMessage[] = [];
  const manager = new RuntimeAssetPreloads(command => commands.push(command));
  const first = manager.prepare(["tree"], "actor");
  const shared = manager.prepare(["tree", "tree"], "actor");
  const request = commands[0];
  if (request?.type !== "assetPreload") throw new Error("Expected asset request");
  expect(commands).toHaveLength(1);
  manager.receive({ preloadId: request.preloadId, success: true });
  await Promise.all([first, shared]);
  await manager.prepare(["tree"], "actor");
  expect(commands).toHaveLength(1);
  manager.releaseOwner("actor");
  const retry = manager.prepare(["tree"], "actor");
  const rejected = expect(retry).rejects.toThrow("Asset tree, requested by actor: Missing tree");
  const second = commands.at(-1);
  if (second?.type !== "assetPreload") throw new Error("Expected asset request");
  manager.receive({ preloadId: second.preloadId, success: false, error: "Missing tree" });
  await rejected;
  const recovered = manager.prepare(["tree"], "actor");
  const third = commands.at(-1);
  if (third?.type !== "assetPreload") throw new Error("Expected asset request");
  expect(third.preloadId).not.toBe(second.preloadId);
  manager.receive({ preloadId: third.preloadId, success: true });
  await recovered;
  manager.dispose();
});

it("submits automatic multi-asset preparation transactionally instead of retaining partial roots", async () => {
  const commands: CommandMessage[] = [];
  const manager = new RuntimeAssetPreloads(command => commands.push(command));
  const operation = manager.prepare(["tree", "definition"], "reader");
  const rejected = expect(operation).rejects.toThrow("Missing definition");
  expect(commands).toHaveLength(1);
  const request = commands[0];
  if (request?.type !== "assetPreload") throw new Error("Expected asset request");
  expect(request.assetGuids).toEqual(["definition", "tree"]);
  manager.receive({ preloadId: request.preloadId, success: false, error: "Missing definition" });
  await rejected;
  expect(commands.at(-1)).toEqual({ type: "assetPreloadRelease", preloadId: request.preloadId });
});

it("keeps preload ownership until explicit release and waits for usable-resource acknowledgement", async () => {
  const commands: CommandMessage[] = [];
  const manager = new RuntimeAssetPreloads(command => commands.push(command));
  let settled = false;
  const operation = manager.acquire(["mesh", "mesh", "texture"], "actor").then(result => { settled = true; return result; });
  const request = commands[0];
  if (request?.type !== "assetPreload") throw new Error("Expected asset request");
  expect(request.assetGuids).toEqual(["mesh", "texture"]);
  manager.receive({ preloadId: request.preloadId, success: true, progress: 0.6 });
  await Promise.resolve();
  expect(settled).toBe(false);
  manager.setStates([{ guid: "mesh", state: "loading" }]);
  expect(manager.getState("mesh")).toBe("loading");
  manager.receive({ preloadId: request.preloadId, success: true, progress: 1 });
  expect(await operation).toMatchObject({ success: true, preloadId: request.preloadId });
  expect(commands.filter(command => command.type === "assetPreloadRelease")).toHaveLength(0);
  manager.setStates([{ guid: "mesh", state: "ready" }]);
  manager.release(request.preloadId);
  expect(manager.getState("mesh")).toBe("ready"); // Main still owns readiness while another consumer retains it.
  expect(commands.at(-1)).toEqual({ type: "assetPreloadRelease", preloadId: request.preloadId });
});

it("cancels only the requested candidate source scope and ignores late readiness", async () => {
  const commands: CommandMessage[] = [];
  const manager = new RuntimeAssetPreloads(command => commands.push(command));
  const abort = new AbortController();
  const candidate = manager.acquire(["new"], "component", {}, abort.signal);
  const predecessor = manager.acquire(["old"], "component");
  const requests = commands.filter(command => command.type === "assetPreload");
  abort.abort();
  expect(await candidate).toMatchObject({ success: false });
  manager.receive({ preloadId: requests[0]!.preloadId, success: true });
  expect(commands.filter(command => command.type === "assetPreloadRelease")).toEqual([
    { type: "assetPreloadRelease", preloadId: requests[0]!.preloadId },
  ]);
  manager.receive({ preloadId: requests[1]!.preloadId, success: true });
  expect(await predecessor).toMatchObject({ success: true });
  manager.dispose();
});

it("cancels destroyed owners, ignores late completions, and retains session-wide preloads until stop", async () => {
  const commands: CommandMessage[] = [];
  const manager = new RuntimeAssetPreloads(command => commands.push(command));
  const owner = manager.acquire(["sound"], "actor");
  const session = manager.acquire(["font"], "actor", { sessionWide: true });
  const requests = commands.filter(command => command.type === "assetPreload");
  manager.releaseOwner("actor");
  expect(await owner).toMatchObject({ success: false, errorMessage: "Asset preload cancelled for actor" });
  manager.receive({ preloadId: requests[0]!.preloadId, success: true });
  expect(commands.filter(command => command.type === "assetPreloadRelease")).toHaveLength(1);
  manager.dispose();
  expect(await session).toMatchObject({ success: false });
  expect(commands.filter(command => command.type === "assetPreloadRelease")).toHaveLength(2);
  const newer = new RuntimeAssetPreloads(command => commands.push(command));
  const retry = newer.acquire(["sound"], "actor");
  const newRequest = commands.at(-1);
  if (newRequest?.type !== "assetPreload") throw new Error("Expected asset request");
  expect(newRequest.preloadId).not.toBe(requests[0]!.preloadId);
  newer.receive({ preloadId: newRequest.preloadId, success: false, error: "Missing sound" });
  expect(await retry).toMatchObject({ success: false, errorMessage: "Missing sound" });
  expect(commands.at(-1)).toEqual({ type: "assetPreloadRelease", preloadId: newRequest.preloadId });
});

function handleSetup() {
  const commands: CommandMessage[] = [];
  const manager = new RuntimeAssetPreloads(command => commands.push(command));
  const releases = () => commands.flatMap(command => command.type === "assetPreloadRelease" ? [command.preloadId] : []);
  return { commands, manager, releases };
}

it("tracks a script handle from Loading with monotonic progress to Loaded and settles its waiters", async () => {
  const { commands, manager, releases } = handleSetup();
  const handle = manager.request(["mesh", "mesh", "texture"], "actor", { priority: "High" });
  expect(commands).toEqual([{ type: "assetPreload", preloadId: handle, ownerId: "actor", assetGuids: ["mesh", "texture"], priority: "gameplay" }]);
  expect(manager.handleState(handle)).toBe("Loading");
  expect(manager.handleProgress(handle)).toBe(0);
  let settled: unknown;
  const waiting = manager.wait(handle).then(result => { settled = result; return result; });
  manager.receive({ preloadId: handle, success: true, progress: 0.6 });
  manager.receive({ preloadId: handle, success: true, progress: 0.3 });
  expect(manager.handleProgress(handle)).toBe(0.6);
  await Promise.resolve();
  expect(settled).toBeUndefined();
  expect(manager.handleState(handle)).toBe("Loading");
  manager.receive({ preloadId: handle, success: true, progress: 1 });
  expect(await waiting).toEqual({ preloadId: handle, success: true, progress: 1, errorMessage: "" });
  expect(manager.handleState(handle)).toBe("Loaded");
  expect(manager.handleProgress(handle)).toBe(1);
  expect(await manager.wait(handle)).toMatchObject({ success: true, progress: 1 });
  expect(releases()).toEqual([]);
});

it.each([
  ["High", "gameplay"], ["Normal", "preload"], ["Low", "background"], [undefined, "preload"],
] as const)("asks the host for %s priority loads as %s", (priority, scheduled) => {
  const { commands, manager } = handleSetup();
  manager.request(["texture"], "actor", { priority });
  expect(commands[0]).toMatchObject({ type: "assetPreload", priority: scheduled });
});

it("keeps a failed handle's error and progress queryable and releases its host ownership once", async () => {
  const { manager, releases } = handleSetup();
  const handle = manager.request(["tree"], "actor");
  manager.receive({ preloadId: handle, success: true, progress: 0.5 });
  manager.receive({ preloadId: handle, success: false, error: "Missing tree" });
  expect(manager.handleState(handle)).toBe("Failed");
  expect(manager.handleProgress(handle)).toBe(0.5);
  expect(await manager.wait(handle)).toEqual({ preloadId: handle, success: false, progress: 0.5, errorMessage: "Missing tree" });
  expect(releases()).toEqual([handle]);
  manager.releaseHandle(handle);
  expect(manager.handleState(handle)).toBe("Released");
  expect(releases()).toEqual([handle]);
});

it("fails a pending wait when its handle is released and ignores the host's late answer", async () => {
  const { manager, releases } = handleSetup();
  const handle = manager.request(["tree"], "actor");
  const waiting = manager.wait(handle);
  manager.releaseHandle(handle);
  expect(await waiting).toMatchObject({ success: false, errorMessage: "Asset preload cancelled for actor" });
  manager.receive({ preloadId: handle, success: true });
  expect(manager.handleState(handle)).toBe("Released");
  expect(releases()).toEqual([handle]);
  expect(await manager.wait(handle)).toMatchObject({ success: false, errorMessage: `Load handle ${handle} was released or does not exist` });
});

it("treats unknown handles and consumers' own loads as released handles that scripts cannot free", async () => {
  const { commands, manager, releases } = handleSetup();
  expect(manager.handleState("never")).toBe("Released");
  expect(manager.handleProgress("never")).toBe(0);
  expect(await manager.wait("never")).toMatchObject({ success: false, errorMessage: "Load handle never was released or does not exist" });
  expect(await manager.wait("")).toMatchObject({ success: false, errorMessage: "Load handle was released or does not exist" });
  void manager.acquire(["font"], "actor");
  const consumer = commands[0];
  if (consumer?.type !== "assetPreload") throw new Error("Expected asset request");
  expect(manager.handleState(consumer.preloadId)).toBe("Released");
  manager.releaseHandle(consumer.preloadId);
  expect(releases()).toEqual([]);
  manager.dispose();
});

it("unloads only the calling owner's handles that include the asset, whole, and never a consumer's load", () => {
  const { manager, releases } = handleSetup();
  const mine = manager.request(["tree", "rock"], "actor");
  const rockOnly = manager.request(["rock"], "actor");
  const other = manager.request(["tree"], "enemy");
  const session = manager.request(["tree"], "actor", { sessionWide: true });
  void manager.acquire(["tree"], "actor");
  manager.unload("tree", "actor");
  expect(manager.handleState(mine)).toBe("Released");
  expect([rockOnly, other, session].map(handle => manager.handleState(handle))).toEqual(["Loading", "Loading", "Loading"]);
  expect(releases()).toEqual([mine]);
  manager.unload("tree", "session");
  expect(manager.handleState(session)).toBe("Released");
  expect(releases()).toEqual([mine, session]);
});

it("releases an owner's handles with it, keeps session-wide handles until stop, then refuses new ones", async () => {
  const { manager } = handleSetup();
  const owned = manager.request(["tree"], "actor");
  const session = manager.request(["font"], "actor", { sessionWide: true });
  const sessionWait = manager.wait(session);
  manager.releaseOwner("actor");
  expect(manager.handleState(owned)).toBe("Released");
  expect(manager.handleState(session)).toBe("Loading");
  manager.dispose();
  expect(await sessionWait).toMatchObject({ success: false });
  expect(manager.handleState(session)).toBe("Released");
  expect(manager.request(["tree"], "actor")).toBe("");
});

it("completes a request with nothing to load at once and fails one the host cannot attempt without contacting it", async () => {
  const { commands, manager } = handleSetup();
  const empty = manager.request([" ", ""], "actor");
  expect(manager.handleState(empty)).toBe("Loaded");
  expect(manager.handleProgress(empty)).toBe(1);
  const failed = manager.requestFailed("actor", "Class Boss is missing from the asset catalog");
  expect(manager.handleState(failed)).toBe("Failed");
  expect(await manager.wait(failed)).toMatchObject({ success: false, errorMessage: "Class Boss is missing from the asset catalog" });
  expect(commands).toEqual([]);
});
