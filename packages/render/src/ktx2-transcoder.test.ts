import { describe, expect, it, vi } from "vitest";
import {
  configureKtx2DecoderRuntime,
  configureKtx2Transcoder,
  ktx2TranscoderUrls,
  playerFilesHaveKtx2Transcoder,
  probeKtx2TranscoderAvailable,
} from "./ktx2-transcoder";

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
});
