import { expect, type Locator, type Page } from "@playwright/test";

/** A block-compressed WebGPU texture the page created (a KTX2 transcode target). */
export type CompressedTexture = { format: string; width: number; height: number };

/** WebGPU validation failures, including a block-compressed texture off the 4x4 grid. */
const GPU_FAILURE = /GPUValidationError|not a multiple of the block|Invalid CommandBuffer|GPU submission failed/;

/**
 * Init script: records every block-compressed WebGPU texture (the KTX2
 * transcode targets). A KTX2 decoded to RGBA, like a source PNG, uploads
 * rgba8 and is not listed.
 */
export function recordCompressedGpuTextures(): void {
  type Descriptor = { format: string; size: number[] | { width: number; height?: number } };
  const host = globalThis as {
    GPUDevice?: { prototype: { createTexture(descriptor: Descriptor): unknown } };
    __compressedGpuTextures?: CompressedTexture[];
  };
  const device = host.GPUDevice?.prototype;
  if (!device) return;
  const created: CompressedTexture[] = [];
  host.__compressedGpuTextures = created;
  const createTexture = device.createTexture;
  device.createTexture = function (this: unknown, descriptor: Descriptor) {
    if (/^(bc|astc|etc2|eac)/.test(descriptor.format)) {
      const size = descriptor.size;
      const [width = 1, height = 1] = Array.isArray(size) ? size : [size.width, size.height];
      created.push({ format: descriptor.format, width, height });
    }
    return createTexture.call(this, descriptor);
  };
}

/** What `recordCompressedGpuTextures` saw on this document; null without WebGPU. */
export async function compressedGpuTextures(page: Page): Promise<CompressedTexture[] | null> {
  return page.evaluate(
    () => (globalThis as { __compressedGpuTextures?: CompressedTexture[] }).__compressedGpuTextures ?? null,
  );
}

/** Recorded textures off the 4-texel grid: WebGPU rejects such a block-compressed upload. */
export function offBlockGrid(textures: readonly CompressedTexture[]): CompressedTexture[] {
  return textures.filter((texture) => texture.width % 4 !== 0 || texture.height % 4 !== 0);
}

/** GPU validation / block-size messages from the console and uncaught page errors. */
export function watchGpuFailures(page: Page): { gpuFailures: string[]; consoleProblems: string[] } {
  const gpuFailures: string[] = [];
  const consoleProblems: string[] = [];
  page.on("console", (message) => {
    const line = `[${message.type()}] ${message.text()}`;
    if (GPU_FAILURE.test(message.text())) gpuFailures.push(line.slice(0, 500));
    if (["error", "warning"].includes(message.type()) && consoleProblems.length < 50) consoleProblems.push(line.slice(0, 500));
  });
  page.on("pageerror", (error) => {
    if (GPU_FAILURE.test(error.message)) gpuFailures.push(`[pageerror] ${error.message}`);
  });
  return { gpuFailures, consoleProblems };
}

/** Particle colour of a solid fixture texture. */
export type Tone = "red" | "green";

export type PreviewSample = { matched: number; moved: number };

/** Pixels of the fixture `tone`, and pixels that change over 600 ms (p17's motion diff). */
export async function previewPixels(canvas: Locator, tone: Tone): Promise<PreviewSample> {
  return canvas.evaluate(async (node: HTMLCanvasElement, tone) => {
    const context = node.getContext("2d");
    if (!context) return { matched: 0, moved: 0 };
    const before = context.getImageData(0, 0, node.width, node.height).data;
    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = context.getImageData(0, 0, node.width, node.height).data;
    const channel = tone === "red" ? 0 : 1;
    let matched = 0;
    let moved = 0;
    for (let i = 0; i < Math.min(before.length, after.length); i += 4) {
      const others = [0, 1, 2].filter((c) => c !== channel).map((c) => after[i + c]!);
      if (after[i + channel]! > 150 && others.every((value) => value < 90)) matched += 1;
      if (Math.abs(before[i + channel]! - after[i + channel]!) > 32) moved += 1;
    }
    return { matched, moved };
  }, tone);
}

export type PreviewDraw = {
  retries: number;
  drawMs: number | null;
  firstDraw: PreviewSample;
  steady: PreviewSample;
};

export function previewDraw(): PreviewDraw {
  return { retries: 0, drawMs: null, firstDraw: { matched: 0, moved: 0 }, steady: { matched: 0, moved: 0 } };
}

/**
 * Waits until the Preview draws moving particles of `tone`, then samples a
 * later window into `run`. Software WebGPU preparation runs close to the
 * Preview's 4 s stall deadline (SCENE_SHADER_WARM_TIMEOUT_MS): a **Preview
 * Failed** that says it timed out is retried once through the product's
 * Retry; any other failure, or a second one, fails. `onDrawing` runs between
 * the two samples.
 */
export async function expectPreviewDraws(
  preview: Locator,
  canvas: Locator,
  tone: Tone,
  run: PreviewDraw,
  onDrawing?: () => void,
): Promise<void> {
  const failed = preview.getByTestId("particle-preview-failed");
  let startedAt = Date.now();
  await expect(preview.getByTestId("particle-preview-backend").or(failed)).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    if (await failed.isVisible()) {
      const reason = (await failed.textContent()) ?? "";
      if (run.retries > 0 || !/timed out/i.test(reason)) throw new Error(`Particle Preview failed: ${reason}`);
      run.retries += 1;
      await failed.getByRole("button", { name: "Retry" }).click();
      startedAt = Date.now();
    }
    run.firstDraw = await previewPixels(canvas, tone);
    expect(Math.min(run.firstDraw.matched, run.firstDraw.moved)).toBeGreaterThan(200);
  }).toPass({ timeout: 60_000 });
  run.drawMs = Date.now() - startedAt;
  onDrawing?.();
  // Later frames keep drawing and moving (an invalid command buffer drops every frame).
  run.steady = await previewPixels(canvas, tone);
}
