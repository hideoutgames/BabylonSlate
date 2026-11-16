import { describe, expect, it } from "vitest";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper";
import type { FrameGraphTextureHandle } from "@babylonjs/core/FrameGraph/frameGraphTypes";
import {
  discardPresentedSamples, discardsSamples, installSampleDiscard, lastSampleWriters, markLastSampleWriters, setDiscardSamples,
  type SampleWriterPass, type SampleWriterTask,
} from "./sample-discard";

const GL = { FRAMEBUFFER: 0x8d40, READ_FRAMEBUFFER: 0x8ca8, COLOR_ATTACHMENT0: 0x8ce0, DEPTH_ATTACHMENT: 0x8d00, STENCIL_ATTACHMENT: 0x8d20 };

const COLOR = 1 as FrameGraphTextureHandle, DEPTH = 2 as FrameGraphTextureHandle, SINGLE = 3 as FrameGraphTextureHandle;
const multisampled = (handle: FrameGraphTextureHandle) => handle === COLOR || handle === DEPTH;

/** A render pass drawing into `colors` and `depth`, with its own render target. */
function pass(name: string, colors: FrameGraphTextureHandle[], depth?: FrameGraphTextureHandle) {
  const target = { name, _MSAAFramebuffer: { name } as unknown as WebGLFramebuffer, resolveMSAAColors: true } as unknown as RenderTargetWrapper & { resolveMSAAColors: boolean };
  return {
    setRenderTarget: () => {}, renderTarget: colors.length === 1 ? colors[0] : colors, renderTargetDepth: depth,
    frameGraphRenderTarget: { renderTargetWrapper: target },
  } satisfies SampleWriterPass;
}
const task = (passes: SampleWriterPass[], passesDisabled: SampleWriterPass[] = []): SampleWriterTask => ({ passes, passesDisabled });

/** An Engine whose multisampled resolve is recorded, with a context that records invalidations. */
function engine() {
  const calls: string[] = [];
  const gl = {
    ...GL,
    invalidateFramebuffer: (target: number, attachments: number[]) => calls.push(`invalidate ${target} ${attachments.join(",")}`),
  };
  const handle = {
    _gl: gl,
    resolveMultiFramebuffer(texture: { name: string }) { calls.push(`resolve ${texture.name}`); },
  };
  return { engine: handle as unknown as AbstractEngine, gl: gl as unknown as WebGL2RenderingContext, calls };
}

describe("Discarding multisampled samples after their last resolve", () => {
  // The scene's frame: a clear, the objects, water's transparent pass drawing into the same samples again, a copy
  // into a single-sample target, and a disabled task's pass that might draw into the depth.
  const clear = pass("clear", [COLOR], DEPTH);
  const objects = pass("objects", [COLOR], DEPTH);
  const transparent = pass("transparent", [COLOR]);
  const copy = pass("copy", [SINGLE]);
  const fallback = pass("fallback", [SINGLE], DEPTH);

  it("chooses, per multisampled texture, the pass that draws into it last, a disabled pass counting as one that might", () => {
    expect(lastSampleWriters([task([clear]), task([objects]), task([transparent]), task([copy])], multisampled))
      .toEqual(new Map([[transparent, { colors: [0], depth: false }], [objects, { colors: [], depth: true }]]));
    expect(lastSampleWriters([task([clear]), task([objects]), task([copy], [fallback])], multisampled))
      .toEqual(new Map([[objects, { colors: [0], depth: false }], [fallback, { colors: [], depth: true }]]));
    // A pass that draws into no multisampled texture discards nothing; a non-render pass is no writer.
    expect(lastSampleWriters([task([copy, {} as SampleWriterPass])], multisampled)).toEqual(new Map());
  });

  it("invalidates, while on, only what the last writer's resolve leaves unread, and nothing once off again", () => {
    const { engine: host, calls } = engine();
    installSampleDiscard(host);
    installSampleDiscard(host);
    markLastSampleWriters([task([clear]), task([objects]), task([transparent])], multisampled);
    const resolve = (target: SampleWriterPass) =>
      (host as unknown as { resolveMultiFramebuffer(texture: unknown): void }).resolveMultiFramebuffer(target.frameGraphRenderTarget!.renderTargetWrapper);
    expect(discardsSamples(host)).toBe(false);
    resolve(objects);
    expect(calls.splice(0)).toEqual(["resolve objects"]);
    expect([setDiscardSamples(host, true), setDiscardSamples(host, true)]).toEqual([true, false]);
    // The clear's samples are drawn on; the objects' colour is reloaded by the transparent pass, which discards it.
    for (const target of [clear, objects, transparent]) resolve(target);
    expect(calls.splice(0)).toEqual([
      "resolve clear",
      "resolve objects", `invalidate ${GL.FRAMEBUFFER} ${GL.DEPTH_ATTACHMENT}`,
      "resolve transparent", `invalidate ${GL.FRAMEBUFFER} ${GL.COLOR_ATTACHMENT0}`,
    ]);
    // A colour left unresolved for the multisampled present blit keeps its samples until that blit.
    (transparent.frameGraphRenderTarget.renderTargetWrapper as unknown as { resolveMSAAColors: boolean }).resolveMSAAColors = false;
    resolve(transparent);
    expect(calls.splice(0)).toEqual(["resolve transparent"]);
    expect(setDiscardSamples(host, false)).toBe(true);
    for (const target of [clear, objects, transparent]) resolve(target);
    expect(calls.splice(0)).toEqual(["resolve clear", "resolve objects", "resolve transparent"]);
  });

  it("discards the presented colour after the multisampled present blit only while on", () => {
    const { engine: host, gl, calls } = engine();
    discardPresentedSamples(host, gl);
    setDiscardSamples(host, true);
    discardPresentedSamples(host, gl);
    expect(calls).toEqual([`invalidate ${GL.READ_FRAMEBUFFER} ${GL.COLOR_ATTACHMENT0}`]);
  });
});
