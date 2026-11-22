import type { TrustGateKind } from "@haptic/core";
import type { ScriptBundleEntry } from "@haptic/bridge";

/**
 * Trust-gated nodes of one kind and display name (`Execute JavaScript`, `Open URL`, an Extension
 * node's title) and the assets holding them. Keyed by both, so an Extension node titled like a
 * built-in node stays its own finding.
 */
export interface TrustGateFinding {
  kind: TrustGateKind;
  title: string;
  assets: string[];
}

const KIND_ORDER: readonly TrustGateKind[] = ["executeJavaScript", "openUrl", "extension"];

/** The key a finding merges under: its kind and title together. */
export function trustGateFindingKey(finding: Pick<TrustGateFinding, "kind" | "title">): string {
  return `${finding.kind}\n${finding.title}`;
}

/** Orders findings: Execute JavaScript, then Open URL, then Extension nodes, each by title. */
export function compareTrustGateFindings(a: Pick<TrustGateFinding, "kind" | "title">, b: Pick<TrustGateFinding, "kind" | "title">): number {
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.title.localeCompare(b.title);
}

/**
 * What a set of compiled scripts holds that only a trusted project may run, read from the compiler's
 * record (no graph is scanned): one finding per node kind and display name, in `compareTrustGateFindings`
 * order. Each names its assets by `nameOf` (scripts are keyed by asset guid, or by path before Play
 * maps them), else by the script's class name, in first-script order.
 */
export function trustGateFindings(
  scripts: readonly ScriptBundleEntry[],
  nameOf: (assetKey: string) => string | undefined,
): TrustGateFinding[] {
  const found = new Map<string, { kind: TrustGateKind; title: string; assets: Set<string> }>();
  for (const script of scripts) {
    for (const node of script.trustGatedNodes ?? []) {
      const key = trustGateFindingKey(node);
      const entry = found.get(key) ?? { kind: node.kind, title: node.title, assets: new Set<string>() };
      entry.assets.add(nameOf(script.assetGuid) ?? script.className ?? script.assetGuid);
      found.set(key, entry);
    }
  }
  return [...found.values()].sort(compareTrustGateFindings)
    .map(({ kind, title, assets }) => ({ kind, title, assets: [...assets] }));
}

/** `A`, `A and B`, `A, B and C`. */
function listed(parts: readonly string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "";
}

/**
 * How a finding's node is named to the user: its title, or for an Extension node `Extension node <title>`,
 * so an Extension node cannot pass as a built-in node by its title.
 */
export function trustGateNodeLabel(finding: Pick<TrustGateFinding, "kind" | "title">): string {
  return finding.kind === "extension" ? `Extension node ${finding.title}` : finding.title;
}

/**
 * Why Play, Simulate, Preview Build or packaging cannot run a project's trust-gated nodes: one message
 * naming every finding with its assets; several findings are separated by semicolons.
 */
export function untrustedNodesMessage(findings: readonly TrustGateFinding[]): string {
  const found = findings.map((finding) => `the ${trustGateNodeLabel(finding)} in ${listed(finding.assets)}`).join("; ");
  return `This project is not trusted on this computer, so ${found} cannot run. `
    + "Choose Trust Project, or turn on Trust This Project in Project Settings > General, if you trust this project.";
}
