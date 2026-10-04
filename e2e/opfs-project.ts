import type { Page } from "@playwright/test";

/** Resolve storage probes through the catalog, including registered legacy fixtures. */
export async function findOpfsProjectDirectory(page: Page, projectId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const metadata = JSON.parse(localStorage.getItem("babylonslate:opfs-meta") ?? "null") as {
      projects?: Array<{ id: string; directory?: string }>;
    } | null;
    const project = metadata?.projects?.find((entry) => entry.id === id);
    if (!project) return null;
    return project.directory ?? project.id.replace(/[^a-zA-Z0-9._:-]/g, "_");
  }, projectId);
}

export async function opfsProjectDirectory(page: Page, projectId: string): Promise<string> {
  const directory = await findOpfsProjectDirectory(page, projectId);
  if (directory === null) throw new Error(`OPFS project is not registered: ${projectId}`);
  return directory;
}
