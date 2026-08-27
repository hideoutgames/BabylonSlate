import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { GizmoTool } from "@babylonslate/render";

export type ModelColliderGizmoTool = Exclude<GizmoTool, "none">;

export type ModelColliderSessionValue = {
  selectedColliderId: string | null;
  setSelectedColliderId: (id: string | null) => void;
  showCollision: boolean;
  setShowCollision: (value: boolean) => void;
  gizmoTool: ModelColliderGizmoTool;
  setGizmoTool: (tool: ModelColliderGizmoTool) => void;
};

const ModelColliderSessionContext = createContext<ModelColliderSessionValue>({
  selectedColliderId: null,
  setSelectedColliderId: () => {},
  showCollision: true,
  setShowCollision: () => {},
  gizmoTool: "translate",
  setGizmoTool: () => {},
});

export function ModelColliderSessionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [selectedColliderId, setSelectedColliderId] = useState<string | null>(
    null,
  );
  const [showCollision, setShowCollision] = useState(true);
  const [gizmoTool, setGizmoTool] =
    useState<ModelColliderGizmoTool>("translate");
  const value = useMemo(
    (): ModelColliderSessionValue => ({
      selectedColliderId,
      setSelectedColliderId,
      showCollision,
      setShowCollision,
      gizmoTool,
      setGizmoTool,
    }),
    [gizmoTool, selectedColliderId, showCollision],
  );
  return (
    <ModelColliderSessionContext.Provider value={value}>
      {children}
    </ModelColliderSessionContext.Provider>
  );
}

export function useModelColliderSession(): ModelColliderSessionValue {
  return useContext(ModelColliderSessionContext);
}
