import { IMAGE_EXTENSIONS } from "./image";
import { extensionOf } from "./util";

export interface ImportFileBytes {
  name: string;
  bytes: Uint8Array;
  sidecars?: Record<string, Uint8Array>;
}

function stemOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const idx = base.lastIndexOf(".");
  return (idx > 0 ? base.slice(0, idx) : base).toLowerCase();
}

function fileNameOf(fileName: string): string {
  return (fileName.split(/[\\/]/).pop() ?? fileName).toLowerCase();
}

/** Options a texture statement may put before its file name, with their argument counts. */
const MTL_MAP_OPTION_ARGS: Record<string, { min: number; max: number }> = {
  "-blendu": { min: 1, max: 1 },
  "-blendv": { min: 1, max: 1 },
  "-bm": { min: 1, max: 1 },
  "-boost": { min: 1, max: 1 },
  "-cc": { min: 1, max: 1 },
  "-clamp": { min: 1, max: 1 },
  "-imfchan": { min: 1, max: 1 },
  "-texres": { min: 1, max: 1 },
  "-type": { min: 1, max: 1 },
  "-mm": { min: 1, max: 2 },
  "-o": { min: 1, max: 3 },
  "-s": { min: 1, max: 3 },
  "-t": { min: 1, max: 3 },
};

/** The file a texture statement (`map_Kd -s 1 1 1 hero.png`) names, after its options. */
function mtlMapFileName(args: string): string | null {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length) {
    const option = MTL_MAP_OPTION_ARGS[tokens[index]!.toLowerCase()];
    if (!option) break;
    index += 1;
    // Required values first, then any optional numeric ones (`-s u [v [w]]`).
    let taken = 0;
    while (index < tokens.length - 1 && taken < option.max &&
      (taken < option.min || Number.isFinite(Number(tokens[index])))) {
      index += 1;
      taken += 1;
    }
  }
  const name = tokens.slice(index).join(" ");
  return name || null;
}

/** The file names the MTL's texture statements give, as written (`textures/wood.png`). */
function mtlMapPaths(mtlText: string): string[] {
  const paths: string[] = [];
  for (const line of mtlText.split(/\r?\n/)) {
    const match = /^\s*(?:map_\S+|bump|disp|decal|refl|norm)\s+(.+)$/i.exec(line);
    const name = match?.[1] ? mtlMapFileName(match[1]) : null;
    if (name) paths.push(name);
  }
  return paths;
}

/** The folder part of a batch path, lowercase (`chair` for `Chair/chair.obj`, empty in a flat pick). */
function folderOf(fileName: string): string {
  const path = fileName.replace(/\\/g, "/").toLowerCase();
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** `relative` resolved against `folder`, lowercase; `..` above the batch keeps only the file name. */
function resolveInFolder(folder: string, relative: string): string {
  const parts = folder ? folder.split("/") : [];
  for (const part of relative.replace(/\\/g, "/").toLowerCase().split("/")) {
    if (!part || part === ".") continue;
    if (part !== "..") parts.push(part);
    else parts.pop();
  }
  return parts.join("/");
}

/**
 * The file a MTL texture statement names: the one at its path from the
 * MTL's folder, else one of that file name in the OBJ's folder, else any.
 * A ZIP or folder import keeps paths; a flat pick has file names only.
 */
function mtlMapFile(
  mapPath: string,
  mtl: ImportFileBytes,
  objFolder: string,
  files: readonly ImportFileBytes[],
): ImportFileBytes | undefined {
  const exact = resolveInFolder(folderOf(mtl.name), mapPath);
  const name = fileNameOf(mapPath);
  const named = files.filter((entry) => fileNameOf(entry.name) === name);
  return named.find((entry) => entry.name.replace(/\\/g, "/").toLowerCase() === exact) ??
    named.find((entry) => folderOf(entry.name) === objFolder) ??
    named[0];
}

/** Split a Content Browser import batch into OBJ+sidecars vs files to import as-is. */
export function groupObjImportSidecars(files: ImportFileBytes[]): {
  objs: Array<{ obj: ImportFileBytes; sidecars: ImportFileBytes[] }>;
  rest: ImportFileBytes[];
} {
  const objs: Array<{ obj: ImportFileBytes; sidecars: ImportFileBytes[] }> = [];
  const consumed = new Set<ImportFileBytes>();
  const images = files.filter((entry) => IMAGE_EXTENSIONS.has(extensionOf(entry.name)));

  for (const file of files) {
    if (extensionOf(file.name) !== "obj") continue;
    const stem = stemOf(file.name);
    const folder = folderOf(file.name);
    const sidecars: ImportFileBytes[] = [];
    const add = (entry: ImportFileBytes | undefined) => {
      if (!entry || sidecars.includes(entry)) return;
      sidecars.push(entry);
      consumed.add(entry);
    };
    // The same-stem MTL beside the OBJ, else one elsewhere in the batch.
    const mtls = files.filter(
      (entry) => extensionOf(entry.name) === "mtl" && stemOf(entry.name) === stem,
    );
    const mtl = mtls.find((entry) => folderOf(entry.name) === folder) ?? mtls[0];
    add(mtl);
    // Only images the MTL names, or a same-stem image beside the OBJ, are the
    // OBJ's own; any other same-stem file (an FBX, a sound) imports on its own.
    // An image two OBJs name serves both.
    if (mtl) {
      const others = files.filter((entry) => entry !== file && entry !== mtl);
      for (const mapPath of mtlMapPaths(new TextDecoder().decode(mtl.bytes))) {
        add(mtlMapFile(mapPath, mtl, folder, others));
      }
    }
    for (const entry of images) {
      if (stemOf(entry.name) === stem && folderOf(entry.name) === folder) add(entry);
    }
    consumed.add(file);
    objs.push({ obj: file, sidecars });
  }

  const rest = files.filter((file) => !consumed.has(file));
  return { objs, rest };
}
