import type { DesktopGamePackageInput } from "./native-desktop";

/** Which package a desktop packaging request makes: a Windows ZIP, a Linux ZIP or a Linux `.deb`. */
export type DesktopPackageKind = "windows-zip" | "linux-zip" | "linux-deb";

export interface DesktopPackageRequest {
  kind: DesktopPackageKind;
  input: DesktopGamePackageInput;
}

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
export async function runDesktopPackage({ kind, input }: DesktopPackageRequest): Promise<DesktopPackageResult> {
  switch (kind) {
    case "windows-zip":
      return (await import("./native-windows")).packageWindowsGame(input);
    case "linux-zip":
      return (await import("./native-desktop")).packageDesktopGame(input);
    case "linux-deb":
      return (await import("./native-deb")).packageLinuxDeb(input);
  }
}
