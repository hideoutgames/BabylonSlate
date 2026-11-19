import { afterEach, expect, it, vi } from "vitest";
import { Constants } from "@babylonjs/core/Engines/constants";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphBloomTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/bloomTask";
import { FrameGraphPassTask } from "@babylonjs/core/FrameGraph/Tasks/PostProcesses/passTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { backbufferColorTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { fragmentDiscards, fullTargetClear, startFullScreenPassesWithClear } from "./full-target-clear";

const dispose: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dispose.length) dispose.pop()!();
});

/**
 * A source texture, a pass task drawing it into a target of its own, then bloom over that, then the backbuffer copy; or,
 * `intoBackbuffer`, the pass alone drawing into the backbuffer, as a chain's last stage does.
 */
function host(intoBackbuffer = false) {
  const engine = adaptNullEngineFrameGraph(new NullEngine());
  const scene = new Scene(engine);
  const source = RawTexture.CreateRGBATexture(new Uint8Array(4 * 4 * 4), 4, 4, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
  source.getInternalTexture()!.isReady = true;
  const graph = new FrameGraph(scene);
  const sourceTexture = graph.textureManager.importTexture("Source", source.getInternalTexture()!);
  const pass = new FrameGraphPassTask("Pass", graph);
  pass.sourceTexture = sourceTexture;
  pass.depthTest = false;
  if (intoBackbuffer) pass.targetTexture = backbufferColorTextureHandle;
  graph.addTask(pass);
  const bloom = new FrameGraphBloomTask("Bloom", graph);
  bloom.sourceTexture = pass.outputTexture;
  const present = new FrameGraphCopyToBackbufferColorTask("Present", graph);
  present.sourceTexture = bloom.outputTexture;
  if (!intoBackbuffer) {
    graph.addTask(bloom);
    graph.addTask(present);
  }
  dispose.push(() => {
    graph.dispose();
    source.dispose();
    scene.dispose();
    engine.dispose();
  });
  // What the frame does, in order: the full-target clears (by their colour) and the draws.
  const events: string[] = [];
  const clear = engine.clear.bind(engine);
  vi.spyOn(engine, "clear").mockImplementation((...args: Parameters<typeof engine.clear>) => {
    const [color, backBuffer, depth] = args;
    events.push(`clear ${engine._currentRenderTarget ? "target" : "backbuffer"} ${color && backBuffer ? "colour" : ""}${depth ? " depth" : ""}`);
    clear(...args);
  });
  const draw = engine.drawElementsType.bind(engine);
  vi.spyOn(engine, "drawElementsType").mockImplementation((...args: Parameters<typeof engine.drawElementsType>) => {
    events.push(`draw ${engine._currentRenderTarget ? "target" : "backbuffer"}`);
    draw(...args);
  });
  return { engine, graph, pass, bloom, present, events };
}

it("starts every full-screen pass, the backbuffer copy's included, with a clear of its colour before its draw", async () => {
  const { graph, events } = host();
  await graph.buildAsync();
  startFullScreenPassesWithClear(graph.tasks);
  graph.execute();
  // The pass, bloom's downscale, blurs and merge, then the copy into the backbuffer: each clears its colour, then draws.
  expect(events).toEqual([
    ...Array.from({ length: 5 }, () => ["clear target colour", "draw target"]).flat(),
    "clear backbuffer colour", "draw backbuffer",
  ]);
});

it("clears nothing before a draw that would leave part of its target as it was", async () => {
  const { graph, pass, bloom, events } = host();
  await graph.buildAsync();
  startFullScreenPassesWithClear(graph.tasks);
  // Blending onto the target, a partial viewport, colour writes off, a stencil test.
  pass.alphaMode = Constants.ALPHA_ADD;
  bloom.alphaMode = Constants.ALPHA_COMBINE;
  graph.execute();
  expect(events.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => "draw target"));
  for (const change of [
    () => { pass.viewport = { x: 0, y: 0, width: 0.5, height: 1 }; },
    () => { pass.disableColorWrite = true; },
    () => { pass.stencilState = { enabled: true } as typeof pass.stencilState; },
  ]) {
    pass.alphaMode = Constants.ALPHA_DISABLE;
    pass.viewport = undefined;
    pass.disableColorWrite = false;
    pass.stencilState = undefined;
    change();
    events.length = 0;
    graph.execute();
    expect(events[0]).toBe("draw target");
  }
});

it("clears nothing while the effect is not ready: the draw draws nothing and the target keeps its content", async () => {
  const { graph, pass, events } = host();
  await graph.buildAsync();
  startFullScreenPassesWithClear(graph.tasks);
  vi.spyOn(pass.drawWrapper.effect!, "isReady").mockReturnValue(false);
  graph.execute();
  // Only bloom's four passes clear and draw into targets.
  expect(events.filter((event) => event === "clear target colour")).toHaveLength(4);
  expect(events.filter((event) => event === "draw target")).toHaveLength(4);
});

it("tests depth only where the target has no depth buffer, so a depth-tested draw into the backbuffer clears nothing", async () => {
  const { graph, pass, events } = host(true);
  pass.depthTest = true;
  await graph.buildAsync();
  startFullScreenPassesWithClear(graph.tasks);
  graph.execute();
  expect(events).toEqual(["draw backbuffer"]);
  pass.depthTest = false;
  events.length = 0;
  graph.execute();
  expect(events).toEqual(["clear backbuffer colour", "draw backbuffer"]);
});

it("starts a pass with one clear however often the passes are wrapped, and the passes of a rebuild too", async () => {
  const { graph, events } = host();
  await graph.buildAsync();
  startFullScreenPassesWithClear(graph.tasks);
  startFullScreenPassesWithClear(graph.tasks);
  graph.execute();
  expect(events.filter((event) => event.startsWith("clear"))).toHaveLength(6);
  await graph.buildAsync();
  startFullScreenPassesWithClear(graph.tasks);
  events.length = 0;
  graph.execute();
  expect(events.filter((event) => event.startsWith("clear"))).toHaveLength(6);
});

it("puts the load back when the clear is replaced, as a reference run does", async () => {
  const { graph, events } = host();
  await graph.buildAsync();
  startFullScreenPassesWithClear(graph.tasks);
  const clear = fullTargetClear.clear;
  fullTargetClear.clear = () => {};
  try { graph.execute(); } finally { fullTargetClear.clear = clear; }
  expect(events.some((event) => event.startsWith("clear"))).toBe(false);
});

it("reads a fragment shader that may discard, and an unprocessed one, as one that may", () => {
  const effect = (source?: string) => ({ _fragmentSourceCode: source }) as unknown as Parameters<typeof fragmentDiscards>[0];
  expect(fragmentDiscards(effect("void main(void) { if (a < 0.5) discard; gl_FragColor = c; }"))).toBe(true);
  expect(fragmentDiscards(effect("void main(void) { gl_FragColor = vec4(discarded); }"))).toBe(false);
  expect(fragmentDiscards(effect(""))).toBe(true);
  expect(fragmentDiscards(null)).toBe(true);
});
