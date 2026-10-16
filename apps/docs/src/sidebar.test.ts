import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectSidebarLinks, docsRoot, docsSidebar } from "./sidebar";

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

function linkToFile(link: string): string {
  const rel = link.replace(/^\//, "");
  return path.join(docsRoot, rel.endsWith("/") ? `${rel}index.md` : `${rel}.md`);
}

describe("docsSidebar", () => {
  const sidebar = docsSidebar();
  const listed = Object.values(sidebar).flatMap((items) => collectSidebarLinks(items));

  it("reaches every docs page except the home page", () => {
    const required = listMarkdownFiles(docsRoot)
      .filter((rel) => rel !== "index.md")
      .map(docFileToLink)
      .map(normalizeLink)
      .sort();
    expect(listed.map(normalizeLink)).toEqual(expect.arrayContaining(required));
    expect(required.length).toBeGreaterThan(0);
  });

  it("links only to pages that exist", () => {
    expect(listed.filter((link) => !existsSync(linkToFile(link)))).toEqual([]);
  });
});
