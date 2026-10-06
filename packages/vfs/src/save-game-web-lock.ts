/** No unlocked fallback: otherwise separate contexts could commit the same generation. */
export function withSaveGameWebLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return Promise.reject(new Error("This host does not support safe save storage locking"));
  return locks.request(`babylonslate:game-saves:${key}`, { mode: "exclusive" }, operation);
}
