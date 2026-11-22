import type { TrustGateKind } from "@haptic/core";
import type { ScriptBundleEntry } from "@haptic/bridge";

/** Trust-gated nodes of one display name (`Execute JavaScript`, `Open URL`, an Extension node's title) and the assets holding them. */
export interface TrustGateFinding {
  title: string;
  assets: string[];
}

const KIND_ORDER: readonly TrustGateKind[] = ["executeJavaScript", "openUrl", "extension"];

/**
 * What a set of compiled scripts holds that only a trusted project may run, read from the compiler's
 * record (no graph is scanned): one finding per node display name, Execute JavaScript first, then
 * Open URL, then Extension nodes by title. Each names its assets by `nameOf` (scripts are keyed by
 * asset guid, or by path before Play maps them), else by the script's class name, in first-script order.
 */
export function trustGateFindings(
  scripts: readonly ScriptBundleEntry[],
  nameOf: (assetKey: string) => string | undefined,
): TrustGateFinding[] {
  const found = new Map<string, { kind: TrustGateKind; assets: Set<string> }>();
  for (const script of scripts) {
    for (const node of script.trustGatedNodes ?? []) {
      const entry = found.get(node.title) ?? { kind: node.kind, assets: new Set<string>() };
      entry.assets.add(nameOf(script.assetGuid) ?? script.className ?? script.assetGuid);
      found.set(node.title, entry);
    }
  }
  return [...found].sort(([a, left], [b, right]) =>
    KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) || a.localeCompare(b))
    .map(([title, { assets }]) => ({ title, assets: [...assets] }));
}

/** `A`, `A and B`, `A, B and C`. */
function listed(parts: readonly string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "";
}

/** Why Play, Simulate, Preview Build or packaging cannot run a project's trust-gated nodes: one message naming every kind found. */
export function untrustedNodesMessage(findings: readonly TrustGateFinding[]): string {
  const found = listed(findings.map((finding) => `the ${finding.title} in ${finding.assets.join(", ")}`));
  return `This project is not trusted on this computer, so ${found} cannot run. `
    + "Choose Trust Project, or turn on Trust This Project in Project Settings > General, if you trust this project.";
}
