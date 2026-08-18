import { existsSync, readFileSync } from "node:fs";
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

describe("Capacitor 8 iOS host", () => {
  it("keeps native Capacitor dependencies direct in the iOS host", () => {
    expect(pkg.dependencies["@capacitor/core"]).toMatch(/^\^8/);
    expect(editorPkg.dependencies["@capacitor/filesystem"]).toMatch(/^\^8/);
    expect(editorPkg.dependencies["@capacitor/preferences"]).toMatch(/^\^8/);
    expect(
      pkg.dependencies["@daniele-rolli/capacitor-scoped-storage"],
    ).toBeUndefined();
  });

  it("copies wasm, transcoder, and coi from editor dist into iOS public/", () => {
    const capacitor = readFileSync(
      join(repoRoot, "apps/editor/capacitor.config.ts"),
      "utf8",
    );
    expect(capacitor).toMatch(/webDir:\s*"dist"/);
    expect(capacitor).toMatch(/coi-serviceworker/);
    expect(
      existsSync(join(repoRoot, "apps/editor/public/coi-serviceworker.js")),
    ).toBe(true);
    expect(existsSync(join(repoRoot, "apps/editor/public/havok"))).toBe(true);
    expect(existsSync(join(repoRoot, "apps/editor/public/ktx2"))).toBe(true);
    const gitignore = readFileSync(
      join(repoRoot, "apps/editor/ios/.gitignore"),
      "utf8",
    );
    expect(gitignore).toMatch(/App\/App\/public/);
  });

  it("compiles BabylonSlateSecretsPlugin into the iOS app target", () => {
    const pbx = readFileSync(
      join(repoRoot, "apps/editor/ios/App/App.xcodeproj/project.pbxproj"),
      "utf8",
    );
    expect(pbx).toMatch(/BabylonSlateSecretsPlugin\.swift in Sources/);
    expect(pbx).toMatch(/BabylonSlateSecretsPlugin\.swift \*\/ = \{isa = PBXFileReference/);
    const gitignore = readFileSync(
      join(repoRoot, "apps/editor/ios/.gitignore"),
      "utf8",
    );
    expect(gitignore).toMatch(/App\/App\/capacitor\.config\.json/);
  });

  it("registers first-party plugins from the bridge view controller", () => {
    const pbx = readFileSync(
      join(repoRoot, "apps/editor/ios/App/App.xcodeproj/project.pbxproj"),
      "utf8",
    );
    const main = readFileSync(
      join(repoRoot, "apps/editor/ios/App/App/MainViewController.swift"),
      "utf8",
    );
    expect(main).toMatch(/CAPBridgeViewController/);
    expect(main).toMatch(/capacitorDidLoad/);
    expect(main).toMatch(
      /registerPluginInstance\(BabylonSlateSecretsPlugin\(\)\)/,
    );
    expect(main).toMatch(
      /registerPluginInstance\(BabylonSlateFolderPlugin\(\)\)/,
    );

    const storyboard = readFileSync(
      join(repoRoot, "apps/editor/ios/App/App/Base.lproj/Main.storyboard"),
      "utf8",
    );
    expect(storyboard).toMatch(/customClass="MainViewController"/);
    expect(storyboard).toMatch(/customModule="App"/);

    expect(pbx).toMatch(/MainViewController\.swift in Sources/);
    expect(pbx).toMatch(/BabylonSlateFolderPlugin\.swift in Sources/);
  });
});
