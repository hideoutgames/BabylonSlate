import { describe, expect, it } from "vitest";
import type { PluginOption, UserConfig, UserConfigExport } from "vite";
import playerConfig from "../player/vite.config";
import editorConfig from "./vite.config";

/**
 * The plugins that ship each physics and navigation wasm once per build. A build
 * that drops one still works, but carries a copy of that wasm in every bundle that
 * loads it (Recast's and Rapier's base64 copies, Havok's 2 MB fallback), so only
 * this check fails. Names are the plugins' own; renaming one is a decision to update here.
 */
const HOSTED_WASM_PLUGINS = ["havok-hosted-wasm", "rapier-hosted-wasm", "recast-hosted-wasm"];

async function buildConfig(config: UserConfigExport): Promise<UserConfig> {
  return typeof config === "function" ? config({ command: "build", mode: "production" }) : config;
}

async function pluginNames(options: PluginOption[] | undefined): Promise<string[]> {
  const names: string[] = [];
  for (const option of options ?? []) {
    const plugin = await option;
    if (Array.isArray(plugin)) names.push(...(await pluginNames(plugin)));
    else if (plugin) names.push(plugin.name);
  }
  return names;
}

describe.each([
  ["editor", editorConfig],
  ["player", playerConfig],
])("the %s build", (_app, config) => {
  it("ships each hosted wasm once from its page bundles", async () => {
    expect(await pluginNames((await buildConfig(config)).plugins)).toEqual(expect.arrayContaining(HOSTED_WASM_PLUGINS));
  });

  it("ships each hosted wasm once from its worker bundles", async () => {
    const workerPlugins = (await buildConfig(config)).worker?.plugins;
    expect(await pluginNames(workerPlugins?.())).toEqual(expect.arrayContaining(HOSTED_WASM_PLUGINS));
  });
});
