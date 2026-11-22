import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { docsBrand } from "../src/branding";
import {
  githubHeadingSlug,
  installRepoLinkRewriter,
} from "../src/rewrite-repo-links";
import { docsSidebar, NODE_GRAPHS } from "../src/sidebar";
import { installNodePreviews } from "../src/node-previews/markdown";
import type { NodePreviews } from "../src/node-previews/types";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "../..");
const rawBase = process.env.VITEPRESS_BASE ?? "/";
const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;

// Written by scripts/node-previews.mjs, which the dev and build scripts run first.
const nodePreviewsFile = path.resolve(appRoot, ".vitepress/cache/node-previews/previews.json");
if (!existsSync(nodePreviewsFile)) {
  throw new Error("Node previews are missing: run `pnpm --filter docs-site build` or `node scripts/node-previews.mjs`.");
}
const nodePreviews = JSON.parse(readFileSync(nodePreviewsFile, "utf8")) as NodePreviews;

/** Where the published site lives (GitHub Pages); sitemap and share links name it whatever base this build uses. */
const SITE_URL = "https://hideoutgames.github.io/BabylonSlate/docs/";
const SITE_TITLE = "Haptic";
const SITE_DESCRIPTION = "Documentation for Haptic, the portable game engine.";

export default defineConfig({
  srcDir: path.resolve(repoRoot, "docs"),
  outDir: path.resolve(appRoot, ".vitepress/dist"),
  cacheDir: path.resolve(appRoot, ".vitepress/cache"),
  base,
  cleanUrls: true,
  // Keep the page map out of every HTML file; the site has about a thousand pages.
  metaChunk: true,
  ignoreDeadLinks: false,
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  head: [
    ["link", { rel: "icon", type: "image/png", href: `${base}${docsBrand.favicon.replace(/^\//, "")}` }],
    ["link", { rel: "icon", href: `${base}${docsBrand.faviconIco.replace(/^\//, "")}`, sizes: "any" }],
    ["link", { rel: "apple-touch-icon", href: `${base}${docsBrand.appleTouchIcon.replace(/^\//, "")}` }],
    ["meta", { property: "og:site_name", content: SITE_TITLE }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:image", content: new URL(docsBrand.favicon.replace(/^\//, ""), SITE_URL).href }],
    ["meta", { name: "twitter:card", content: "summary" }],
  ],
  // Each page's share title, description and address.
  transformHead({ pageData, title, description }) {
    const page = pageData.relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
    const url = new URL(page, SITE_URL).href;
    return [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
    ];
  },
  sitemap: { hostname: SITE_URL },
  themeConfig: {
    logo: docsBrand.navLogo,
    siteTitle: false,
    nav: [
      { text: "Get Started", link: "/start/", activeMatch: "^/start/" },
      { text: "Scripting", link: "/scripting/", activeMatch: "^/scripting/" },
      {
        text: "Reference",
        items: [
          { text: "Components", link: "/components/" },
          { text: "Assets", link: "/assets/" },
          {
            text: "Nodes",
            items: NODE_GRAPHS.map(({ dir, title }) => ({ text: title, link: `/${dir}/` })),
          },
        ],
      },
    ],
    sidebar: docsSidebar(),
    search: {
      provider: "local",
      options: {
        // VitePress's default render, with node pages leaving their drawn node out of the index.
        _render(src, env, md) {
          (env as typeof env & { hapticSearchIndex?: boolean }).hapticSearchIndex = true;
          const html = md.render(src, env);
          return env.frontmatter?.search === false ? "" : html;
        },
      },
    },
    outline: { level: [2, 3], label: "On this page" },
    docFooter: { prev: false, next: false },
    socialLinks: [
      { icon: "github", link: "https://github.com/hideoutgames/BabylonSlate" },
    ],
  },
  markdown: {
    anchor: { slugify: githubHeadingSlug },
    config(md) {
      installRepoLinkRewriter(md);
      installNodePreviews(md, nodePreviews);
    },
  },
  vite: {
    publicDir: path.resolve(appRoot, "public"),
    resolve: {
      dedupe: ["vue"],
      alias: {
        vue: path.dirname(
          fileURLToPath(import.meta.resolve("vue/package.json")),
        ),
      },
    },
    ssr: {
      noExternal: ["vue", "vitepress"],
    },
    server: {
      fs: {
        allow: [repoRoot],
      },
    },
  },
});
