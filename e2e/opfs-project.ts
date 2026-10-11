import type { Page } from "@playwright/test";

/** OPFS folder the adapter derives from a project or library id, or null before it exists. */
export async function findOpfsProjectDirectory(page: Page, projectId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(id)));
    const name = `project-v2-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    try {
      await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
      return name;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  }, projectId);
}

export async function opfsProjectDirectory(page: Page, projectId: string): Promise<string> {
  const directory = await findOpfsProjectDirectory(page, projectId);
  if (directory === null) throw new Error(`OPFS project folder does not exist: ${projectId}`);
  return directory;
}
