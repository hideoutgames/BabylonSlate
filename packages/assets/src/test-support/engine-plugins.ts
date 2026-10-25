import type { ProjectStorage } from "@haptic/core";
import { ASSETS_DIR, writeProjectTree } from "../hproject";
import { discoverEnginePlugins, type PluginDescriptor } from "../plugin-host";
import { inspectHplugin } from "../plugin-package";

/** Seed engine storage with a .hplugin unpacked at `folderName`, as the bundled catalog serves it. */
export async function unpackEnginePluginZip(
  storage: ProjectStorage,
  zip: Uint8Array,
  folderName: string,
): Promise<PluginDescriptor> {
  const incoming = await inspectHplugin(zip);
  await storage.mkdir(`${folderName}/${ASSETS_DIR}`, true);
  await writeProjectTree(
    storage,
    incoming.files.map((file) => ({ path: `${folderName}/${file.path}`, data: file.data })),
  );
  const unpacked = (await discoverEnginePlugins(storage)).find((plugin) => plugin.folderName === folderName);
  if (!unpacked) throw new Error(`Failed to unpack engine plugin into ${folderName}`);
  return unpacked;
}
