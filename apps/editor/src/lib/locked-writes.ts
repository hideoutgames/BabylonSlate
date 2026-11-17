import type { ProjectSceneWriter } from "../services/project-write-admission";
import type { SourceControlService } from "../services/source-control-service";

type LockLookup = Pick<SourceControlService, "lockedByOther">;

/**
 * Why the editor must not write `path` now: someone else holds its lock, on
 * the branch lock requests name. Edit Anyway lets the document change in the
 * editor, never the file; Save All skips it the same way.
 */
export function lockedWriteRefusal(sourceControl: LockLookup, path: string): string | null {
  const lock = sourceControl.lockedByOther(path);
  return lock ? `Locked by ${lock.ownerName}. You can't save it until they release the lock.` : null;
}

/** Rejects a write of `path` that `lockedWriteRefusal` refuses. */
export function assertWritableUnderLock(sourceControl: LockLookup, path: string): void {
  const refusal = lockedWriteRefusal(sourceControl, path);
  if (refusal) throw new Error(refusal);
}

/**
 * A Scene chunk writer (a bake outside Save All) whose writes of a Scene
 * someone else has locked reject, saying who holds it.
 */
export function refusingLockedScenes<T extends ProjectSceneWriter>(writer: T, sourceControl: LockLookup): T {
  return {
    ...writer,
    writeSceneNavmeshChunk: async (path, bytes, payload) => {
      assertWritableUnderLock(sourceControl, path);
      return writer.writeSceneNavmeshChunk(path, bytes, payload);
    },
    writeSceneAudioReverbChunk: async (path, bytes, payload) => {
      assertWritableUnderLock(sourceControl, path);
      return writer.writeSceneAudioReverbChunk(path, bytes, payload);
    },
  };
}

/**
 * Save All's Scene chunk writes (Auto Bake On Save, the audio reverb flush):
 * a path `refused` names is skipped without a word, as its document is, so an
 * Auto-Save never reports it.
 */
export function skippingRefusedScenes<T extends ProjectSceneWriter>(writer: T, refused: (path: string) => unknown): T {
  return {
    ...writer,
    writeSceneNavmeshChunk: (path, bytes, payload) =>
      refused(path) ? Promise.resolve() : writer.writeSceneNavmeshChunk(path, bytes, payload),
    writeSceneAudioReverbChunk: (path, bytes, payload) =>
      refused(path) ? Promise.resolve() : writer.writeSceneAudioReverbChunk(path, bytes, payload),
  };
}
