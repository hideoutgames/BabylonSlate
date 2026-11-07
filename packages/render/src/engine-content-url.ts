/** Public URL of `file` in the app's `dir` (`engine-content/…`), under the Vite base URL. */
export function engineContentUrl(dir: string, file: string): string {
  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL || "/";
  return `${base.endsWith("/") ? base : `${base}/`}${dir}/${file}`;
}
