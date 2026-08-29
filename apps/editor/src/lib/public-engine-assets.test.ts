import { describe, expect, it } from "vitest";
import { publicAssetUrl } from "./branding";
import {
  editorEncodeWorkerUrl,
  editorKtx2PublicBase,
  editorDracoPublicBase,
  editorMeshoptPublicBase,
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

  it("resolves Draco and meshopt decoder directories under the Vite base", () => {
    expect(editorDracoPublicBase()).toBe(publicAssetUrl("draco/"));
    expect(editorDracoPublicBase().endsWith("/")).toBe(true);
    expect(editorMeshoptPublicBase()).toBe(publicAssetUrl("meshopt/"));
    expect(editorMeshoptPublicBase().endsWith("/")).toBe(true);
  });
});
