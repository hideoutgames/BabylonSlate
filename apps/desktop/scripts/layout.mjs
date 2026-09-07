import { access, cp, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function stageRenderer(source, destination) {
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || /^(?:\.|node_modules$)/.test(entry.name) || /\.(?:p8|p12|pem|key|mobileprovision|ipa|xcarchive|keychain-db|log|map)$/i.test(entry.name)) {
        throw new Error("Forbidden private file or symlink in renderer output");
      }
      if (entry.isDirectory()) await inspect(join(directory, entry.name));
    }
  }
  await inspect(source);
  for (const required of ["index.html", "player/index.html", "build-manifest.json", "engine-plugins", "assets"]) await access(join(source, required));
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}
