import type { Camera, Scene } from "@babylonjs/core";
import { normalizeScenePostProcessStack } from "@babylonslate/core";
import type { MaterialParameterValue } from "@babylonslate/bridge";
import type { MaterialDocument } from "@babylonslate/shader-graph";
import type { MaterialLibrary } from "./material-library";

/** One authored entry of a scene's ordered post-process chain. */
export interface PostProcessStackEntry {
  id?: string;
  materialGuid: string;
  enabled: boolean;
  order: number;
  scalable?: boolean;
  parameters?: Record<string, MaterialParameterValue>;
}

/** Scene documents omit `order`; normalize fills it from array index. */
export type PostProcessStackInput = {
  id?: string;
  materialGuid: string;
  enabled?: boolean;
  order?: number;
  scalable?: boolean;
  parameters?: Record<string, MaterialParameterValue>;
};

export function normalizePostProcessStack(
  value: unknown,
): PostProcessStackEntry[] {
  if (!Array.isArray(value)) return [];
  const entries = value
    .flatMap((entry, index) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const materialGuid = record.materialGuid;
      if (typeof materialGuid !== "string" || materialGuid === "") return [];
      return [
        {
          id: record.id,
          parameters: record.parameters,
          materialGuid,
          ...(record.scalable === true ? { scalable: true } : {}),
          enabled: record.enabled !== false,
          order:
            typeof record.order === "number" && Number.isFinite(record.order)
              ? record.order
              : index,
        },
      ];
    });
  const identities = normalizeScenePostProcessStack(entries);
  return entries.map((entry, index) => ({ ...entry, parameters: identities[index]!.parameters, id: identities[index]!.id }))
    .sort((a, b) => a.order - b.order);
}

export interface AttachedPostProcessStack {
  /** Updates only this live entry's instance, without recompiling its asset. */
  setParameter: (entryId: string, name: string, value: MaterialParameterValue) => boolean;
  getParameter: (entryId: string, name: string) => MaterialParameterValue | null;
  resetParameter: (entryId: string, name: string) => boolean;
  dispose: () => void;
  /** Bounded cleanup/reporting; rejection never grants permission to release sources. */
  whenDisposed: () => Promise<void>;
  /** Actual CPU/native reference release, independent of a GPU drain boundary. */
  whenReleased: () => Promise<void>;
}

export interface PostProcessStackDiagnostic {
  message: string;
  nodeId?: string;
  materialGuid?: string;
  code?: string;
}

export interface AttachPostProcessStackOptions {
  scene: Scene;
  resolutionScale?: number;
  camera: Camera;
  library: MaterialLibrary;
  stack: readonly PostProcessStackEntry[];
  documentFor: (materialGuid: string) => MaterialDocument | null;
  onDiagnostic?: (diagnostic: PostProcessStackDiagnostic) => void;
}
