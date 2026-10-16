import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SidebarItem = {
  text: string;
  link?: string;
  collapsed?: boolean;
  items?: SidebarItem[];
};

export type Sidebar = Record<string, SidebarItem[]>;

export const docsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs",
);

/** Markdown file behind a site link (`/start/` → `start/index.md`). */
function fileForLink(link: string): string {
  const rel = link.replace(/^\//, "");
  return path.join(docsRoot, rel === "" || rel.endsWith("/") ? `${rel}index.md` : `${rel}.md`);
}

/** The page's `# Heading`, so sidebar labels follow the page. */
export function pageTitle(link: string): string {
  const file = fileForLink(link);
  if (!existsSync(file)) {
    throw new Error(`Sidebar link ${link} has no page at ${path.relative(docsRoot, file)}.`);
  }
  const heading = readFileSync(file, "utf8").match(/^# (.+)$/m);
  return heading ? heading[1].trim() : link;
}

function page(link: string, text?: string): SidebarItem {
  return { text: text ?? pageTitle(link), link };
}

function section(text: string, dir: string, pages: string[]): SidebarItem {
  return {
    text,
    collapsed: true,
    items: [page(`/${dir}/`, "Overview"), ...pages.map((name) => page(`/${dir}/${name}`))],
  };
}

/**
 * Sidebar for a reference folder, built from its `index.md`: every `## Group`
 * heading becomes a collapsed group holding the folder pages linked under it.
 */
export function referenceSidebar(dir: string, title: string): SidebarItem[] {
  const source = readFileSync(path.join(docsRoot, dir, "index.md"), "utf8");
  const groups: SidebarItem[] = [];
  let current: SidebarItem | undefined;
  for (const line of source.split("\n")) {
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      current = { text: heading[1].trim(), collapsed: true, items: [] };
      groups.push(current);
      continue;
    }
    for (const match of line.matchAll(/\[([^\]]+)\]\((?:\.\/)?([a-z0-9-]+)\.md\)/g)) {
      current?.items?.push({ text: match[1].replace(/\*\*/g, ""), link: `/${dir}/${match[2]}` });
    }
  }
  return [{ text: title, link: `/${dir}/` }, ...groups.filter((group) => group.items?.length)];
}

export const NODE_GRAPHS = [
  { dir: "scripting/class", title: "Class Nodes" },
  { dir: "scripting/material", title: "Material Nodes" },
  { dir: "scripting/particle", title: "Particle Graph Nodes" },
  { dir: "scripting/animation", title: "Animation Graph Nodes" },
  { dir: "scripting/behaviour-tree", title: "Behaviour Tree Nodes" },
] as const;

export function guideSidebar(): SidebarItem[] {
  return [
    {
      text: "Get Started",
      items: [
        page("/start/", "Overview"),
        ...["install", "first-project", "editor-tour", "gestures", "shortcuts"].map((name) =>
          page(`/start/${name}`),
        ),
      ],
    },
    section("Editor", "editor", ["content-browser", "importing", "search", "undo-and-saving", "settings"]),
    section("Projects", "projects", ["storage", "plugins", "extensions", "source-control"]),
    section("Scenes", "scenes", ["actors", "prefabs", "streaming", "scene-layers", "landscape"]),
    section("Scripting", "scripting", [
      "classes",
      "variables",
      "functions",
      "events",
      "pin-types",
      "interfaces",
      "structures-and-enums",
      "tags",
      "data",
      "save-games",
      "game-instance",
      "editor-scripting",
      ...(existsSync(path.join(docsRoot, "scripting/javascript.md")) ? ["javascript"] : []),
    ]),
    section("Graphics", "graphics", [
      "lighting",
      "shadows",
      "cameras",
      "sky-and-fog",
      "post-processing",
      "materials",
      "water",
      "particles",
      "render-targets",
      "models",
      "geometry",
    ]),
    section("Physics", "physics", ["collision", "movement", "constraints"]),
    section("Audio", "audio", ["mixing", "spatial-audio"]),
    section("2D", "2d", ["sprites", "tilemaps"]),
    section("AI", "ai", ["behaviour-trees", "navigation"]),
    section("Input", "input", ["rebinding"]),
    section("Debugging", "debugging", ["console", "profiler"]),
    section("Publishing", "publishing", ["preview-build"]),
    {
      text: "Reference",
      items: [
        { text: "Components", link: "/components/" },
        { text: "Assets", link: "/assets/" },
        ...NODE_GRAPHS.map(({ dir, title }) => ({ text: title, link: `/${dir}/` })),
      ],
    },
  ];
}

export function docsSidebar(): Sidebar {
  const sidebar: Sidebar = {
    "/components/": referenceSidebar("components", "Components"),
    "/assets/": referenceSidebar("assets", "Assets"),
  };
  for (const { dir, title } of NODE_GRAPHS) {
    sidebar[`/${dir}/`] = referenceSidebar(dir, title);
  }
  sidebar["/"] = guideSidebar();
  return sidebar;
}

export function collectSidebarLinks(items: SidebarItem[]): string[] {
  const links: string[] = [];
  for (const item of items) {
    if (item.link) {
      links.push(item.link);
    }
    if (item.items) {
      links.push(...collectSidebarLinks(item.items));
    }
  }
  return links;
}
