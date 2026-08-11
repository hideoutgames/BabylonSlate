import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Read a golden fixture relative to the calling test file's directory.
 */
export function readGolden(
  testDir: string,
  relativePath: string,
): string {
  return readFileSync(resolve(testDir, relativePath), "utf8");
}

/**
 * Write or refresh a golden fixture (use with an explicit update flag in CI).
 */
export function writeGolden(
  testDir: string,
  relativePath: string,
  content: string,
): void {
  writeFileSync(resolve(testDir, relativePath), content, "utf8");
}

/**
 * Normalize line endings for stable golden comparisons across platforms.
 */
export function normalizeGoldenText(text: string): string {
  return text.replace(/\r\n/g, "\n").trimEnd();
}
