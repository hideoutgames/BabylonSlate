import type { ScriptBundleEntry } from "@babylonslate/bridge";

export type ConcatenatedScripts = {
  source: string;
  scripts: ScriptBundleEntry[];
};

function sourceUrlLine(assetGuid: string): string {
  return `//# sourceURL=babylonslate:///${assetGuid}.js\n`;
}

export function concatenateScripts(
  scripts: readonly ScriptBundleEntry[],
): ConcatenatedScripts {
  const parts: string[] = [];
  const rewritten: ScriptBundleEntry[] = [];
  let lineOffset = 0;
  for (const script of scripts) {
    const prefix = sourceUrlLine(script.assetGuid);
    const prefixLines = prefix.split("\n").length - 1;
    parts.push(prefix, script.source);
    rewritten.push({
      ...script,
      anchors: script.anchors.map((anchor) => ({
        ...anchor,
        line: anchor.line + lineOffset + prefixLines,
      })),
    });
    const chunk = prefix + script.source;
    lineOffset += chunk.split("\n").length - (chunk.endsWith("\n") ? 1 : 0);
  }
  return { source: parts.join(""), scripts: rewritten };
}

export function serializeScriptRegistry(scripts: readonly ScriptBundleEntry[]): string {
  return `globalThis.__babylonslateScripts = ${JSON.stringify(scripts)};\n`;
}

export function parseScriptRegistry(source: string): ScriptBundleEntry[] {
  const match = source.match(/globalThis\.__babylonslateScripts = ([\s\S]*);\s*$/);
  if (!match?.[1]) return [];
  return JSON.parse(match[1]) as ScriptBundleEntry[];
}
