import { access, cp, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const markerNames = new Set([".nojekyll", ".keep", ".gitkeep"]);

export async function stageRenderer(source, destination) {
  const skippedMarkers = new Set();
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isFile() && markerNames.has(entry.name)) {
        skippedMarkers.add(path);
        continue;
      }
      if (entry.isSymbolicLink() || /^(?:\.|node_modules$)/.test(entry.name) || /\.(?:p8|p12|pem|key|mobileprovision|ipa|xcarchive|keychain-db|log|map)$/i.test(entry.name)) {
        const projectPath = relative(source, path).replaceAll("\\", "/");
        throw new Error(`Forbidden private file or symlink in renderer output: ${projectPath}`);
      }
      if (entry.isDirectory()) await inspect(path);
    }
  }
  await inspect(source);
  for (const required of ["index.html", "player/index.html", "build-manifest.json", "engine-plugins", "assets"]) await access(join(source, required));
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false, filter: candidate => !skippedMarkers.has(candidate) });
}
