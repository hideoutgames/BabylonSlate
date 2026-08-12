import { describe, expect, it } from "vitest";
import {
  GITHUB_BLOB_BASE,
  installRepoLinkRewriter,
  rewriteRepoSourceHref,
} from "./rewrite-repo-links";

describe("rewriteRepoSourceHref", () => {
  it("maps packages/ root-style paths to GitHub blob URLs", () => {
    expect(
      rewriteRepoSourceHref("packages/shared/src/storage-port.ts", "engineplan.md"),
    ).toBe(`${GITHUB_BLOB_BASE}packages/shared/src/storage-port.ts`);
  });

  it("maps ../packages/ paths from a nested doc to GitHub blob URLs", () => {
    expect(
      rewriteRepoSourceHref(
        "../../packages/ui/src/styles/globals.css",
        "architecture/theming.md",
      ),
    ).toBe(`${GITHUB_BLOB_BASE}packages/ui/src/styles/globals.css`);
  });

  it("maps apps/ and .cursor/ root-style paths to GitHub blob URLs", () => {
    expect(
      rewriteRepoSourceHref(
        "apps/editor/src/shell/dockview-shell.tsx",
        "engineplan.md",
      ),
    ).toBe(`${GITHUB_BLOB_BASE}apps/editor/src/shell/dockview-shell.tsx`);
    expect(
      rewriteRepoSourceHref(".cursor/rules/touch-editor.md", "engineplan.md"),
    ).toBe(`${GITHUB_BLOB_BASE}.cursor/rules/touch-editor.md`);
  });

  it("preserves in-docs markdown links, including hashes", () => {
    expect(
      rewriteRepoSourceHref("architecture/theming.md", "engineplan.md"),
    ).toBe("architecture/theming.md");
    expect(
      rewriteRepoSourceHref(
        "../agents/issue-tracker.md#p5-slice-ownership",
        "architecture/scripting.md",
      ),
    ).toBe("../agents/issue-tracker.md#p5-slice-ownership");
  });

  it("leaves external URLs and hash-only links unchanged", () => {
    expect(
      rewriteRepoSourceHref(
        "https://tweakcn.com/themes/example",
        "architecture/theming.md",
      ),
    ).toBe("https://tweakcn.com/themes/example");
    expect(rewriteRepoSourceHref("#overview", "engineplan.md")).toBe("#overview");
  });

  it("rewrites href attributes on markdown-it link_open tokens", () => {
    const md = { renderer: { rules: {} as Record<string, unknown> } };
    installRepoLinkRewriter(md);
    const token = {
      attrIndex: (name: string) => (name === "href" ? 0 : -1),
      attrs: [["href", "packages/core/src/index.ts"]] as [string, string][],
    };
    const render = md.renderer.rules.link_open as (
      tokens: unknown,
      idx: number,
      options: unknown,
      env: { relativePath?: string },
      self: { renderToken: () => string },
    ) => string;
    render(
      [token],
      0,
      {},
      { relativePath: "engineplan.md" },
      { renderToken: () => "" },
    );
    expect(token.attrs[0][1]).toBe(
      `${GITHUB_BLOB_BASE}packages/core/src/index.ts`,
    );
  });
});
