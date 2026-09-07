import { createHash } from "node:crypto";

export function validateAppIcon(bytes) {
  const placeholder = "29e4777e319de3ee5a52c3a8004ec19d0568414004257e36d7c94a077d71c93b";
  if (bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.readUInt32BE(16) !== 1024 || bytes.readUInt32BE(20) !== 1024 || ![0, 2].includes(bytes[25]) || createHash("sha256").update(bytes).digest("hex") === placeholder) throw new Error("Supply a real opaque 1024x1024 BabylonSlate PNG app icon; the Capacitor placeholder is not distributable");
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.subarray(offset + 4, offset + 8).toString("ascii") === "tRNS") throw new Error("App icon must not contain transparency");
    offset += length + 12;
  }
}

export function validatePrivacyManifest(privacy) {
  const reasons = new Map((privacy.NSPrivacyAccessedAPITypes ?? []).map(item => [item.NSPrivacyAccessedAPIType, item.NSPrivacyAccessedAPITypeReasons]));
  if (!reasons.get("NSPrivacyAccessedAPICategoryUserDefaults")?.includes("CA92.1") || !["C617.1", "3B52.1"].every(reason => reasons.get("NSPrivacyAccessedAPICategoryFileTimestamp")?.includes(reason)) || privacy.NSPrivacyTracking !== false || !Array.isArray(privacy.NSPrivacyCollectedDataTypes)) throw new Error("Native privacy declarations must cover app preferences, bookmarks and project timestamps");
}
