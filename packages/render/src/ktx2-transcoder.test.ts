import { describe, expect, it, vi } from "vitest";
import {
  configureKtx2Transcoder,
  ktx2TranscoderUrls,
  probeKtx2TranscoderAvailable,
} from "./ktx2-transcoder";

describe("ktx2 transcoder config", () => {
  it("builds self-hosted URLs under the public base", () => {
    const urls = ktx2TranscoderUrls("/ktx2/");
    expect(urls.jsDecoderModule).toBe("/ktx2/babylon.ktx2Decoder.js");
    expect(urls.wasmUASTCToASTC).toContain("uastc_astc.wasm");
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
});
