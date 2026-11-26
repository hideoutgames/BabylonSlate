import type { DesktopGamePackageInput } from "./native-desktop";

/** Which package a background packaging request makes: a Windows ZIP, a Linux ZIP, a Linux `.deb`, or a Web ZIP. */
export type DesktopPackageKind = "windows-zip" | "linux-zip" | "linux-deb" | "web-zip";

export interface WebZipPackageInput {
  files: ReadonlyMap<string, Uint8Array>;
  fileName: string;
}

export type DesktopPackageRequest =
  | { kind: "windows-zip" | "linux-zip" | "linux-deb"; input: DesktopGamePackageInput }
  | { kind: "web-zip"; input: WebZipPackageInput };

export interface DesktopPackageResult {
  fileName: string;
  bytes: Uint8Array;
}

export type DesktopPackageReply =
  | { ok: true; fileName: string; bytes: Uint8Array }
  | { ok: false; error: string };

/**
 * Makes the package, on the worker or in-process. Each packager is imported
 * when asked for, so a request loads only the code it runs.
 */
export async function runDesktopPackage(request: DesktopPackageRequest): Promise<DesktopPackageResult> {
  switch (request.kind) {
    case "windows-zip":
      return (await import("./native-windows")).packageWindowsGame(request.input);
    case "linux-zip":
      return (await import("./native-desktop")).packageDesktopGame(request.input);
    case "linux-deb":
      return (await import("./native-deb")).packageLinuxDeb(request.input);
    case "web-zip": {
      const { zipFileMap } = await import("./export-game");
      return { fileName: request.input.fileName, bytes: zipFileMap(request.input.files) };
    }
  }
}
