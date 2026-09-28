import { createIdentity } from "./contract.mjs";
import { validatePatchNotes } from "./changelog.mjs";

const manifestPlatforms = ["windows", "macos", "linux", "android", "ipados"];

export function buildManifest(declared, request) {
  if (!manifestPlatforms.includes(request.platform)) throw new Error("A supported manifest platform is required");
  if (request.macosSigned !== undefined && (request.platform !== "macos" || typeof request.macosSigned !== "boolean")) throw new Error("macosSigned is valid only for macOS manifests");
  const toolchains = {};
  for (const key of ["node", "pnpm", "electron", "xcode", "iosSdk", "ruby", "bundler", "fastlane", "cocoapods", "jdk", "gradle", "androidSdk"]) {
    const value = request.toolchains?.[key];
    if (value !== undefined) {
      if (typeof value !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(value)) throw new Error("Toolchain versions must be numeric");
      toolchains[key] = value;
    }
  }
  const patchNotes = request.channel === "release" || request.patchNotes
    ? validatePatchNotes(request.patchNotes, declared.version) : undefined;
  return {
    ...createIdentity({ ...request, version: declared.version, declaredVersion: declared.version, appleSequenceOffset: declared.appleSequenceOffset }),
    ...(patchNotes ? { patchNotes } : {}),
    toolchains,
    platform: request.platform,
    ...(request.macosSigned !== undefined ? { macosSigned: request.macosSigned } : {}),
  };
}
