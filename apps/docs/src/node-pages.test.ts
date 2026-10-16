import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { catalogNodeKeys } from "./node-previews/catalog";
import { docsRoot, NODE_GRAPHS } from "./sidebar";

/** `<graph folder>/<node id>` for every node page, read from its `node:` frontmatter. */
function pageNodeKeys(): { keys: string[]; missing: string[] } {
  const keys: string[] = [];
  const missing: string[] = [];
  for (const { dir } of NODE_GRAPHS) {
    const graph = path.basename(dir);
    for (const file of readdirSync(path.join(docsRoot, dir))) {
      if (!file.endsWith(".md") || file === "index.md") continue;
      const text = readFileSync(path.join(docsRoot, dir, file), "utf8");
      const node = /^---\n(?:.*\n)*?node: "?([^"\n]+)"?\n(?:.*\n)*?---\n/.exec(text)?.[1];
      if (node) keys.push(`${graph}/${node}`);
      else missing.push(`${dir}/${file}`);
    }
  }
  return { keys, missing };
}

describe("node reference pages", () => {
  const pages = pageNodeKeys();
  const catalog = new Set(catalogNodeKeys());

  it("name their catalog node in node: frontmatter", () => {
    expect(pages.missing).toEqual([]);
    expect(pages.keys.filter((key) => !catalog.has(key))).toEqual([]);
  });

  it("exist once for every catalog node", () => {
    const documented = new Set(pages.keys);
    expect([...catalog].filter((key) => !documented.has(key))).toEqual([]);
    expect(pages.keys.length).toBe(documented.size);
  });
});
