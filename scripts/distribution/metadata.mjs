import { createIdentity } from "./contract.mjs";

export function buildManifest(declared, request) {
  const toolchains = {};
  for (const key of ["node", "pnpm", "electron", "xcode", "iosSdk", "ruby", "bundler", "fastlane", "cocoapods"]) {
    const value = request.toolchains?.[key];
    if (value !== undefined) {
      if (typeof value !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(value)) throw new Error("Toolchain versions must be numeric");
      toolchains[key] = value;
    }
  }
  return { ...createIdentity({ ...request, version: declared.version, declaredVersion: declared.version, appleSequenceOffset: declared.appleSequenceOffset }), toolchains };
}
