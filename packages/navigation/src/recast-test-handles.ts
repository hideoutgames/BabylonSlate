import { Raw, TileCache } from "@recast-navigation/core";
import { vi } from "vitest";

/** Raw Recast classes whose objects a call makes only for the call's length. */
export type TransientRecastClass = "Vec3" | "dtCrowdAgentParams" | "NavMeshExport";

/**
 * Test helper: from now until `restore`, records the heap objects of `classes` made and not yet deleted
 * (`Raw.destroy`), and the tile caches freed (`TileCache.destroy`) and whether their wrapper objects were deleted too.
 */
export function trackRecastHandles(classes: readonly TransientRecastClass[]) {
  const module = Raw.Module as unknown as Record<string, unknown> & { getPointer(object: unknown): number; destroy(object: unknown): void };
  const originals = new Map<string, unknown>();
  const live = new Map<TransientRecastClass, Set<number>>();
  const made = new Map<TransientRecastClass, number>();
  for (const name of classes) {
    const original = module[name] as new (...args: unknown[]) => object;
    originals.set(name, original);
    live.set(name, new Set());
    made.set(name, 0);
    module[name] = new Proxy(original, {
      construct(target, args, newTarget) {
        const object = Reflect.construct(target, args, newTarget) as object;
        live.get(name)!.add(module.getPointer(object));
        made.set(name, made.get(name)! + 1);
        return object;
      },
    });
  }
  const deleted = new Set<unknown>();
  const destroy = module.destroy.bind(module);
  const destroySpy = vi.spyOn(Raw.Module, "destroy").mockImplementation((object: unknown) => {
    const pointer = module.getPointer(object);
    for (const pointers of live.values()) pointers.delete(pointer);
    deleted.add(object);
    destroy(object);
  });
  const freedTileCaches = vi.spyOn(TileCache.prototype, "destroy");
  return {
    /** Objects made per class, deleted or not. */
    made: () => Object.fromEntries(made),
    /** Objects made per class and not deleted. */
    live: () => Object.fromEntries([...live].map(([name, pointers]) => [name, pointers.size])),
    tileCachesFreed: () => freedTileCaches.mock.contexts.length,
    /** Freed tile caches whose wrapper object is still on the heap. */
    tileCacheWrappersLeft: () => freedTileCaches.mock.contexts.filter((tileCache) => !deleted.has((tileCache as TileCache).raw)).length,
    restore: () => {
      for (const [name, original] of originals) module[name] = original;
      destroySpy.mockRestore();
      freedTileCaches.mockRestore();
    },
  };
}
