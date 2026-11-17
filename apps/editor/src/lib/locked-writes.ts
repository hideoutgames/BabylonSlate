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
 * Save All's Scene chunk writer, which never writes a Scene someone else has
 * locked (`lockedByOther` is the save's own lookup). Auto Bake On Save's
 * navmesh write is skipped without a word, as the Scene's document is, so an
 * Auto-Save opens no bake error. The audio reverb write rejects: the reverb
 * flush reports it unsaved instead of taking it as written, so the save after
 * the lock is released writes it.
 */
export function saveAllSceneWriter<T extends ProjectSceneWriter>(writer: T, lockedByOther: LockLookup["lockedByOther"]): T {
  const lookup: LockLookup = { lockedByOther };
  return {
    ...writer,
    writeSceneNavmeshChunk: (path, bytes, payload) =>
      lockedByOther(path) ? Promise.resolve() : writer.writeSceneNavmeshChunk(path, bytes, payload),
    writeSceneAudioReverbChunk: async (path, bytes, payload) => {
      assertWritableUnderLock(lookup, path);
      return writer.writeSceneAudioReverbChunk(path, bytes, payload);
    },
  };
}
