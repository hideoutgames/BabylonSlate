export type ModelThumbnailJob = {
  guid: string;
  path: string;
  payload: Record<string, unknown>;
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
