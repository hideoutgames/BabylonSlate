/** A path's file name, lowercased, so a batch matches its files and the names they reference case-insensitively. */
export function fileNameOf(fileName: string): string {
  return (fileName.split(/[\\/]/).pop() ?? fileName).toLowerCase();
}
