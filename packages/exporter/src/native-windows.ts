import * as ResEdit from "resedit";
import { encodeIco, type AppIconImages } from "./app-icon";
import { desktopGameNames, packageDesktopGame, type DesktopGamePackageInput } from "./native-desktop";

/**
 * Windows game packages. A Windows executable carries its icon and the name
 * and version its file details, Task Manager and the taskbar show as
 * resources inside the file, so the runtime's `electron.exe` is always
 * rewritten (resedit, plain JavaScript, so this runs wherever the editor
 * does): the game's name and version replace Electron's, and Electron's
 * company and copyright are removed. An App Icon replaces Electron's icon;
 * without one the executable keeps it. Electron's release executable is
 * unsigned; any signature would be dropped.
 */

export interface WindowsExecutableDetails {
  /** The App Icon; without one the executable keeps the runtime's icon. */
  icon?: AppIconImages | null;
  /** The game's name: File Description and Product Name. */
  name: string;
  /** The project version: Product Version as written, File Version as numbers. */
  version: string;
  /** The executable's file name in the package: Internal Name and Original Filename. */
  fileName: string;
}

/** `major.minor.patch.build` from a project version's leading numbers; a missing or out-of-range part is 0. */
export function windowsFileVersion(version: string): [number, number, number, number] {
  const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  const part = (index: number) => {
    const value = Number(match?.[index] ?? 0);
    return Number.isSafeInteger(value) && value <= 0xffff ? value : 0;
  };
  return [part(1), part(2), part(3), part(4)];
}

/** The executable with the game in its version details and, given an App Icon, that icon in its one icon group. */
export function brandWindowsExecutable(executable: Uint8Array, details: WindowsExecutableDetails): Uint8Array {
  const exe = ResEdit.NtExecutable.from(executable, { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(exe);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  if (groups.length !== 1 || versions.length !== 1) {
    throw new Error("The Windows player is damaged: its executable's icon or version details are missing.");
  }
  if (details.icon) {
    const group = groups[0]!;
    const icons = ResEdit.Data.IconFile.from(encodeIco(details.icon)).icons.map((item) => item.data);
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons);
  }

  const info = versions[0]!;
  const numbers = windowsFileVersion(details.version);
  for (const language of info.getAllLanguagesForStringValues()) {
    info.setFileVersion(...numbers, language.lang);
    info.setProductVersion(...numbers, language.lang);
    info.setStringValues(language, {
      FileDescription: details.name,
      ProductName: details.name,
      ProductVersion: details.version.trim() || numbers.join("."),
      InternalName: details.fileName,
      OriginalFilename: details.fileName,
    });
    // Electron's company and copyright describe the runtime, not the game.
    info.removeStringValue(language, "CompanyName");
    info.removeStringValue(language, "LegalCopyright");
  }
  info.outputToResourceEntries(resources.entries);
  resources.outputResource(exe);
  return new Uint8Array(exe.generate());
}

/** A Windows game ZIP (`packageDesktopGame`) whose executable carries the game's details, and its App Icon when it has one. */
export function packageWindowsGame(input: DesktopGamePackageInput): { fileName: string; bytes: Uint8Array } {
  if (input.target !== "windows-x64") throw new Error("Windows packages hold Windows games only.");
  const names = desktopGameNames(input.name, input.target);
  return packageDesktopGame(input, (executable) => brandWindowsExecutable(executable, {
    icon: input.icon,
    name: input.name.trim() || "Game",
    version: input.version,
    fileName: names.executable,
  }));
}
