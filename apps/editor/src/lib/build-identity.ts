interface BuildIdentity {
  applicationVersion: string;
  channel: "test" | "release";
  windowsVersion: string;
  appleBuildNumber: string;
  sourceSha: string;
  runNumber: number;
  runAttempt: number;
}

declare const __BABYLONSLATE_BUILD__: BuildIdentity | null;

export function getBuildIdentity(): BuildIdentity | null {
  return typeof __BABYLONSLATE_BUILD__ === "undefined" ? null : __BABYLONSLATE_BUILD__;
}
