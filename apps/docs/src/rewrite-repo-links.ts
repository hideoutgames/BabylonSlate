import path from "node:path";

export const GITHUB_BLOB_BASE =
  "https://github.com/hideoutgames/BabylonSlate/blob/main/";

const REPO_ROOT_PREFIXES = [
  "apps/",
  "packages/",
  ".cursor/",
  ".github/",
  "e2e/",
];

const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|css|mdc|vue|json)$/i;

export function rewriteRepoSourceHref(href: string, fromDocPath: string): string {
  const hashIndex = href.indexOf("#");
  const queryIndex = href.indexOf("?");
  let suffixStart = -1;
  if (hashIndex >= 0 && queryIndex >= 0) {
    suffixStart = Math.min(hashIndex, queryIndex);
  } else if (hashIndex >= 0) {
    suffixStart = hashIndex;
  } else if (queryIndex >= 0) {
    suffixStart = queryIndex;
  }
  const pathname = suffixStart >= 0 ? href.slice(0, suffixStart) : href;
  const suffix = suffixStart >= 0 ? href.slice(suffixStart) : "";

  if (
    pathname === "" ||
    pathname.startsWith("#") ||
    pathname.startsWith("/") ||
    isExternal(pathname)
  ) {
    return href;
  }

  const stripped = pathname.replace(/^\.\//, "");
  if (isRepoRootStyle(stripped)) {
    return `${GITHUB_BLOB_BASE}${stripped}${suffix}`;
  }

  const fromDir = path.posix.dirname(fromDocPath || ".");
  const resolved = path.posix.normalize(path.posix.join(fromDir, pathname));
  if (resolved === ".." || resolved.startsWith("../")) {
    const repoPath = path.posix.normalize(path.posix.join("docs", resolved));
    return `${GITHUB_BLOB_BASE}${repoPath}${suffix}`;
  }

  if (SOURCE_FILE.test(pathname)) {
    return `${GITHUB_BLOB_BASE}${stripped}${suffix}`;
  }

  return href;
}

function isExternal(pathname: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(pathname);
}

function isRepoRootStyle(pathname: string): boolean {
  return REPO_ROOT_PREFIXES.some(
    (prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix),
  );
}

export type MarkdownLinkEnv = {
  relativePath?: string;
};

type LinkToken = {
  attrIndex: (name: string) => number;
  attrs?: [string, string][];
};

type LinkOpenRenderer = (
  tokens: LinkToken[],
  idx: number,
  options: unknown,
  env: MarkdownLinkEnv,
  self: { renderToken: (tokens: unknown, idx: number, options: unknown) => string },
) => string;

export function installRepoLinkRewriter(md: {
  renderer: { rules: { [name: string]: unknown } };
}): void {
  const defaultOpen = md.renderer.rules.link_open as LinkOpenRenderer | undefined;
  md.renderer.rules.link_open = (
    tokens: LinkToken[],
    idx: number,
    options: unknown,
    env: MarkdownLinkEnv,
    self: { renderToken: (tokens: unknown, idx: number, options: unknown) => string },
  ) => {
    const token = tokens[idx];
    const hrefIndex = token.attrIndex("href");
    if (hrefIndex >= 0 && token.attrs) {
      const href = token.attrs[hrefIndex][1];
      token.attrs[hrefIndex][1] = rewriteRepoSourceHref(
        href,
        env.relativePath ?? "",
      );
    }
    if (defaultOpen) {
      return defaultOpen(tokens, idx, options, env, self);
    }
    return self.renderToken(tokens, idx, options);
  };
}
