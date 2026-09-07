import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { rendererFile, isEditorSender, validateIpcArguments } from "./packaged-security";

describe("packaged renderer boundary", () => {
  it("resolves player and wasm resources only inside the renderer root", () => {
    expect(rendererFile("app://babylonslate/player/index.html", "renderer")).toBe(resolve("renderer/player/index.html"));
    expect(rendererFile("app://babylonslate/assets/physics.wasm", "renderer")).toBe(resolve("renderer/assets/physics.wasm"));
    for (const url of ["file:///secret", "app://other/index.html", "app://babylonslate/%2e%2e/secret", "app://babylonslate/..%5csecret", "app://babylonslate/C:/secret", "app://babylonslate/%252e%252e/secret", "app://babylonslate/assets/key%00"]) {
      expect(() => rendererFile(url, "renderer")).toThrow();
    }
  });
  it("only accepts the main editor frame as a privileged IPC sender", () => {
    expect(isEditorSender("app://babylonslate/index.html", true)).toBe(true);
    for (const url of ["https://babylonslate/index.html", "app://babylonslate/player/index.html", "app://other/index.html", "app://babylonslate/index.html.evil"]) {
      expect(isEditorSender(url, true)).toBe(false);
    }
    expect(isEditorSender("app://babylonslate/index.html", false)).toBe(false);
  });
  it("rejects malformed privileged arguments and filesystem escapes", () => {
    expect(() => validateIpcArguments("settings:write", ["{}"])).not.toThrow();
    expect(() => validateIpcArguments("project:writeBinary", ["assets/a.bin", new ArrayBuffer(4)])).not.toThrow();
    for (const [channel, args] of [
      ["settings:write", [{}]], ["settings:write", ["not json"]],
      ["project:openDocuments", ["../outside"]], ["project:readBinary", ["../projects-other/key"]],
      ["project:remove", ["."]], ["project:readBinary", ["C:\\secret"]],
      ["project:writeBinary", ["x", "bad"]], ["secrets:set", ["key", {}]],
      ["lfs:fetch", [{ url: "file:///secret" }]], ["unknown", []],
    ] as Array<[string, unknown[]]>) expect(() => validateIpcArguments(channel, args)).toThrow();
  });
});
