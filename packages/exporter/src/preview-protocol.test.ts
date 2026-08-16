import { describe, expect, it } from "vitest";
import {
  filesFromPreviewPack,
  isPreviewDiagnosticsMessage,
  isPreviewErrorMessage,
  isPreviewPackMessage,
  isPreviewRequestPackMessage,
  PREVIEW_DIAGNOSTICS_MESSAGE,
  PREVIEW_ERROR_MESSAGE,
  PREVIEW_PACK_MESSAGE,
  PREVIEW_REQUEST_PACK_MESSAGE,
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
    expect(isPreviewDiagnosticsMessage({ type: "other" })).toBe(false);
    expect(
      isPreviewDiagnosticsMessage({ type: PREVIEW_DIAGNOSTICS_MESSAGE, diagnostics: [] }),
    ).toBe(true);
  });

  it("round-trips diagnostic code on Preview Build posts", () => {
    const message = {
      type: PREVIEW_DIAGNOSTICS_MESSAGE,
      diagnostics: [
        {
          message: "Infinite loop detected",
          severity: "error",
          code: "runtime.infinite_loop",
          nodeId: "js",
          bodyLine: 1,
        },
      ],
    };
    expect(isPreviewDiagnosticsMessage(message)).toBe(true);
    expect(message.diagnostics[0]?.code).toBe("runtime.infinite_loop");
    expect(message.diagnostics[0]?.bodyLine).toBe(1);
  });

  it("recognises the player asking for the pack once its listener is live", () => {
    expect(
      isPreviewRequestPackMessage({ type: PREVIEW_REQUEST_PACK_MESSAGE }),
    ).toBe(true);
    expect(isPreviewRequestPackMessage({ type: PREVIEW_PACK_MESSAGE })).toBe(false);
    expect(isPreviewRequestPackMessage(null)).toBe(false);
  });

  it("carries a boot failure back to the editor", () => {
    const message = { type: PREVIEW_ERROR_MESSAGE, message: "Export is missing game.json" };
    expect(isPreviewErrorMessage(message)).toBe(true);
    expect(isPreviewErrorMessage({ type: PREVIEW_ERROR_MESSAGE })).toBe(false);
    expect(isPreviewErrorMessage({ type: "other", message: "x" })).toBe(false);
  });
});
