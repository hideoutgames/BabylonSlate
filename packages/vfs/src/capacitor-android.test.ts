import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs tooling script, intentionally untyped.
import { scanText } from "../../../scripts/check-public-hygiene.mjs";

const vfsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(vfsDir, "../../..");
const androidRoot = join(repoRoot, "apps/editor/android");
const editorPkg = JSON.parse(
  readFileSync(join(repoRoot, "apps/editor/package.json"), "utf8"),
) as { dependencies: Record<string, string> };
const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
const settings = readFileSync(join(androidRoot, "capacitor.settings.gradle"), "utf8");
const javaRoot = join(
  androidRoot,
  "app/src/main/java/no/hideout/babylonslate",
);
const mainActivity = readFileSync(join(javaRoot, "MainActivity.java"), "utf8");

function resolvedPlatformVersion(platform: "android" | "ios"): string {
  const version = lockfile.match(
    new RegExp(
      `^\\s{6}'@capacitor/${platform}':\\s*\\n\\s{8}specifier:[^\\n]+\\n\\s{8}version:\\s*([0-9]+\\.[0-9]+\\.[0-9]+)`,
      "m",
    ),
  )?.[1];
  expect(version).toBeDefined();
  return version!;
}

function registeredPluginName(path: string): string {
  const source = readFileSync(path, "utf8");
  const name = source.match(
    /registerPlugin(?:<[^>]+>)?\s*\(\s*"([^"]+)"/s,
  )?.[1];
  expect(name).toBeDefined();
  return name!;
}

const plugins = [
  {
    className: "BabylonSlateSecretsPlugin",
    typescript: "capacitor-secret-store.ts",
  },
  {
    className: "BabylonSlateScopedStoragePlugin",
    typescript: "capacitor-scoped-storage.ts",
  },
  {
    className: "BabylonSlateAudioLifecyclePlugin",
    typescript: "capacitor-audio-lifecycle.ts",
  },
  {
    className: "BabylonSlateMemoryPlugin",
    typescript: "device-memory.ts",
  },
].map((plugin) => ({
  ...plugin,
  jsName: registeredPluginName(join(vfsDir, plugin.typescript)),
}));

const binaryExtensions = new Set([
  ".aab",
  ".apk",
  ".class",
  ".dex",
  ".gif",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".keystore",
  ".jks",
  ".png",
  ".webp",
]);

function filesIn(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const projectPath = relative(androidRoot, path).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (
        entry.name === "build" ||
        entry.name === ".gradle" ||
        entry.name === ".idea" ||
        entry.name === "capacitor-cordova-android-plugins" ||
        projectPath === "app/src/main/assets" ||
        projectPath.startsWith("app/src/main/assets/")
      ) {
        return [];
      }
      return filesIn(path);
    }
    return binaryExtensions.has(extname(path).toLowerCase()) ? [] : [path];
  });
}

describe("Capacitor 8 Android host", () => {
  it("keeps every Android Capacitor plugin in generated Gradle wiring", () => {
    const androidVersion = resolvedPlatformVersion("android");
    const nativeDependencies = Object.keys(editorPkg.dependencies).filter(
      (name) =>
        name.startsWith("@capacitor/") &&
        ![
          "@capacitor/android",
          "@capacitor/cli",
          "@capacitor/core",
          "@capacitor/ios",
        ].includes(name),
    );
    for (const dependency of nativeDependencies) {
      const name = dependency.slice("@capacitor/".length);
      expect(settings).toContain(`project(':capacitor-${name}')`);
    }
    const platformPaths = [
      ...settings.matchAll(/@capacitor\+android@([0-9.]+)_/g),
    ];
    expect(platformPaths.length).toBeGreaterThan(0);
    for (const match of platformPaths) expect(match[1]).toBe(androidVersion);
  });

  it("registers the four app-module plugins with their TypeScript names", () => {
    const registeredClasses = [
      ...mainActivity.matchAll(/registerPlugin\((\w+)\.class\)/g),
    ].map((match) => match[1]);
    expect(registeredClasses.sort()).toEqual(
      plugins.map((plugin) => plugin.className).sort(),
    );
    for (const plugin of plugins) {
      const source = readFileSync(join(javaRoot, `${plugin.className}.java`), "utf8");
      const annotations = [
        ...source.matchAll(/@CapacitorPlugin\(name = "([^"]+)"\)/g),
      ].map((match) => match[1]);
      expect(annotations).toEqual([plugin.jsName]);
    }
  });

  it("implements required scoped-storage methods and Android read scopes", () => {
    const typescript = readFileSync(
      join(vfsDir, "capacitor-scoped-storage.ts"),
      "utf8",
    );
    const body = typescript.match(
      /export interface BabylonSlateScopedStoragePlugin \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(body).toBeDefined();
    const methods = [...body!.matchAll(/^\s{2}(\w+)(\?)?\(/gm)]
      .filter((match) => match[2] !== "?" || ["beginReadScope", "endReadScope"].includes(match[1]!))
      .map((match) => match[1])
      .sort();
    const java = readFileSync(
      join(javaRoot, "BabylonSlateScopedStoragePlugin.java"),
      "utf8",
    );
    const implemented = [
      ...java.matchAll(/@PluginMethod\s+public(?:\s+synchronized)?\s+void (\w+)\(/g),
    ].map((match) => match[1]).sort();
    expect(implemented).toEqual(methods);
    expect(methods).not.toContain("importBookmark");
  });

  it("keeps tracked Android text sources free of credential material", () => {
    const files = filesIn(androidRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(scanText(file, readFileSync(file, "utf8"))).toEqual([]);
    }
  });
});
