import type { Engine } from "@babylonjs/core";
import {
  createAppEngine,
  releaseResourceCacheForEngine,
} from "@babylonslate/render";
import { isUsableEngine } from "./shared-engine-generation";

export type ProjectEngineSession = {
  engine: Engine;
  dispose: () => void;
};

export type ProjectEngineController = {
  sync: (projectOpen: boolean) => Engine | null;
  dispose: () => void;
};

/** Hidden constructor canvas + Engine for one open project. */
export function createProjectEngineSession(): ProjectEngineSession | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  canvas.style.display = "none";
  canvas.setAttribute("aria-hidden", "true");
  canvas.setAttribute("data-testid", "project-engine-canvas");
  document.body.appendChild(canvas);
  try {
    const engine = createAppEngine(canvas);
    return {
      engine,
      dispose() {
        if (!engine.isDisposed) {
          releaseResourceCacheForEngine(engine);
          engine.dispose();
        }
        canvas.remove();
      },
    };
  } catch {
    canvas.remove();
    return null;
  }
}

/** Create once while a project is open; dispose on close. */
export function createProjectEngineController(): ProjectEngineController {
  let session: ProjectEngineSession | null = null;
  const drop = () => {
    session?.dispose();
    session = null;
  };
  return {
    sync(projectOpen: boolean) {
      if (!projectOpen) {
        drop();
        return null;
      }
      if (session && isUsableEngine(session.engine)) return session.engine;
      drop();
      session = createProjectEngineSession();
      return session?.engine ?? null;
    },
    dispose: drop,
  };
}
