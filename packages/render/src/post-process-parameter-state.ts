import {
  normalizeMaterialParameterOverrides,
  type MaterialParameterValue,
  type ScenePostProcessEntry,
} from "@babylonslate/core";

/** Runtime replay belongs to the Scene/Layer owner, independently of live/disabled passes. */
export class PostProcessParameterState {
  private readonly entries = new Map<
    string,
    { materialGuid: string; values: Record<string, MaterialParameterValue> }
  >();

  clear(): void {
    this.entries.clear();
  }

  set(
    stack: readonly ScenePostProcessEntry[],
    entryId: string,
    materialGuid: string,
    name: string,
    value: MaterialParameterValue,
  ): boolean {
    const entry = stack.find(
      (candidate) =>
        candidate.id === entryId && candidate.materialGuid === materialGuid,
    );
    const copied = normalizeMaterialParameterOverrides({ [name]: value })[name];
    if (!entry || !copied) return false;
    let replay = this.entries.get(entryId);
    if (!replay || replay.materialGuid !== materialGuid) {
      replay = { materialGuid, values: {} };
      this.entries.set(entryId, replay);
    }
    Object.defineProperty(replay.values, name, {
      value: copied,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return true;
  }

  effective<T extends ScenePostProcessEntry>(stack: readonly T[]): T[] {
    for (const [id, replay] of this.entries) {
      if (
        !stack.some(
          (entry) =>
            entry.id === id && entry.materialGuid === replay.materialGuid,
        )
      )
        this.entries.delete(id);
    }
    return stack.map((entry) => {
      const replay = entry.id ? this.entries.get(entry.id) : undefined;
      return replay
        ? {
            ...entry,
            parameters: normalizeMaterialParameterOverrides({
              ...entry.parameters,
              ...replay.values,
            }),
          }
        : entry;
    });
  }
}
