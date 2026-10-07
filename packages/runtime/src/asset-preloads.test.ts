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
  const progress: number[] = [];
  let settled = false;
  const operation = manager.acquire(["mesh", "mesh", "texture"], "actor", { onProgress: value => progress.push(value) }).then(result => { settled = true; return result; });
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
  expect(progress).toEqual([0, 0.6, 1]);
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
