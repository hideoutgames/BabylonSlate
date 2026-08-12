import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import { docsBrand } from "../src/branding";
import { installRepoLinkRewriter } from "../src/rewrite-repo-links";
import { docsSidebar } from "../src/sidebar";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "../..");
const rawBase = process.env.VITEPRESS_BASE ?? "/";
const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;

export default withMermaid(
  defineConfig({
    srcDir: path.resolve(repoRoot, "docs"),
    srcExclude: ["README.md"],
    outDir: path.resolve(appRoot, ".vitepress/dist"),
    cacheDir: path.resolve(appRoot, ".vitepress/cache"),
    base,
    cleanUrls: true,
    ignoreDeadLinks: false,
    title: "BabylonSlate",
    description:
      "Touch-first Babylon.js engine — architecture, design notes, and contributor docs.",
    head: [
      [
        "link",
        {
          rel: "icon",
          type: "image/svg+xml",
          href: `${base}${docsBrand.favicon.replace(/^\//, "")}`,
        },
      ],
      [
        "link",
        {
          rel: "apple-touch-icon",
          href: `${base}${docsBrand.appleTouchIcon.replace(/^\//, "")}`,
        },
      ],
    ],
    lastUpdated: true,
    themeConfig: {
      logo: docsBrand.navLogo,
      siteTitle: "BabylonSlate",
      nav: [
        { text: "Docs", link: "/engineplan" },
        { text: "Architecture", link: "/architecture/overview" },
        {
          text: "Editor preview",
          link: "https://hideoutgames.github.io/BabylonSlate/",
        },
        {
          text: "GitHub",
          link: "https://github.com/hideoutgames/BabylonSlate",
        },
      ],
      sidebar: docsSidebar,
      search: { provider: "local" },
      outline: [2, 3],
      editLink: {
        pattern:
          "https://github.com/hideoutgames/BabylonSlate/edit/main/docs/:path",
        text: "Edit this page on GitHub",
      },
      socialLinks: [
        { icon: "github", link: "https://github.com/hideoutgames/BabylonSlate" },
      ],
    },
    markdown: {
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
    mermaid: {
      theme: "neutral",
    },
  }),
);
