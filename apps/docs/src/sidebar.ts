export type SidebarItem = {
  text: string;
  link?: string;
  collapsed?: boolean;
  items?: SidebarItem[];
};

export const docsSidebar: SidebarItem[] = [
  { text: "Engine plan", link: "/engineplan" },
  { text: "Coding standards", link: "/CODING_STANDARDS" },
  {
    text: "Architecture",
    link: "/architecture/",
    collapsed: false,
    items: [
      { text: "Overview", link: "/architecture/overview" },
      { text: "Containers", link: "/architecture/containers" },
      { text: "VFS", link: "/architecture/vfs" },
      { text: "Command layer", link: "/architecture/command-layer" },
      { text: "Asset registry", link: "/architecture/asset-registry" },
      { text: "Plugins", link: "/architecture/plugins" },
      { text: "Global search", link: "/architecture/global-search" },
      { text: "Object model", link: "/architecture/object-model" },
      { text: "Bridge", link: "/architecture/bridge" },
      { text: "Render", link: "/architecture/render" },
      { text: "Scripting", link: "/architecture/scripting" },
      { text: "Scene editing", link: "/architecture/scene-editing" },
      { text: "Input", link: "/architecture/input" },
      { text: "Physics", link: "/architecture/physics" },
      { text: "Debugger", link: "/architecture/debugger" },
      { text: "UI runtime", link: "/architecture/ui-runtime" },
      { text: "Fonts", link: "/architecture/fonts" },
      { text: "Sprites", link: "/architecture/sprites" },
      { text: "Tilemaps", link: "/architecture/tilemaps" },
      { text: "Animation graph", link: "/architecture/anim-graph" },
      { text: "Behaviour tree", link: "/architecture/behaviour-tree" },
      { text: "Navigation", link: "/architecture/navigation" },
      { text: "Shader graph", link: "/architecture/shader-graph" },
      { text: "Theming", link: "/architecture/theming" },
      { text: "Components", link: "/architecture/components" },
      { text: "Editor extensions", link: "/architecture/editor-extensions" },
      { text: "Testing", link: "/architecture/testing" },
    ],
  },
  {
    text: "Design",
    collapsed: false,
    items: [
      { text: "Performance budget", link: "/design/perf-budget" },
      { text: "Gestures", link: "/design/gestures" },
    ],
  },
  {
    text: "Contributing",
    collapsed: false,
    items: [{ text: "Issue tracker", link: "/agents/issue-tracker" }],
  },
];

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
