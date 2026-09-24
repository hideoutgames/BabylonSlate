import assert from "node:assert/strict";
import test from "node:test";
import { inspectAppleToolchain } from "./apple-toolchain.mjs";
import { buildManifest } from "./metadata.mjs";

const env = { DEVELOPER_DIR: "/Applications/Xcode_26.6.app/Contents/Developer" };
function runner(version = "Xcode 26.6\nBuild version 17F113\n", sdk = "26.5\n") {
  const results = new Map([
    ["xcodebuild -version", version],
    ["xcrun --sdk iphoneos --show-sdk-version", sdk],
    ["ruby -e print RUBY_VERSION", "3.3.12"],
    ["bundle --version", "Bundler version 2.5.22\n"],
    ['bundle exec ruby -e print Gem.loaded_specs.fetch("fastlane").version', "2.239.0"],
    ['bundle exec ruby -e print Gem.loaded_specs.fetch("cocoapods").version', "1.16.2"],
  ]);
  return (command, args) => {
    const key = [command, ...args].join(" ");
    if (!results.has(key)) throw new Error(`Unexpected tool invocation: ${key}`);
    return results.get(key);
  };
}

test("inspected tool versions survive the public build manifest allowlist", () => {
  const toolchains = inspectAppleToolchain({ platform: "darwin", env, run: runner() });
  const manifest = buildManifest({ version: "0.0.1", appleSequenceOffset: 0 }, {
    channel: "test", platforms: "ipados", sourceSha: "a".repeat(40), runNumber: 417, runAttempt: 1, toolchains,
  });
  assert.deepEqual(manifest.toolchains, {
    xcode: "26.6", iosSdk: "26.5", ruby: "3.3.12", bundler: "2.5.22", fastlane: "2.239.0", cocoapods: "1.16.2",
  });
});

test("inspection needs only the installed Xcode and SDK, without Ruby or signing commands", () => {
  const read = runner();
  const run = (command, args) => {
    assert.ok(command === "xcodebuild" || command === "xcrun");
    return read(command, args);
  };
  assert.deepEqual(inspectAppleToolchain({ platform: "darwin", env, run, xcodeOnly: true }), { xcode: "26.6", iosSdk: "26.5" });
});

test("distribution rejects a changed, incomplete or malformed Xcode/SDK before reading other tools", () => {
  for (const [version, sdk] of [
    ["Xcode 26.5\nBuild version 17F113", "26.5"],
    ["Xcode 26.6\nBuild version 17F999", "26.5"],
    ["Xcode 26.6", "26.5"],
    ["unexpected output", "26.5"],
    ["Xcode 26.6\nBuild version 17F113", "26.6"],
    ["Xcode 26.6\nBuild version 17F113", ""],
  ]) {
    assert.throws(() => inspectAppleToolchain({ platform: "darwin", env, run: runner(version, sdk) }), /inspect and review toolchain changes/);
  }
});

test("unsupported hosts and Xcode locations fail before any external command", () => {
  const run = () => assert.fail("must reject the host before invoking tools");
  for (const options of [
    { platform: "win32", env },
    { platform: "darwin", env: {} },
    { platform: "darwin", env: { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" } },
  ]) assert.throws(() => inspectAppleToolchain({ ...options, run }), /pinned macOS Xcode installation/);
});
