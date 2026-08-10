import type { IDockviewPanelProps } from "dockview";
import { GraphEditor } from "@babylonslate/graph";
import { createDefaultGraph } from "@babylonslate/shared";
import { useProject } from "../context/project-context";

export function GraphPanel(_props: IDockviewPanelProps) {
  void _props;
  const { projectState, updateGraph } = useProject();
  const graph = projectState?.graph ?? createDefaultGraph();

  return (
    <div className="h-full w-full">
      <GraphEditor initialGraph={graph} onChange={updateGraph} />
    </div>
  );
}
