import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const vfsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(vfsDir, "../../..");
const pkg = JSON.parse(
  readFileSync(join(vfsDir, "../package.json"), "utf8"),
) as { dependencies: Record<string, string> };
const editorPkg = JSON.parse(
  readFileSync(join(repoRoot, "apps/editor/package.json"), "utf8"),
) as { dependencies: Record<string, string> };
const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
const podfile = readFileSync(
  join(repoRoot, "apps/editor/ios/App/Podfile"),
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

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return filesIn(path);
    }
    return [path];
  });
}

function podNameForDependency(dependency: string): string {
  const names: Record<string, string> = {
    "@capacitor/core": "Capacitor",
    "@capacitor/filesystem": "CapacitorFilesystem",
    "@capacitor/preferences": "CapacitorPreferences",
    "@daniele-rolli/capacitor-scoped-storage": "CapacitorScopedStorage",
  };
  return names[dependency] ?? dependency;
}

describe("Capacitor 8 iOS host", () => {
  it("keeps the iOS dependencies on Capacitor 8 and scoped-storage 0.1.0", () => {
    expect(pkg.dependencies["@capacitor/core"]).toMatch(/^\^8/);
    expect(pkg.dependencies["@daniele-rolli/capacitor-scoped-storage"]).toBe(
      "^0.1.0",
    );
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
    expect(podfile).toContain(`@capacitor+ios@${resolvedCapacitorVersion}_`);
    for (const match of podfile.matchAll(/@capacitor\+ios@([0-9.]+)_/g)) {
      expect(match[1]).toBe(resolvedCapacitorVersion);
    }

    const podNames = new Set(
      [...podfile.matchAll(/pod '([^']+)'/g)].map((match) => match[1]),
    );
    for (const dependency of Object.keys(pkg.dependencies).filter(
      (name) =>
        name.startsWith("@capacitor/") ||
        name === "@daniele-rolli/capacitor-scoped-storage",
    )) {
      expect(podNames).toContain(podNameForDependency(dependency));
    }
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
    const capacitor = readFileSync(
      join(repoRoot, "apps/editor/capacitor.config.ts"),
      "utf8",
    );
    expect(capacitor).toMatch(
      /packageClassList:\s*\["BabylonSlateSecretsPlugin"\]/,
    );
    expect(pbxproj).toMatch(/BabylonSlateSecretsPlugin\.swift in Sources/);
    expect(pbxproj).toMatch(
      /BabylonSlateSecretsPlugin\.swift \*\/ = \{isa = PBXFileReference/,
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
      if (statSync(file).size === 0) {
        continue;
      }
      const content = readFileSync(file);
      if (content.includes(0)) {
        continue;
      }
      const text = content.toString("utf8");
      expect(text).not.toContain("DEVELOPMENT_TEAM");
      expect(text).not.toContain("PROVISIONING_PROFILE");
    }
  });
});
