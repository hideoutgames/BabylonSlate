import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { allowsEditorPermission, knownProjectFolder, rendererFile, isEditorSender, isPreviewFrameUrl, validateIpcArguments } from "./packaged-security";

describe("packaged renderer boundary", () => {
  it("resolves encoded asset filenames without treating filename characters as URL delimiters", () => {
    expect(rendererFile("app://babylonslate/textures/My%20Texture.png", "renderer")).toBe(resolve("renderer/textures/My Texture.png"));
    expect(rendererFile("app://babylonslate/fonts/%C3%A9%23font.woff2", "renderer")).toBe(resolve("renderer/fonts/é#font.woff2"));
  });
  it("resolves player and wasm resources only inside the renderer root", () => {
    expect(rendererFile("app://babylonslate/player/index.html", "renderer")).toBe(resolve("renderer/player/index.html"));
    expect(rendererFile("app://babylonslate/assets/physics.wasm", "renderer")).toBe(resolve("renderer/assets/physics.wasm"));
    for (const url of ["file:///secret", "app://other/index.html", "app://babylonslate/%2e%2e/secret", "app://babylonslate/..%5csecret", "app://babylonslate/C:/secret", "app://babylonslate/%252e%252e/secret", "app://babylonslate/assets/key%00", "app://babylonslate/..%20/secret", "app://babylonslate/assets/..%20./secret", "app://babylonslate/.../secret"]) {
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
  it("limits subframes to the Preview player and grants the editor only clipboard writes", () => {
    expect(isPreviewFrameUrl("app://babylonslate/player/index.html?preview=1&t=2")).toBe(true);
    for (const url of ["https://example.com/", "app://babylonslate/index.html", "app://other/player/index.html", "about:blank"]) {
      expect(isPreviewFrameUrl(url)).toBe(false);
    }
    expect(allowsEditorPermission("clipboard-sanitized-write", "app://babylonslate/index.html", true)).toBe(true);
    expect(allowsEditorPermission("clipboard-sanitized-write", "app://babylonslate/player/index.html", false)).toBe(false);
    expect(allowsEditorPermission("clipboard-read", "app://babylonslate/index.html", true)).toBe(false);
    expect(allowsEditorPermission("media", "app://babylonslate/index.html", true)).toBe(false);
  });
  it("rejects malformed privileged arguments and filesystem escapes", () => {
    expect(() => validateIpcArguments("save-games:list", ["save-games/project/game/profile/"])).not.toThrow();
    expect(() => validateIpcArguments("save-games:write", ["save-games/project/game/profile/slot/generation-a.save", "{}"]))
      .not.toThrow();
    expect(() => validateIpcArguments("settings:write", ["{}"])).not.toThrow();
    expect(() => validateIpcArguments("account-secrets:get", ["slate-clerk-client:pk_test_example"])).not.toThrow();
    expect(() => validateIpcArguments("account-secrets:set", ["slate-clerk-client:pk_test_example", "token"])).not.toThrow();
    expect(() => validateIpcArguments("account-secrets:delete", ["slate-clerk-client:pk_test_example"])).not.toThrow();
    expect(() => validateIpcArguments("project:writeBinary", ["assets/a.bin", new ArrayBuffer(4)])).not.toThrow();
    for (const [channel, args] of [
      ["save-games:read", ["../outside"]], ["save-games:write", ["/absolute", "{}"]],
      ["save-games:remove", ["project//file"]], ["save-games:release-lock", ["../token"]],
      ["save-games:write", ["project/file", {}]],
      ["settings:write", [{}]], ["settings:write", ["not json"]],
      ["project:openDocuments", ["../outside"]], ["project:readBinary", ["../projects-other/key"]],
      ["project:remove", ["."]], ["project:readBinary", ["C:\\secret"]],
      ["project:writeBinary", ["x", "bad"]], ["secrets:set", ["key", {}]],
      ["account-secrets:set", ["key", {}]], ["account-secrets:get", [""]],
      ["account-secrets:delete", ["key", "extra"]],
      ["lfs:fetch", [{ url: "file:///secret" }]], ["unknown", []],
    ] as Array<[string, unknown[]]>) expect(() => validateIpcArguments(channel, args)).toThrow();
  });
  it("validates positioned reads before native allocation", () => {
    expect(() => validateIpcArguments("project:readBinaryRange", ["asset.babasset", 12, 24, "revision"])).not.toThrow();
    for (const args of [
      ["../asset.babasset", 0, 1, undefined], ["asset.babasset", -1, 1, undefined],
      ["asset.babasset", 0.5, 1, undefined], ["asset.babasset", 0, Infinity, undefined],
      ["asset.babasset", 0, 1024 * 1024 * 1024, undefined], ["asset.babasset", Number.MAX_SAFE_INTEGER, 1, undefined],
      ["asset.babasset", 0, 1, {}],
    ]) expect(() => validateIpcArguments("project:readBinaryRange", args)).toThrow();
  });
});

describe("known project folders", () => {
  it("reopens projects-home folders and picker grants by the canonical path it opens", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "babylonslate-known-")));
    try {
      const projects = join(base, "projects");
      const game = join(projects, "Game");
      const outside = join(base, "outside");
      await mkdir(game, { recursive: true });
      await mkdir(outside);
      // Junctions need no privilege on Windows; other hosts create directory links.
      await symlink(outside, join(projects, "Linked"), "junction");
      const noGrants = async () => [];

      expect(await knownProjectFolder(`node:${game}`, projects, noGrants)).toBe(game);
      // A link inside the projects home opens its target, which needs a grant.
      await expect(knownProjectFolder(`node:${join(projects, "Linked")}`, projects, noGrants)).rejects.toThrow("folder picker");
      expect(await knownProjectFolder(`node:${join(projects, "Linked")}`, projects, async () => [outside])).toBe(outside);
      await expect(knownProjectFolder(`node:${base}`, projects, noGrants)).rejects.toThrow("folder picker");
      // Only host-issued node: ids reopen; a bare display name never opens a folder by name.
      await expect(knownProjectFolder("Game", projects, async () => [game])).rejects.toThrow("folder picker");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
