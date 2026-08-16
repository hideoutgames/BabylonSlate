export function loadLatest<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
): () => void {
  let cancelled = false;
  void load().then((value) => {
    if (!cancelled) apply(value);
  });
  return () => {
    cancelled = true;
  };
}
