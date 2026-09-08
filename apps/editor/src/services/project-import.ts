import { unzipSync } from "fflate";
import type { ProjectTreeFile } from "@babylonslate/assets";

export const PROJECT_IMPORT_LIMIT = 200 * 1024 * 1024;

export function readProjectArchive(bytes: Uint8Array): ProjectTreeFile[] {
  if (bytes.byteLength > 50 * 1024 * 1024)
    throw new Error("Choose an archive smaller than 50 MB.");
  let total = 0;
  const archive = unzipSync(bytes, {
    filter: (entry) => {
      total += entry.originalSize;
      if (total > PROJECT_IMPORT_LIMIT)
        throw new Error("Expanded project exceeds 200 MB.");
      return true;
    },
  });
  return normalizeImportedProject(
    Object.entries(archive)
      .filter(([path]) => !path.endsWith("/"))
      .map(([path, data]) => ({ path, data })),
  );
}

/** Accept either an exported archive or a single containing directory. */
export function normalizeImportedProject(
  files: ProjectTreeFile[],
): ProjectTreeFile[] {
  if (
    files.some(
      ({ path }) =>
        !path ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path
          .split("/")
          .some(
            (part) =>
              !part || part === ".." || part === "." || part.includes(":"),
          ),
    )
  )
    throw new Error("The project contains invalid file paths.");
  let result = files;
  if (!result.some(({ path }) => path === "project.json")) {
    const root = result[0]?.path.split("/")[0];
    if (root && result.every(({ path }) => path.startsWith(`${root}/`)))
      result = result.map((file) => ({
        ...file,
        path: file.path.slice(root.length + 1),
      }));
  }
  const manifest = result.find(({ path }) => path === "project.json");
  if (!manifest)
    throw new Error("Choose a Slate project containing project.json.");
  const project: unknown = JSON.parse(new TextDecoder().decode(manifest.data));
  if (!project || typeof project !== "object" || Array.isArray(project))
    throw new Error("Invalid project manifest.");
  if (new Set(result.map(({ path }) => path)).size !== result.length)
    throw new Error("The project contains duplicate file paths.");
  return result;
}
