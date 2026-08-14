import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { NavMeshGenerateSettings } from "@babylonslate/navigation";
import { useDocuments } from "./document-context";
import { useDocumentWorkspace } from "./document-workspace-context";
import { NavBakeDialog } from "../components/nav-bake-dialog";
import {
  runNavBake,
  waitPaintedFrame,
  type NavBakeGeometry,
  type NavBakePhase,
} from "../lib/nav-bake";
import { navBakeTilemapChains } from "../lib/nav-bake-tilemaps";
import { createNavBakeWorker } from "../services/nav-bake-worker-host";
import {
  parseNavMeshActorSettings,
  parseNavMeshSettings,
} from "@babylonslate/navigation";
import type { NavBakeCollectExtras } from "@babylonslate/render";
import type { SerializedScene } from "@babylonslate/core";

export type NavBakeCollector = (
  extras?: NavBakeCollectExtras,
) => NavBakeGeometry;

export type NavBakeContextValue = {
  registerCollector: (collector: NavBakeCollector | null) => void;
  startBake: (properties: Record<string, unknown>) => Promise<void>;
  lastBytes: Uint8Array | null;
  baking: boolean;
};

/* eslint-disable react-refresh/only-export-components -- context module */

const NavBakeContext = createContext<NavBakeContextValue | null>(null);

export function NavBakeProvider({ children }: { children: ReactNode }) {
  const {
    openDocuments,
    writeSceneNavmeshChunk,
    collectPlayTilemapContent,
    projectDocument,
  } = useDocuments();
  const { documentId } = useDocumentWorkspace();
  const collectorRef = useRef<NavBakeCollector | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<NavBakePhase | null>(null);
  const [cancellable, setCancellable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastBytes, setLastBytes] = useState<Uint8Array | null>(null);

  const registerCollector = useCallback((collector: NavBakeCollector | null) => {
    collectorRef.current = collector;
  }, []);

  const startBake = useCallback(
    async (properties: Record<string, unknown>) => {
      const doc = openDocuments.find((entry) => entry.id === documentId);
      if (!doc || doc.ref.kind !== "scene" || !doc.content) {
        throw new Error("Open a scene before baking a navmesh.");
      }
      const parsed = parseNavMeshActorSettings(properties);
      const settings: NavMeshGenerateSettings = {
        ...parseNavMeshSettings(properties),
        supportDynamicObstacles: parsed.supportDynamicObstacles,
      };
      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setPhase("showing");
      setCancellable(false);
      const worker = createNavBakeWorker();
      try {
        const bytes = await runNavBake({
          waitPaintedFrame,
          collect: async () => {
            const scene = doc.content as SerializedScene;
            let extras: NavBakeCollectExtras | undefined;
            if (scene.viewportMode === "2d") {
              const { tilemaps, tilesets } =
                await collectPlayTilemapContent(scene);
              extras = {
                tilemapChains: navBakeTilemapChains(
                  tilemaps,
                  tilesets,
                  projectDocument?.settings.twoD.pixelsPerUnit ?? 100,
                ),
              };
            }
            return (
              collectorRef.current?.(extras) ?? { positions: [], indices: [] }
            );
          },
          generate: (input) => worker.generate(input),
          write: async (next) => {
            await writeSceneNavmeshChunk(
              doc.ref.path,
              next,
              doc.content as Record<string, unknown>,
            );
            setLastBytes(next);
          },
          settings,
          onPhase: (next) => {
            setPhase(next);
            setCancellable(next === "generating");
          },
          signal: controller.signal,
        });
        setLastBytes(bytes);
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : String(caught);
        if (!controller.signal.aborted && !/abort/i.test(message)) {
          setError(message);
        }
      } finally {
        worker.terminate();
        abortRef.current = null;
        setPhase(null);
        setCancellable(false);
      }
    },
    [collectPlayTilemapContent, documentId, openDocuments, projectDocument, writeSceneNavmeshChunk],
  );

  const value = useMemo(
    () => ({
      registerCollector,
      startBake,
      lastBytes,
      baking: phase !== null,
    }),
    [lastBytes, phase, registerCollector, startBake],
  );

  return (
    <NavBakeContext.Provider value={value}>
      {children}
      {phase ? (
        <NavBakeDialog
          open
          phase={phase}
          cancellable={cancellable}
          error={error}
          onCancel={() => abortRef.current?.abort()}
        />
      ) : null}
    </NavBakeContext.Provider>
  );
}

export function useNavBake(): NavBakeContextValue {
  const context = useContext(NavBakeContext);
  if (!context) {
    throw new Error("useNavBake must be used within NavBakeProvider");
  }
  return context;
}

export function useOptionalNavBake(): NavBakeContextValue | null {
  return useContext(NavBakeContext);
}
