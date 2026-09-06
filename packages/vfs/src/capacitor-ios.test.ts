import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const vfsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(vfsDir, "../../..");
const pkg = JSON.parse(
  readFileSync(join(vfsDir, "../package.json"), "utf8"),
) as { dependencies: Record<string, string> };
const editorPkg = JSON.parse(
  readFileSync(join(repoRoot, "apps/editor/package.json"), "utf8"),
) as {
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
};
const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
const podfile = readFileSync(
  join(repoRoot, "apps/editor/ios/App/Podfile"),
  "utf8",
);
const podfileLock = readFileSync(
  join(repoRoot, "apps/editor/ios/App/Podfile.lock"),
  "utf8",
);
const pbxproj = readFileSync(
  join(repoRoot, "apps/editor/ios/App/App.xcodeproj/project.pbxproj"),
  "utf8",
);
const plist = readFileSync(
  join(repoRoot, "apps/editor/ios/App/App/Info.plist"),
  "utf8",
);
const capacitorConfig = readFileSync(
  join(repoRoot, "apps/editor/capacitor.config.ts"),
  "utf8",
);
const iosSyncScriptPath = join(repoRoot, "apps/editor/scripts/ios-sync.mjs");
const iosSyncScript = readFileSync(iosSyncScriptPath, "utf8");

const skippedDirectories = new Set([
  "public",
  "Pods",
  "build",
  "DerivedData",
  "output",
  "xcuserdata",
]);
const textExtensions = new Set([
  ".h",
  ".lock",
  ".m",
  ".mm",
  ".pbxproj",
  ".plist",
  ".podspec",
  ".rb",
  ".swift",
  ".xml",
]);

function filesIn(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) {
        return [];
      }
      return filesIn(path);
    }
    return [path];
  });
}

function isTextFile(path: string): boolean {
  return basename(path) === "Podfile" || textExtensions.has(extname(path));
}

function podNameForDependency(dependency: string): string {
  const names: Record<string, string> = {
    "@capacitor/core": "Capacitor",
    "@capacitor/filesystem": "CapacitorFilesystem",
    "@capacitor/preferences": "CapacitorPreferences",
    "@capacitor/status-bar": "CapacitorStatusBar",
  };
  return names[dependency] ?? dependency;
}

describe("Capacitor 8 iOS host", () => {
  it("keeps the iOS dependencies on Capacitor 8 and drops the community scoped-storage plugin", () => {
    expect(pkg.dependencies["@capacitor/core"]).toMatch(/^\^8/);
    expect(pkg.dependencies["@daniele-rolli/capacitor-scoped-storage"]).toBeUndefined();
    expect(editorPkg.dependencies["@daniele-rolli/capacitor-scoped-storage"]).toBeUndefined();
  });

  it("matches the resolved Capacitor version and includes every native plugin pod", () => {
    const capacitorVersionRange =
      editorPkg.dependencies["@capacitor/core"] ?? "";
    const capacitorMajor = Number(capacitorVersionRange.match(/\d+/)?.[0]);
    expect(capacitorMajor).toBe(8);

    const platformVersion = podfile.match(
      /^platform :ios, '([0-9]+\.[0-9]+)'$/m,
    )?.[1];
    expect(platformVersion).toBe("15.0");

    const resolvedCapacitorVersion = lockfile.match(
      /^\s{6}'@capacitor\/ios':\s*\n\s{8}specifier:[^\n]+\n\s{8}version:\s*([0-9]+\.[0-9]+\.[0-9]+)/m,
    )?.[1];
    expect(resolvedCapacitorVersion).toBeDefined();
    const capacitorPodfilePath = podfile.match(
      /pod 'Capacitor', :path => '([^']+)'/,
    )?.[1];
    const capacitorLockfilePath = podfileLock.match(
      /Capacitor:\s*\n\s*:path: "([^"]+)"/,
    )?.[1];
    expect(capacitorPodfilePath).toBeDefined();
    expect(capacitorLockfilePath).toBe(capacitorPodfilePath);
    for (const source of [podfile, podfileLock]) {
      const capacitorPaths = [
        ...source.matchAll(/@capacitor\+ios@([0-9.]+)_/g),
      ];
      expect(capacitorPaths.length).toBeGreaterThan(0);
      for (const match of capacitorPaths) {
        expect(match[1]).toBe(resolvedCapacitorVersion);
      }
    }

    const podNames = new Set(
      [...podfile.matchAll(/pod '([^']+)'/g)].map((match) => match[1]),
    );
    const nativeDependencies = Object.keys(editorPkg.dependencies).filter(
      (name) =>
        name.startsWith("@capacitor/") &&
        name !== "@capacitor/cli" &&
        name !== "@capacitor/ios",
    );
    expect(podfile).not.toContain("CapacitorScopedStorage");
    expect(podfileLock).not.toContain("CapacitorScopedStorage");
    for (const dependency of nativeDependencies) {
      expect(editorPkg.dependencies[dependency]).toBeDefined();
      expect(podNames).toContain(podNameForDependency(dependency));
    }

    expect(podfileLock).toMatch(
      new RegExp(`- Capacitor \\(${resolvedCapacitorVersion}\\)`),
    );
    expect(podfileLock).toMatch(
      new RegExp(`- CapacitorCordova \\(${resolvedCapacitorVersion}\\)`),
    );
  });

  it("enforces the Capacitor 8 deployment and iPad-only project settings", () => {
    const deploymentTargets = [
      ...pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([0-9.]+);/g),
    ].map((match) => Number(match[1]));
    expect(deploymentTargets.length).toBeGreaterThan(0);
    expect(deploymentTargets.every((target) => target >= 15)).toBe(true);

    const deviceFamilies = [
      ...pbxproj.matchAll(/TARGETED_DEVICE_FAMILY = "([^"]+)";/g),
    ].map((match) => match[1]);
    expect(deviceFamilies.length).toBeGreaterThan(0);
    expect(deviceFamilies.every((family) => family === "2")).toBe(true);

    const requiredCapabilities = plist.match(
      /<key>UIRequiredDeviceCapabilities<\/key>\s*<array>([\s\S]*?)<\/array>/,
    )?.[1];
    expect(requiredCapabilities).toContain("<string>arm64</string>");
    expect(plist).not.toContain("armv7");
    expect(plist).not.toMatch(
      /<key>UISupportedInterfaceOrientations<\/key>\s*<array>[\s\S]*?<\/array>/,
    );

    const ipadOrientations = plist.match(
      /<key>UISupportedInterfaceOrientations~ipad<\/key>\s*<array>([\s\S]*?)<\/array>/,
    )?.[1];
    expect(ipadOrientations).toContain(
      "<string>UIInterfaceOrientationLandscapeLeft</string>",
    );
    expect(ipadOrientations).toContain(
      "<string>UIInterfaceOrientationLandscapeRight</string>",
    );
    expect(ipadOrientations).not.toContain("Portrait");
  });

  it("preserves the local plugin registration and clean signing configuration", () => {
    expect(existsSync(iosSyncScriptPath)).toBe(true);
    expect(iosSyncScript).toContain("packageClassList");
    expect(iosSyncScript).toMatch(
      /packageClassList\.add\("BabylonSlateSecretsPlugin"\)/,
    );
    expect(iosSyncScript).toMatch(
      /packageClassList\.add\("BabylonSlateScopedStoragePlugin"\)/,
    );
    expect(editorPkg.scripts["ios:sync"]).toBe("node scripts/ios-sync.mjs");
    expect(iosSyncScript).toMatch(/"cap",\s*"sync",\s*"ios"/s);
    expect(editorPkg.scripts["ios:build"]).toContain(
      "node scripts/ios-build.mjs",
    );
    expect(pbxproj).toMatch(/BabylonSlateSecretsPlugin\.swift in Sources/);
    expect(pbxproj).toMatch(
      /BabylonSlateSecretsPlugin\.swift \*\/ = \{isa = PBXFileReference/,
    );
    expect(pbxproj).toMatch(/BabylonSlateScopedStoragePlugin\.swift in Sources/);
    expect(pbxproj).toMatch(
      /BabylonSlateScopedStoragePlugin\.swift \*\/ = \{isa = PBXFileReference/,
    );
    expect(pbxproj).not.toContain("CODE_SIGN_IDENTITY");

    const generatedConfigPath = join(
      repoRoot,
      "apps/editor/ios/App/App/capacitor.config.json",
    );
    if (existsSync(generatedConfigPath)) {
      const generatedConfig = JSON.parse(
        readFileSync(generatedConfigPath, "utf8"),
      ) as { packageClassList?: string[] };
      expect(generatedConfig.packageClassList).toContain(
        "BabylonSlateSecretsPlugin",
      );
    }

    const iosFiles = filesIn(join(repoRoot, "apps/editor/ios"));
    for (const file of iosFiles) {
      if (!isTextFile(file)) {
        continue;
      }
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain("DEVELOPMENT_TEAM");
      expect(text).not.toContain("PROVISIONING_PROFILE");
    }
  });

  it("keeps the iOS web host assets available", () => {
    expect(capacitorConfig).toMatch(/webDir:\s*"dist"/);
    expect(capacitorConfig).toContain("coi-serviceworker.js");
    expect(
      existsSync(join(repoRoot, "apps/editor/public/coi-serviceworker.js")),
    ).toBe(true);
    expect(existsSync(join(repoRoot, "apps/editor/public/havok"))).toBe(true);
    expect(existsSync(join(repoRoot, "apps/editor/public/ktx2"))).toBe(true);
    expect(existsSync(join(repoRoot, "apps/editor/public/draco"))).toBe(true);
    expect(existsSync(join(repoRoot, "apps/editor/public/meshopt"))).toBe(true);
  });
});
