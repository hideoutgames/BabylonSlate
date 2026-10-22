interface BuildIdentity {
  applicationVersion: string;
  channel: "test" | "release";
  packageVersion: string;
  androidVersionCode: number;
  appleBuildNumber: string;
  sourceSha: string;
  runNumber: number;
  runAttempt: number;
}

declare const __HAPTIC_BUILD__: BuildIdentity | null;
declare const __HAPTIC_BUILD_LABEL__: string;

export function getBuildLabel(): string {
  return __HAPTIC_BUILD_LABEL__;
}

export function getBuildIdentity(): BuildIdentity | null {
  return typeof __HAPTIC_BUILD__ === "undefined" ? null : __HAPTIC_BUILD__;
}
