export type ModelThumbnailJob = {
  guid: string;
  path: string;
  payload: Record<string, unknown>;
  type?: "Texture" | "Model" | "Animation" | "Material" | "Class" | "Tileset" | "Tilemap";
  onlyIfMissing?: boolean;
  /** Saved asset identity captured when generation was requested. */
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

const projectsAwaitingThumbnails = new Set<string>();

/**
 * Marks a project just made from a template or imported, which brings no
 * thumbnails: its first editor session generates one for every asset that has one.
 */
export function requestProjectThumbnails(projectGuid: string): void {
  projectsAwaitingThumbnails.add(projectGuid);
}

/** Whether the project was marked by `requestProjectThumbnails`; clears the mark. */
export function takeProjectThumbnailRequest(projectGuid: string): boolean {
  return projectsAwaitingThumbnails.delete(projectGuid);
}
