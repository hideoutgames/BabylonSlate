import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const vfsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(vfsDir, "../../..");
const pkg = JSON.parse(
  readFileSync(join(vfsDir, "../package.json"), "utf8"),
) as { dependencies: Record<string, string> };

describe("Capacitor 8 iOS host", () => {
  it("keeps scoped-storage on Capacitor 8", () => {
    expect(pkg.dependencies["@capacitor/core"]).toMatch(/^\^8/);
    expect(pkg.dependencies["@daniele-rolli/capacitor-scoped-storage"]).toBe(
      "^0.0.3",
    );
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
    const cap = JSON.parse(
      readFileSync(
        join(repoRoot, "apps/editor/ios/App/App/capacitor.config.json"),
        "utf8",
      ),
    ) as { packageClassList?: string[] };
    expect(cap.packageClassList).toContain("BabylonSlateSecretsPlugin");
  });
});
