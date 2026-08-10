import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { DockviewApi } from "dockview";
import type { SerializedGraph } from "@babylonslate/shared";
import { createStorage } from "@babylonslate/storage";
import {
  ProjectService,
  type ProjectState,
} from "../services/project-service";

interface ProjectContextValue {
  projectState: ProjectState | null;
  projectName: string | null;
  openProject: () => Promise<void>;
  saveProject: () => Promise<void>;
  updateGraph: (graph: SerializedGraph) => void;
  setDockviewApi: (api: DockviewApi) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const service = useMemo(() => new ProjectService(createStorage()), []);
  const [projectState, setProjectState] = useState<ProjectState | null>(null);
  const [dockviewApi, setDockviewApi] = useState<DockviewApi | null>(null);

  const openProject = useCallback(async () => {
    const state = await service.openProject();
    setProjectState(state);
    if (state.layout && dockviewApi) {
      service.restoreLayout(dockviewApi, state.layout);
    }
  }, [dockviewApi, service]);

  const saveProject = useCallback(async () => {
    if (!projectState) return;
    const layout = dockviewApi ? service.captureLayout(dockviewApi) : null;
    await service.saveProject({ ...projectState, layout });
    setProjectState({ ...projectState, layout });
  }, [dockviewApi, projectState, service]);

  const updateGraph = useCallback((graph: SerializedGraph) => {
    setProjectState((current) => (current ? { ...current, graph } : current));
  }, []);

  const value = useMemo<ProjectContextValue>(
    () => ({
      projectState,
      projectName: projectState?.document.metadata.name ?? null,
      openProject,
      saveProject,
      updateGraph,
      setDockviewApi,
    }),
    [openProject, projectState, saveProject, updateGraph],
  );

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error("useProject must be used within ProjectProvider");
  }
  return context;
}
