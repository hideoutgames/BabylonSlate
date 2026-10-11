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

function mtlMapNames(mtlText: string): Set<string> {
  const names = new Set<string>();
  for (const line of mtlText.split(/\r?\n/)) {
    const match = /^\s*(?:map_\S+|bump|disp|decal|refl|norm)\s+(.+)$/i.exec(line);
    const name = match?.[1] ? mtlMapFileName(match[1]) : null;
    if (name) names.add(fileNameOf(name));
  }
  return names;
}

/** Split a Content Browser import batch into OBJ+sidecars vs files to import as-is. */
export function groupObjImportSidecars(files: ImportFileBytes[]): {
  objs: Array<{ obj: ImportFileBytes; sidecars: ImportFileBytes[] }>;
  rest: ImportFileBytes[];
} {
  const objs: Array<{ obj: ImportFileBytes; sidecars: ImportFileBytes[] }> = [];
  const consumed = new Set<ImportFileBytes>();

  for (const file of files) {
    if (extensionOf(file.name) !== "obj") continue;
    const stem = stemOf(file.name);
    const sidecars: ImportFileBytes[] = [];
    const mtl = files.find(
      (entry) => extensionOf(entry.name) === "mtl" && stemOf(entry.name) === stem,
    );
    const mapNames = mtl
      ? mtlMapNames(new TextDecoder().decode(mtl.bytes))
      : new Set<string>();
    for (const entry of files) {
      if (entry === file) continue;
      // Only images the MTL names, or a same-stem image, are the OBJ's own;
      // any other same-stem file (an FBX, a sound) imports on its own.
      const isMap =
        mapNames.has(fileNameOf(entry.name)) ||
        (stemOf(entry.name) === stem && IMAGE_EXTENSIONS.has(extensionOf(entry.name)));
      if (!isMap && !(mtl && entry === mtl)) continue;
      if (consumed.has(entry)) continue;
      sidecars.push(entry);
      consumed.add(entry);
    }
    consumed.add(file);
    objs.push({ obj: file, sidecars });
  }

  const rest = files.filter((file) => !consumed.has(file));
  return { objs, rest };
}
