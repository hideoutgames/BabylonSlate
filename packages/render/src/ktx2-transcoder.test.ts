import { describe, expect, it, vi } from "vitest";
import {
  configureKtx2DecoderRuntime,
  configureKtx2Transcoder,
  ktx2TranscoderUrls,
  playerFilesHaveKtx2Transcoder,
  probeKtx2TranscoderAvailable,
  shouldPackKtx2ForPreviewBuild,
  textureBlockSizeMessage,
  webGpuKtx2BlockMisalignment,
} from "./ktx2-transcoder";
import { ktx2HeaderBytes } from "./texture-test-fixtures";

describe("ktx2 transcoder config", () => {
  it("builds self-hosted URLs under the public base", () => {
    const urls = ktx2TranscoderUrls("/ktx2/");
    expect(urls.jsDecoderModule).toBe("/ktx2/babylon.ktx2Decoder.js");
    expect(urls.wasmUASTCToASTC).toContain("uastc_astc.wasm");
    expect(urls.wasmUASTCToRGBAUnorm).toContain("uastc_rgba8_unorm_v2.wasm");
    expect(urls.jsMSCTranscoder).toContain("msc_basis_transcoder.js");
  });

  it("applies URLConfig without reaching for a CDN", () => {
    const mock = { URLConfig: {} as Record<string, string | null> };
    configureKtx2Transcoder(mock, "/assets/ktx2");
    expect(mock.URLConfig.jsDecoderModule).toBe(
      "/assets/ktx2/babylon.ktx2Decoder.js",
    );
    expect(Object.values(mock.URLConfig).join(" ")).not.toMatch(/cdn|http/i);
  });

  it("probes missing transcoder files as unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(
      probeKtx2TranscoderAvailable("/missing/", fetchImpl as unknown as typeof fetch),
    ).resolves.toBe(false);
  });

  it("probes present transcoder files as available", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(
      probeKtx2TranscoderAvailable("/ktx2/", fetchImpl as unknown as typeof fetch),
    ).resolves.toBe(true);
  });

  it("treats a missing wasm module as unavailable even when the JS decoder exists", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("babylon.ktx2Decoder.js") || url.endsWith("msc_basis_transcoder.js")) {
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    await expect(
      probeKtx2TranscoderAvailable("/ktx2/", fetchImpl as unknown as typeof fetch),
    ).resolves.toBe(false);
  });

  it("decodes packed player KTX2 on the main thread and uses RGBA without ASTC/BC7", () => {
    const decoderOptions = {
      forceRGBA: false,
      useRGBAIfASTCBC7NotAvailableWhenUASTC: false,
    };
    const mock = {
      DefaultNumWorkers: 4,
      DefaultDecoderOptions: decoderOptions,
    };
    configureKtx2DecoderRuntime(mock, {
      mainThread: true,
      caps: { astc: null, bptc: null },
    });
    expect(mock.DefaultNumWorkers).toBe(0);
    expect(decoderOptions.forceRGBA).toBe(true);
    expect(decoderOptions.useRGBAIfASTCBC7NotAvailableWhenUASTC).toBe(true);
  });

  it("returns KTX2 transcoding to worker threads after a main-thread configuration", () => {
    const mock = {
      DefaultNumWorkers: 4,
      DefaultDecoderOptions: { forceRGBA: false, useRGBAIfASTCBC7NotAvailableWhenUASTC: false },
    };
    configureKtx2DecoderRuntime(mock, { mainThread: true });
    expect(mock.DefaultNumWorkers).toBe(0);
    configureKtx2DecoderRuntime(mock, {});
    expect(mock.DefaultNumWorkers).toBe(4);
  });

  it("forces RGBA on SwiftShader even when ASTC caps are present", () => {
    const decoderOptions = {
      forceRGBA: false,
      useRGBAIfASTCBC7NotAvailableWhenUASTC: false,
    };
    const mock = {
      DefaultNumWorkers: 4,
      DefaultDecoderOptions: decoderOptions,
    };
    configureKtx2DecoderRuntime(mock, {
      mainThread: true,
      caps: { astc: {}, bptc: {} },
      renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 16.0.0)))",
    });
    expect(decoderOptions.forceRGBA).toBe(true);
  });

  it("retains hardware compression when packed play decodes on the main thread", () => {
    const decoderOptions = {
      forceRGBA: false,
      useRGBAIfASTCBC7NotAvailableWhenUASTC: false,
    };
    const mock = {
      DefaultNumWorkers: 4,
      DefaultDecoderOptions: decoderOptions,
    };
    configureKtx2DecoderRuntime(mock, {
      mainThread: true,
      caps: { astc: {}, bptc: {} },
      renderer: "WebKit WebGL",
    });
    expect(mock.DefaultNumWorkers).toBe(0);
    expect(decoderOptions.forceRGBA).toBe(false);
  });

  it("keeps GPU compressed transcode when ASTC is available", () => {
    const decoderOptions = {
      forceRGBA: true,
      useRGBAIfASTCBC7NotAvailableWhenUASTC: false,
    };
    const mock = {
      DefaultNumWorkers: 4,
      DefaultDecoderOptions: decoderOptions,
    };
    configureKtx2DecoderRuntime(mock, {
      caps: { astc: {}, bptc: null },
      renderer: "Apple A16 GPU",
    });
    expect(mock.DefaultNumWorkers).toBe(4);
    expect(decoderOptions.forceRGBA).toBe(false);
    expect(decoderOptions.useRGBAIfASTCBC7NotAvailableWhenUASTC).toBe(true);
  });

  it("requires every transcoder wasm in a player file map", () => {
    const files = new Map<string, Uint8Array>([
      ["ktx2/babylon.ktx2Decoder.js", new Uint8Array([1])],
      ["ktx2/msc_basis_transcoder.js", new Uint8Array([1])],
      ["ktx2/msc_basis_transcoder.wasm", new Uint8Array([1])],
    ]);
    expect(playerFilesHaveKtx2Transcoder(files)).toBe(false);
    files.set("ktx2/uastc_astc.wasm", new Uint8Array([1]));
    files.set("ktx2/uastc_bc7.wasm", new Uint8Array([1]));
    files.set("ktx2/zstddec.wasm", new Uint8Array([1]));
    expect(playerFilesHaveKtx2Transcoder(files)).toBe(false);
    files.set("ktx2/uastc_rgba8_unorm_v2.wasm", new Uint8Array([1]));
    files.set("ktx2/uastc_rgba8_srgb_v2.wasm", new Uint8Array([1]));
    files.set("ktx2/uastc_r8_unorm.wasm", new Uint8Array([1]));
    files.set("ktx2/uastc_rg8_unorm.wasm", new Uint8Array([1]));
    expect(playerFilesHaveKtx2Transcoder(files)).toBe(true);
  });

  it("never packs KTX2 for Preview Build", () => {
    expect(shouldPackKtx2ForPreviewBuild()).toBe(false);
  });
});

describe("WebGPU KTX2 block alignment", () => {
  const webgpu = (caps: { astc?: unknown; bptc?: unknown } = { astc: {} }) => ({ isWebGPU: true, getCaps: () => caps });
  const compressed = { forceRGBA: false };

  it("refuses a block-compressed WebGPU upload whose base size is not whole 4x4 blocks", () => {
    expect(webGpuKtx2BlockMisalignment(webgpu(), ktx2HeaderBytes(1, 1), compressed)).toEqual({ width: 1, height: 1 });
    expect(webGpuKtx2BlockMisalignment(webgpu({ bptc: {} }), ktx2HeaderBytes(8, 6), compressed)).toEqual({ width: 8, height: 6 });
  });

  it("allows uploads WebGPU accepts or that never transcode to a block format", () => {
    expect(webGpuKtx2BlockMisalignment(webgpu(), ktx2HeaderBytes(4, 8), compressed)).toBeNull();
    expect(webGpuKtx2BlockMisalignment({ ...webgpu(), isWebGPU: false }, ktx2HeaderBytes(1, 1), compressed)).toBeNull();
    expect(webGpuKtx2BlockMisalignment(webgpu(), ktx2HeaderBytes(1, 1), { forceRGBA: true })).toBeNull();
    expect(webGpuKtx2BlockMisalignment(webgpu({}), ktx2HeaderBytes(1, 1), compressed)).toBeNull();
    // VK_FORMAT_R8G8B8A8_UNORM: an uncompressed KTX2 uploads as authored.
    expect(webGpuKtx2BlockMisalignment(webgpu(), ktx2HeaderBytes(1, 1, 37), compressed)).toBeNull();
    expect(webGpuKtx2BlockMisalignment(webgpu(), ktx2HeaderBytes(1, 1).subarray(0, 24), compressed)).toBeNull();
    expect(webGpuKtx2BlockMisalignment(webgpu(), new Uint8Array([0x89, 0x50, 0x4e, 0x47]), compressed)).toBeNull();
  });

  it("names the texture, its size and the fix for the Materials that sample it", () => {
    expect(textureBlockSizeMessage({ name: "Spark", width: 1, height: 1, particle: true }))
      .toMatch(/^Texture "Spark" \(1×1\) was not drawn: .* Set its Usage to Particle\.$/);
    expect(textureBlockSizeMessage({ name: "Brick", width: 30, height: 18, other: true }))
      .toMatch(/^Texture "Brick" \(30×18\) was not drawn: .* Resize the image to a multiple of 4 pixels\.$/);
    expect(textureBlockSizeMessage({ name: "Shared", width: 1, height: 1, particle: true, other: true }))
      .toMatch(/Set its Usage to Particle, or resize the image to a multiple of 4 pixels\.$/);
  });
});
