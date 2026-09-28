import type { SourceControlService } from "../services/source-control-service";
import type { TextureWriteGuard } from "../services/project-service";

/**
 * Write guard for the background texture alignment pass
 * (`ProjectService.setTextureWriteGuard`). The pass rewrites Textures with no
 * user action, so it needs the project's locks to be known and it refuses
 * every Texture another user has locked, even one open in a tab (whose lock
 * banner, or Edit Anyway, governs only the user's own edits). `blockedReason`
 * adds the user-facing checks (read-only roots and plugins). Before a
 * re-encode, `claim` takes the Texture's lock as auto-lock on edit would, so
 * teammates do not rewrite the same Texture meanwhile.
 */
export function createTextureAlignmentGuard(options: {
  sourceControl: Pick<SourceControlService, "locksKnownFor" | "lockStateForPath" | "lockForBackgroundWrite">;
  projectGuid: string;
  pathFor: (guid: string) => string | undefined;
  blockedReason: (guid: string) => string | null;
}): TextureWriteGuard {
  const { sourceControl, projectGuid, pathFor, blockedReason } = options;
  return {
    canWrite: (guid) => {
      // Rechecked per Texture: reconfiguring source control forgets the locks
      // before the editor removes the guard.
      if (!sourceControl.locksKnownFor(projectGuid)) return false;
      const path = pathFor(guid);
      if (path !== undefined && sourceControl.lockStateForPath(path) === "theirs") return false;
      return blockedReason(guid) === null;
    },
    claim: async (guid) => {
      const path = pathFor(guid);
      return path !== undefined && (await sourceControl.lockForBackgroundWrite(path));
    },
  };
}
