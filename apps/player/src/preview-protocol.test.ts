import { describe, expect, it } from "vitest";
import {
  filesFromPreviewPack,
  isPreviewPackMessage,
  PREVIEW_PACK_MESSAGE,
  previewPackFromFiles,
} from "./preview-protocol";

describe("preview pack protocol", () => {
  it("round-trips in-memory files without writing a project tree", () => {
    const files = new Map([
      ["game.json", new TextEncoder().encode('{"startupSceneGuid":"s1"}')],
    ]);
    const message = previewPackFromFiles(files);
    expect(message.type).toBe(PREVIEW_PACK_MESSAGE);
    expect(isPreviewPackMessage(message)).toBe(true);
    const restored = filesFromPreviewPack(message);
    expect(new TextDecoder().decode(restored.get("game.json"))).toContain("s1");
  });

  it("rejects unrelated window messages", () => {
    expect(isPreviewPackMessage({ type: "other" })).toBe(false);
  });
});
