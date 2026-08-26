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

function mtlMapNames(mtlText: string): Set<string> {
  const names = new Set<string>();
  for (const line of mtlText.split(/\r?\n/)) {
    const match = /^\s*map_\S+\s+(\S+)/i.exec(line);
    if (match?.[1]) names.add(fileNameOf(match[1]));
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
      const ext = extensionOf(entry.name);
      const sameStem = stemOf(entry.name) === stem;
      const isMap =
        mapNames.has(fileNameOf(entry.name)) ||
        (sameStem && ext !== "obj" && ext !== "glb" && ext !== "gltf");
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
