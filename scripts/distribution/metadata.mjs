import { createIdentity } from "./contract.mjs";
import { validatePatchNotes } from "./changelog.mjs";

const manifestPlatforms = ["windows", "macos", "linux", "android", "ipados"];
/** Desktop packages say whether they are code-signed; the app enables automatic updates only for signed packages. */
export const desktopManifestPlatforms = ["windows", "macos", "linux"];

export function buildManifest(declared, request) {
  if (!manifestPlatforms.includes(request.platform)) throw new Error("A supported manifest platform is required");
  if (desktopManifestPlatforms.includes(request.platform) ? typeof request.signed !== "boolean" : request.signed !== undefined) {
    throw new Error("signed is required for desktop manifests and valid only for them");
  }
  const toolchains = {};
  for (const key of ["node", "pnpm", "electron", "xcode", "iosSdk", "ruby", "bundler", "fastlane", "cocoapods", "jdk", "gradle", "androidSdk"]) {
    const value = request.toolchains?.[key];
    if (value !== undefined) {
      if (typeof value !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(value)) throw new Error("Toolchain versions must be numeric");
      toolchains[key] = value;
    }
  }
  return {
    ...createIdentity({ ...request, version: declared.version, declaredVersion: declared.version, appleSequenceOffset: declared.appleSequenceOffset }),
    patchNotes: validatePatchNotes(request.patchNotes, declared.version),
    toolchains,
    platform: request.platform,
    ...(request.signed !== undefined ? { signed: request.signed } : {}),
  };
}
