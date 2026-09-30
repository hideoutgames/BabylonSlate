export type ModelThumbnailJob = {
  guid: string;
  path: string;
  payload: Record<string, unknown>;
  type?: "Model" | "Animation" | "Material" | "Class" | "Graph";
  onlyIfMissing?: boolean;
  /** Identity captured when the visible tile requested this saved asset. */
  cacheKey?: string;
  projectGuid?: string;
};

type Listener = (jobs: ModelThumbnailJob[]) => void;

const listeners = new Set<Listener>();

export function subscribeModelThumbnailJobs(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function enqueueModelThumbnailJobs(jobs: ModelThumbnailJob[]): void {
  if (jobs.length === 0) return;
  for (const listener of listeners) listener(jobs);
}
