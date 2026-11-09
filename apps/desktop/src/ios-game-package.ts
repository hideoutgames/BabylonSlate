import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSettingArguments, iosBuildSettings, iosExportOptions, iosGameFileName, iosProjectFiles, type IosPackageFormat,
} from "../../../packages/exporter/src/native-ios";
import { runCommand, type RunCommand } from "./mac-game-package";
import { copyTree, writeFiles } from "./package-files";

/**
 * Packages an iOS game in the desktop app on a Mac: copies the Xcode project
 * template, adds the game and its App Icon, archives it with xcodebuild and
 * exports an IPA, both signed by Xcode's automatic signing for the user's
 * team with the Apple account signed into Xcode (`-allowProvisioningUpdates`
 * lets Xcode make or renew the provisioning profile). Haptic never handles
 * Apple credentials; the IPA is uploaded with Apple's own tools.
 */

const XCODEBUILD = "/usr/bin/xcodebuild";
/** Xcode 16 names the export methods `app-store-connect` and `debugging`. */
const MIN_XCODE = 16;

export interface IosGamePackageRequest {
  game: [string, Uint8Array][];
  name: string;
  appId: string;
  version: string;
  buildNumber: number;
  format: IosPackageFormat;
  /** The App Icon as an opaque 1024 px PNG, or null. */
  icon: Uint8Array | null;
  teamId: string;
}

/** Xcode's version (`26.6`), or why iOS games cannot be built on this Mac. */
export async function findXcode(run: RunCommand = runCommand): Promise<{ version: string | null; problems: string[] }> {
  let version: string | null = null;
  try {
    const { stdout } = await run(XCODEBUILD, ["-version"]);
    version = /^Xcode (\d+(?:\.\d+)*)/m.exec(stdout)?.[1] ?? null;
  } catch {
    // Only the Command Line Tools, or no developer tools at all.
  }
  if (!version) return { version: null, problems: ["Install Xcode from the App Store and open it once to finish setting it up."] };
  if (Number(version.split(".")[0]) < MIN_XCODE) {
    return { version, problems: [`Xcode ${version} is too old; iOS games need Xcode ${MIN_XCODE} or later.`] };
  }
  try {
    await run("/usr/bin/xcrun", ["--sdk", "iphoneos", "--show-sdk-version"]);
  } catch {
    return { version, problems: ["Add the iOS platform in Xcode > Settings > Components."] };
  }
  return { version, problems: [] };
}

/** The errors in a failed xcodebuild run's output: its `error:` lines, else its last lines. */
export function xcodeFailure(output: string): string {
  const errors = [...new Set(output.split("\n").map((line) => line.trim()).filter((line) => /\berror:/.test(line)))].slice(0, 5);
  const text = (errors.length > 0 ? errors.join(" ") : output.trim().split("\n").slice(-10).join(" ")).replace(/\s+/g, " ").trim();
  return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}

/** The Xcode project for one package in `project`: the template, the game and its icon. Returns xcodebuild's build settings. */
export async function writeIosProject(project: string, request: IosGamePackageRequest, templateRoot: string): Promise<Record<string, string>> {
  // Identity is checked before any file is written.
  const settings = iosBuildSettings({ ...request, hasIcon: request.icon !== null });
  if (request.format === "app-store" && !request.icon) throw new Error("The App Store needs an app icon. Set the App Icon in Project Settings > Export.");
  const files = iosProjectFiles({ game: request.game, icon: request.icon });
  await copyTree(templateRoot, project);
  await writeFiles(project, files);
  return settings;
}

export async function packageIosGame(options: {
  request: IosGamePackageRequest;
  /** The Xcode project template (`apps/desktop/ios-game`). */
  templateRoot: string;
  run?: RunCommand;
}): Promise<{ fileName: string; bytes: Uint8Array }> {
  const { request } = options;
  const run = options.run ?? runCommand;
  const work = await mkdtemp(join(tmpdir(), "haptic-ios-"));
  try {
    const project = join(work, "project");
    const settings = await writeIosProject(project, request, options.templateRoot);
    const { problems } = await findXcode(run);
    if (problems.length > 0) throw new Error(problems.join(" "));

    const archive = join(work, "HapticGame.xcarchive");
    try {
      await run(XCODEBUILD, [
        "-project", join(project, "HapticGame.xcodeproj"), "-scheme", "HapticGame", "-configuration", "Release",
        "-destination", "generic/platform=iOS", "-archivePath", archive, "-allowProvisioningUpdates", "archive", ...buildSettingArguments(settings),
      ]);
    } catch (error) {
      throw new Error(`Xcode could not build the game: ${xcodeFailure(error instanceof Error ? error.message : String(error))}`, { cause: error });
    }
    const exportOptions = join(work, "export-options.plist");
    await writeFile(exportOptions, iosExportOptions(request.format, request.teamId));
    const exported = join(work, "export");
    try {
      await run(XCODEBUILD, ["-exportArchive", "-archivePath", archive, "-exportPath", exported, "-exportOptionsPlist", exportOptions, "-allowProvisioningUpdates"]);
    } catch (error) {
      throw new Error(`Xcode could not sign the game: ${xcodeFailure(error instanceof Error ? error.message : String(error))}`, { cause: error });
    }
    const ipa = (await readdir(exported)).find((name) => name.endsWith(".ipa"));
    if (!ipa) throw new Error("Xcode exported no app.");
    return { fileName: iosGameFileName(request.name, request.format), bytes: new Uint8Array(await readFile(join(exported, ipa))) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
