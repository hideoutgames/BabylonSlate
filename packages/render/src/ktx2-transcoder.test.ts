import { describe, expect, it } from "vitest";
import {
  configureKtx2Transcoder,
  ktx2TranscoderUrls,
} from "./ktx2-transcoder";

describe("ktx2 transcoder config", () => {
  it("builds self-hosted URLs under the public base", () => {
    const urls = ktx2TranscoderUrls("/ktx2/");
    expect(urls.jsDecoderModule).toBe("/ktx2/babylon.ktx2Decoder.js");
    expect(urls.wasmUASTCToASTC).toContain("uastc_astc.wasm");
  });

  it("applies URLConfig without reaching for a CDN", () => {
    const mock = { URLConfig: {} as Record<string, string> };
    configureKtx2Transcoder(mock, "/assets/ktx2");
    expect(mock.URLConfig.jsDecoderModule).toBe(
      "/assets/ktx2/babylon.ktx2Decoder.js",
    );
    expect(Object.values(mock.URLConfig).join(" ")).not.toMatch(/cdn|http/i);
  });
});
