export function extensionOf(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : "";
}

export function baseName(fileName: string): string {
  const withoutDir = fileName.split(/[\\/]/).pop() ?? fileName;
  const idx = withoutDir.lastIndexOf(".");
  return idx > 0 ? withoutDir.slice(0, idx) : withoutDir;
}
