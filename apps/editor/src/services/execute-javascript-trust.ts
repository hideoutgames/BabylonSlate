import type { ScriptBundleEntry } from "@haptic/bridge";

/**
 * The assets whose compiled scripts carry an Execute JavaScript body, named for a message: the asset's
 * name from `nameOf` (scripts are keyed by asset guid, or by path before Play maps them), else the
 * script's class name. One name per asset, in first-script order.
 */
export function executeJavaScriptAssetNames(
  scripts: readonly ScriptBundleEntry[],
  nameOf: (assetKey: string) => string | undefined,
): string[] {
  return [...new Set(scripts.filter((script) => (script.executeJavaScriptNodes?.length ?? 0) > 0)
    .map((script) => nameOf(script.assetGuid) ?? script.className ?? script.assetGuid))];
}

/** Why Play, Simulate, Preview Build or packaging cannot run a project's Execute JavaScript. */
export function untrustedExecuteJavaScriptMessage(names: readonly string[]): string {
  return `This project is not trusted on this computer, so the Execute JavaScript in ${names.join(", ")} cannot run. `
    + "Choose Trust Project, or turn on Trust This Project in Project Settings > General, if you trust this project.";
}
