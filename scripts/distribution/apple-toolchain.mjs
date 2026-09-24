import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function inspectAppleToolchain({ platform = process.platform, env = process.env, run = execFileSync, xcodeOnly = false } = {}) {
  if (platform !== "darwin" || env.DEVELOPER_DIR !== "/Applications/Xcode_26.6.app/Contents/Developer") throw new Error("Distribution requires the pinned macOS Xcode installation");
  const read = (command, args) => run(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, env }).trim();
  const version = read("xcodebuild", ["-version"]);
  const xcode = version.match(/^Xcode (\S+)\s*$/m)?.[1];
  const build = version.match(/^Build version (\S+)\s*$/m)?.[1];
  const iosSdk = read("xcrun", ["--sdk", "iphoneos", "--show-sdk-version"]);
  if (xcode !== "26.6" || build !== "17F113" || iosSdk !== "26.5") throw new Error("Distribution requires Xcode 26.6 (17F113) and iOS SDK 26.5; inspect and review toolchain changes before distributing");
  if (xcodeOnly) return { xcode, iosSdk };
  const ruby = read("ruby", ["-e", "print RUBY_VERSION"]);
  const bundler = read("bundle", ["--version"]).split(" ").at(-1);
  const fastlane = read("bundle", ["exec", "ruby", "-e", 'print Gem.loaded_specs.fetch("fastlane").version']);
  const cocoapods = read("bundle", ["exec", "ruby", "-e", 'print Gem.loaded_specs.fetch("cocoapods").version']);
  return { xcode, iosSdk, ruby, bundler, fastlane, cocoapods };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--inspect-xcode")) throw new Error("Use no arguments for distribution metadata, or --inspect-xcode for credential-free inspection");
  const xcodeOnly = args[0] === "--inspect-xcode";
  if (!xcodeOnly && !process.env.APPLE_TOOLCHAIN_FILE) throw new Error("APPLE_TOOLCHAIN_FILE is required for distribution metadata");
  const toolchain = inspectAppleToolchain({ xcodeOnly });
  if (xcodeOnly) console.log(JSON.stringify(toolchain));
  else await writeFile(process.env.APPLE_TOOLCHAIN_FILE, JSON.stringify(toolchain));
}
