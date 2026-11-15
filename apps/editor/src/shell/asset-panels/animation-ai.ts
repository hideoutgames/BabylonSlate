// One lazily loaded panel family (`panel-registry.tsx`): Animation Graph, Blend Space, Behaviour Tree and Blackboard windows,
// and the Diff window's State Machine and Behaviour Tree canvases (`diff-graph-view.tsx`).
export {
  AnimGraphDetailsPanel,
  AnimGraphGraphPanel,
  AnimGraphVariablesPanel,
  AnimObjectGraphPanel,
  AnimStateGraphPanel,
} from "../../components/anim-graph-editor";
export { AnimStateMachineDiffCanvas } from "../../components/anim-graph-diff-canvas";
export { AnimGraphPreviewPanel, AnimGraphPreviewValuesPanel } from "../../components/anim-graph-preview";
export { BlendSpaceAnimationsPanel, BlendSpaceDetailsPanel, BlendSpaceGridPanel } from "../../components/blend-space-editor";
export { BlendSpacePreviewPanel } from "../../components/blend-space-preview";
export { BehaviourTreeBlackboardPanel, BehaviourTreeCompilerResultsPanel, BehaviourTreeDetailsPanel, BehaviourTreeGraphPanel } from "../../components/behaviour-tree-editor";
export { BehaviourTreeDiffCanvas } from "../../components/behaviour-tree-diff-canvas";
export { BlackboardInspectorPanel, BlackboardKeysPanel } from "../../components/blackboard-editor";
