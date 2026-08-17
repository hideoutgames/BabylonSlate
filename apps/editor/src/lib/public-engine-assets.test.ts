import { describe, expect, it } from "vitest";
import { publicAssetUrl } from "./branding";
import {
  editorEncodeWorkerUrl,
  editorKtx2PublicBase,
} from "./public-engine-assets";

describe("public engine assets", () => {
  it("resolves the Basis encode worker under the Vite base", () => {
    expect(editorEncodeWorkerUrl()).toBe(
      publicAssetUrl("basis/encode-worker.js"),
    );
    expect(editorEncodeWorkerUrl()).toMatch(/basis\/encode-worker\.js$/);
  });

  it("resolves the KTX2 transcoder directory under the Vite base", () => {
    expect(editorKtx2PublicBase()).toBe(publicAssetUrl("ktx2/"));
    expect(editorKtx2PublicBase().endsWith("/")).toBe(true);
  });
});
