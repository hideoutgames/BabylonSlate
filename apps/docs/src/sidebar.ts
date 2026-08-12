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
      { text: "Global search", link: "/architecture/global-search" },
      { text: "Object model", link: "/architecture/object-model" },
      { text: "Bridge", link: "/architecture/bridge" },
      { text: "Render", link: "/architecture/render" },
      { text: "Scripting", link: "/architecture/scripting" },
      { text: "Scene editing", link: "/architecture/scene-editing" },
      { text: "Input", link: "/architecture/input" },
      { text: "Physics", link: "/architecture/physics" },
      { text: "Debugger", link: "/architecture/debugger" },
      { text: "Theming", link: "/architecture/theming" },
      { text: "Components", link: "/architecture/components" },
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
