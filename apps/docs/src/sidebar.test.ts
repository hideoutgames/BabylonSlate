import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectSidebarLinks, docsSidebar } from "./sidebar";

const docsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs",
);

const EXCLUDED = new Set(["README.md", "index.md"]);

function listMarkdownFiles(dir: string, rel = ""): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(path.join(dir, entry.name), childRel));
      continue;
    }
    if (entry.name.endsWith(".md")) {
      files.push(childRel);
    }
  }
  return files;
}

function docFileToLink(relPosix: string): string {
  if (relPosix.endsWith("/index.md")) {
    return `/${relPosix.slice(0, -"/index.md".length)}`;
  }
  return `/${relPosix.slice(0, -".md".length)}`;
}

function normalizeLink(link: string): string {
  return `/${link.replace(/^\//, "").replace(/\/index$/, "").replace(/\/$/, "")}`;
}

describe("docsSidebar", () => {
  it("includes every docs markdown file except README.md and the home index", () => {
    const required = listMarkdownFiles(docsRoot)
      .filter((rel) => !EXCLUDED.has(rel))
      .map(docFileToLink)
      .map(normalizeLink)
      .sort();
    const listed = collectSidebarLinks(docsSidebar).map(normalizeLink).sort();
    expect(listed).toEqual(expect.arrayContaining(required));
    expect(required.length).toBeGreaterThan(0);
  });
});
