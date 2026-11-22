/**
 * Why a node needs a trusted project (Workspace Trust). In a project this computer does not trust,
 * Play, Simulate, Preview Build and packaging refuse a script whose compiled code holds such a node.
 * - `executeJavaScript`: Execute JavaScript with a body, whose code runs unsandboxed.
 * - `openUrl`: Open URL, which opens any web address the graph builds.
 * - `extension`: a node an Extension contributes, which calls that Extension's game code.
 */
export type TrustGateKind = "executeJavaScript" | "openUrl" | "extension";

/** One node of a compiled script that only a trusted project may run (`NodeDefinition.trustGate`). */
export interface TrustGatedNode {
  nodeId: string;
  kind: TrustGateKind;
  /** The node's display name (`Execute JavaScript`, `Open URL`, an Extension node's title), for the refusal. */
  title: string;
}
