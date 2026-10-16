import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { docsBrand } from "../src/branding";
import {
  githubHeadingSlug,
  installRepoLinkRewriter,
} from "../src/rewrite-repo-links";
import { docsSidebar, NODE_GRAPHS } from "../src/sidebar";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "../..");
const rawBase = process.env.VITEPRESS_BASE ?? "/";
const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;

export default defineConfig({
  srcDir: path.resolve(repoRoot, "docs"),
  outDir: path.resolve(appRoot, ".vitepress/dist"),
  cacheDir: path.resolve(appRoot, ".vitepress/cache"),
  base,
  cleanUrls: true,
  // Keep the page map out of every HTML file; the site has about a thousand pages.
  metaChunk: true,
  ignoreDeadLinks: false,
  title: "Haptic",
  description: "Documentation for Haptic, the portable game engine.",
  head: [
    ["link", { rel: "icon", type: "image/png", href: `${base}${docsBrand.favicon.replace(/^\//, "")}` }],
    ["link", { rel: "icon", href: `${base}${docsBrand.faviconIco.replace(/^\//, "")}`, sizes: "any" }],
    ["link", { rel: "apple-touch-icon", href: `${base}${docsBrand.appleTouchIcon.replace(/^\//, "")}` }],
  ],
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
    search: { provider: "local" },
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
