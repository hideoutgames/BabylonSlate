import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build, type Rolldown } from "vite";
import { createPlatformModules, platformChunkName, platformModuleGroup, platformModuleProblems, platformModules } from "./vite-platform-modules";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Builds `files` (entry `main.ts`) as the player does and returns the emitted files. */
async function buildFixture(
  files: Record<string, string>,
  packages?: Record<string, string>,
): Promise<Map<string, Rolldown.OutputChunk | Rolldown.OutputAsset>> {
  const root = mkdtempSync(path.join(tmpdir(), "platform-modules-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), source);
  }
  const state = createPlatformModules();
  const output = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [platformModules(state, { writeList: true, packages })],
    build: {
      write: false,
      minify: false,
      // As the player builds: an app entry named player.js, chunks named player-[name].js.
      rolldownOptions: {
        input: path.join(root, "main.ts"),
        output: { format: "es", entryFileNames: "player.js", chunkFileNames: "player-[name].js", codeSplitting: { groups: [platformModuleGroup(state)] } },
      },
    },
  });
  const result = (Array.isArray(output) ? output[0] : output) as Rolldown.RolldownOutput;
  return new Map(result.output.map((file) => [file.fileName, file]));
}

const desktop = "// #if WITH_DESKTOP\nexport const presence = (): string => \"desktop presence\";\n// #endif\n";

describe("platform modules in the player build", () => {
  it("gives a dynamically imported platform module its own file and lists it with its condition", async () => {
    const files = await buildFixture({
      "main.ts": "(globalThis as Record<string, unknown>).presence = async (onDesktop: boolean): Promise<string> =>\n  onDesktop ? (await import(\"./desktop\")).presence() : \"none\";\n",
      "desktop.ts": desktop,
    });
    const list = files.get("platform-modules.json");
    expect(list?.type).toBe("asset");
    expect(JSON.parse(String((list as Rolldown.OutputAsset).source))).toEqual({ "player-platform-desktop.js": "WITH_DESKTOP" });
    const chunk = files.get("player-platform-desktop.js") as Rolldown.OutputChunk;
    expect(chunk.code).toContain("desktop presence");
    expect((files.get("player.js") as Rolldown.OutputChunk).code).not.toContain("desktop presence");
  });

  it("puts an npm package only platform modules use in their file, and keeps it out of the others", async () => {
    const files = await buildFixture({
      "main.ts": "(globalThis as Record<string, unknown>).presence = async (onMobile: boolean): Promise<string> =>\n  onMobile ? (await import(\"./mobile\")).presence() : \"none\";\n",
      "mobile.ts": "// #if WITH_MOBILE\nimport { bridge } from \"native-bridge\";\nexport const presence = (): string => bridge();\n// #endif\n",
      "node_modules/native-bridge/package.json": "{\"name\":\"native-bridge\",\"type\":\"module\",\"main\":\"index.js\"}",
      "node_modules/native-bridge/index.js": "export const bridge = () => \"native bridge\";\n",
    }, { "native-bridge": "WITH_MOBILE" });
    expect(JSON.parse(String((files.get("platform-modules.json") as Rolldown.OutputAsset).source))).toEqual({ "player-platform-mobile.js": "WITH_MOBILE" });
    expect((files.get("player-platform-mobile.js") as Rolldown.OutputChunk).code).toContain("native bridge");
    const plain = [...files.values()].filter((file) => file.type === "chunk" && file.fileName !== "player-platform-mobile.js");
    for (const chunk of plain) expect((chunk as Rolldown.OutputChunk).code).not.toContain("native bridge");
  });

  it("fails the build when plain code imports a platform module statically", async () => {
    await expect(buildFixture({
      "main.ts": "import { presence } from \"./desktop\";\n(globalThis as Record<string, unknown>).presence = presence;\n",
      "desktop.ts": desktop,
    })).rejects.toThrow(/statically imports player-platform-desktop\.js \(WITH_DESKTOP\)/);
  });

  it("fails the build on an inline directive in engine code, naming the file", async () => {
    await expect(buildFixture({
      "main.ts": "export const a = 1;\n// #if WITH_DESKTOP\nexport const b = 2;\n// #endif\n",
    })).rejects.toThrow(/main\.ts:2: Engine code that ships in games can mark only a whole file/);
  });
});

describe("platformModuleProblems", () => {
  const modules = createPlatformModules();
  modules.conditions.set("/repo/packages/a/desktop.ts", "WITH_DESKTOP");
  modules.conditions.set("/repo/packages/a/mobile.ts", "WITH_MOBILE");
  const chunk = (fileName: string, ids: string[], imports: string[] = []) =>
    [fileName, { type: "chunk", fileName, imports, modules: Object.fromEntries(ids.map((id) => [id, {}])) }] as const;

  it("rejects a file that mixes a platform module with plain code or another condition", () => {
    const bundle = Object.fromEntries([
      chunk("a.js", ["/repo/packages/a/desktop.ts", "/repo/packages/a/shared.ts"]),
      chunk("b.js", ["/repo/packages/a/desktop.ts", "/repo/packages/a/mobile.ts"]),
    ]) as unknown as Rolldown.OutputBundle;
    expect(platformModuleProblems(bundle, modules).problems).toEqual([
      "a.js mixes platform modules (WITH_DESKTOP) with packages/a/shared.ts.",
      "b.js mixes platform modules (WITH_DESKTOP; WITH_MOBILE) with each other.",
    ]);
  });
});

describe("platformChunkName", () => {
  it.each([
    ["WITH_DESKTOP", "platform-desktop"],
    ["WITH_DESKTOP && !WITH_LINUX", "platform-desktop-and-not-linux"],
    ["(WITH_ANDROID || WITH_IOS) && WITH_EDITOR", "platform-android-or-ios-and-editor"],
  ])("names %s %s", (condition, name) => {
    expect(platformChunkName(condition)).toBe(name);
  });
});
