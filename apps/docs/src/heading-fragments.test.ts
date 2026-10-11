import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMarkdownRenderer } from "vitepress";
import { describe, expect, it } from "vitest";
import { githubHeadingSlug } from "./rewrite-repo-links";

const docsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs",
);

type DocPage = { ids: Set<string>; links: { href: string; line: number }[] };

/** Heading ids and links of every docs page, parsed as the site parses them. */
async function parseDocs(): Promise<Map<string, DocPage>> {
  const md = await createMarkdownRenderer(
    docsRoot,
    { anchor: { slugify: githubHeadingSlug } },
    "/",
  );
  const pages = new Map<string, DocPage>();
  const files = readdirSync(docsRoot, { recursive: true, encoding: "utf8" })
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => file.endsWith(".md"));
  for (const file of files) {
    const source = readFileSync(path.join(docsRoot, file), "utf8");
    const page: DocPage = { ids: new Set(), links: [] };
    let line = 1;
    for (const token of md.parse(source, { relativePath: file })) {
      if (token.map) line = token.map[0] + 1;
      if (token.type === "heading_open") page.ids.add(token.attrGet("id") ?? "");
      for (const child of token.children ?? []) {
        const href = child.type === "link_open" ? child.attrGet("href") : null;
        if (href) page.links.push({ href, line });
      }
    }
    pages.set(file, page);
  }
  return pages;
}

/** The docs page and heading id a link points at, or null outside docs pages. */
function fragmentTarget(href: string, fromPage: string) {
  const hash = href.indexOf("#");
  if (hash < 0 || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const target = href.slice(0, hash);
  const page = target
    ? path.posix.normalize(path.posix.join(path.posix.dirname(fromPage), target))
    : fromPage;
  if (!page.endsWith(".md") || page.startsWith("../")) return null;
  return { page, id: decodeURIComponent(href.slice(hash + 1)) };
}

describe("docs heading fragments", () => {
  it("uses GitHub heading ids where the VitePress default differs", () => {
    expect(githubHeadingSlug("2D Text and 2D Rich Text")).toBe(
      "2d-text-and-2d-rich-text",
    );
    expect(githubHeadingSlug("P5 follow-ups / open deferrals")).toBe(
      "p5-follow-ups--open-deferrals",
    );
    expect(githubHeadingSlug("Pin defaults (Inspector + canvas)")).toBe(
      "pin-defaults-inspector--canvas",
    );
    expect(githubHeadingSlug("Rapier 0.21")).toBe("rapier-021");
    expect(githubHeadingSlug("Status — 23 September")).toBe(
      "status--23-september",
    );
  });

  it("links every docs fragment to a heading on its target page", async () => {
    const pages = await parseDocs();
    const broken: string[] = [];
    for (const [file, { links }] of pages) {
      for (const { href, line } of links) {
        const target = fragmentTarget(href, file);
        if (target && !pages.get(target.page)?.ids.has(target.id)) {
          broken.push(`docs/${file}:${line} ${href}`);
        }
      }
    }
    expect(broken).toEqual([]);
  }, 60_000);
});
