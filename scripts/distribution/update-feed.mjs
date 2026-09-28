import { createHash } from "node:crypto";
import { parse } from "yaml";

const feedNames = { windows: "latest.yml", macos: "latest-mac.yml", linux: "latest-linux.yml" };

export function validateUpdateFeed(platform, version, files) {
  const feedName = feedNames[platform];
  if (!feedName || !files.has(feedName)) throw new Error(`${platform} update metadata does not match packaged files`);
  const metadata = parse(files.get(feedName).toString("utf8"));
  const entries = metadata?.files;
  const required = platform === "windows"
    ? [`BabylonSlate-${version}-x64.exe`]
    : platform === "macos"
      ? ["arm64", "x64"].map(arch => `BabylonSlate-${version}-${arch}.zip`)
      : [`BabylonSlate-${version}-x64.AppImage`];
  const validEntry = entry => {
    const bytes = files.get(entry?.url);
    return bytes && entry.sha512 === createHash("sha512").update(bytes).digest("base64") && entry.size === bytes.length;
  };
  const pathEntry = metadata?.path === undefined ? undefined : entries?.find(entry => entry.url === metadata.path);
  const shaEntry = metadata?.sha512 === undefined ? undefined : entries?.find(entry => entry.sha512 === metadata.sha512);
  if (metadata?.version !== version || !Array.isArray(entries) || entries.length === 0 || !entries.every(validEntry) ||
      !required.every(name => entries.some(entry => entry.url === name)) ||
      (metadata.path !== undefined && !pathEntry) ||
      (metadata.sha512 !== undefined && (!shaEntry || (pathEntry && shaEntry !== pathEntry)))) {
    throw new Error(`${platform} update metadata does not match packaged files`);
  }
}
