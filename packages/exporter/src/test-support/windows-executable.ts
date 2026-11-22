import * as ResEdit from "resedit";
import { pngHeader } from "./app-icon-images";

const EN_US = { lang: 1033, codepage: 1200 };

/** A stand-in for Electron's `electron.exe`: an empty executable with one icon group and Electron's version details. */
export function electronExe(): Uint8Array {
  const exe = ResEdit.NtExecutable.createEmpty();
  const resources = ResEdit.NtExecutableResource.from(exe);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, [ResEdit.Data.RawIconItem.from(pngHeader(16), 16, 16, 32)]);
  const info = ResEdit.Resource.VersionInfo.create(1033, { fileVersionMS: 0x2c0009, fileVersionLS: 0x30000 }, [{ ...EN_US, values: {
    CompanyName: "GitHub, Inc.", FileDescription: "Electron", FileVersion: "44.9.3", InternalName: "electron.exe",
    LegalCopyright: "Copyright (C) 2015 GitHub, Inc. All rights reserved.", OriginalFilename: "electron.exe",
    ProductName: "Electron", ProductVersion: "44.9.3", SquirrelAwareVersion: "1",
  } }]);
  info.outputToResourceEntries(resources.entries);
  resources.outputResource(exe);
  return new Uint8Array(exe.generate());
}
