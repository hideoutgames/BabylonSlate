import type { CatalogCategory, CatalogCategoryGroup } from "@haptic/editor-kit";
import type { EngineSettingsCategoryId } from "../components/engine-settings-form";

// Settings modal categories and groups. The `categoryId`s in
// `settings-search.ts` must match these ids.

export const PROJECT_CATEGORIES: Array<CatalogCategory & { keywords: string }> = [
  {
    id: "general",
    label: "General",
    keywords:
      "project version build compile autosave editor utility objects infinite loop detection loop count garbage collection interval",
  },
  {
    id: "sourceControl",
    label: "Source Control",
    keywords: "git lfs lock token repository branch poll auto lock",
  },
  {
    id: "export",
    label: "Export",
    keywords:
      "export project backup zip download packaging debugger file count always package folders folder include unreferenced",
  },
  {
    id: "game",
    label: "Game",
    keywords:
      "startup scene game instance class 2d pixels per unit pixel perfect nearest texture filtering sorting layers",
  },
  { id: "saveGames", label: "Save Games", keywords: "save game data definition default slot profile wipe reset import export persistence" },
  {
    id: "physics",
    label: "Physics",
    keywords: "collision layers presets collide mask havok",
  },
  { id: "focusNavigation", label: "Focus Navigation", keywords: "focus keyboard gamepad navigation repeat wrap input activate" },
  {
    id: "rendering",
    label: "Rendering",
    keywords:
      "frame cap fps play preview aspect ratio letterbox follow system custom resolution width height black bars upscaling pixelated PBR CEL shader shadow bands specular light mixing strongest additive blend outlines outline color width",
  },
  {
    id: "textures",
    label: "Textures",
    keywords: "max dimension encoding retry compression",
  },
  {
    id: "fonts",
    label: "Fonts",
    keywords: "default font fallback family stack",
  },
  {
    id: "audio",
    label: "Audio",
    keywords: "mixer channel volume attenuation",
  },
  {
    id: "plugins",
    label: "Plugins",
    keywords: "plugins enable engine project starter content hplugin",
  },
  {
    id: "extensions",
    label: "Project Extensions",
    keywords: "extensions editor code typescript javascript gameplay game library editor only content GLSL material converter hextension",
  },
];

export const PROJECT_GROUPS: CatalogCategoryGroup[] = [
  { label: "Project", ids: ["general", "sourceControl", "export"] },
  { label: "Gameplay", ids: ["game", "saveGames", "physics", "focusNavigation"] },
  { label: "Graphics & Audio", ids: ["rendering", "textures", "fonts", "audio"] },
  { label: "Plugins & Extensions", ids: ["plugins", "extensions"] },
];

export const ENGINE_CATEGORIES: Array<
  CatalogCategory & { keywords: string; id: EngineSettingsCategoryId }
> = [
  {
    id: "about",
    label: "About",
    keywords: "version channel build commit source release test automatic updates GitHub",
  },
  {
    id: "interface",
    label: "Interface",
    keywords: "interface compact mode density touch targets rows size",
  },
  {
    id: "accessibility",
    label: "Accessibility",
    keywords: "accessibility text size font scale zoom reduce motion animation touch target size hold time long press double tap number snap strength scrub tap to connect pins large pins wire thickness pin type letters colour color blind snapped nodes snap grid size align node connection assistant distance shake disconnect motor vision",
  },
  {
    id: "undo",
    label: "Undo",
    keywords: "undo history length stack memory limit budget",
  },
  {
    id: "debugger",
    label: "Debugger",
    keywords: "trace htrace snapshot performance profiler recording duration gpu timing frames memory budget pause play simulation debug mode diagnostics feature test copy error",
  },
  {
    id: "viewport",
    label: "Viewport",
    keywords: "frame cap camera preview frame rate fps hardware scaling post processing occlusion culling camera speed fly",
  },
  {
    id: "assets",
    label: "Assets",
    keywords:
      "model import default scale glb gltf texture lod budget quality audio pcm voices",
  },
  {
    id: "graph",
    label: "Graph",
    keywords: "graph default zoom node canvas fit view add node history read-only read only lock pin defaults inline input values",
  },
  {
    id: "thumbnails",
    label: "Thumbnails",
    keywords: "generate thumbnails",
  },
  {
    id: "templates",
    label: "Templates",
    keywords: "templates library add template homepage",
  },
  {
    id: "plugins",
    label: "Engine Plugins",
    keywords: "plugins default enabled disabled export bundled library",
  },
  {
    id: "extensions",
    label: "Engine Extensions",
    keywords: "extensions default enabled editor code GLSL material converter library",
  },
  {
    id: "focus",
    label: "Focus",
    keywords: "focus keep tabs panels layout",
  },
  {
    id: "keybinds",
    label: "Keybinds",
    keywords: "keyboard shortcuts hotkeys keybinds keys bindings",
  },
];

export const ENGINE_GROUPS: CatalogCategoryGroup[] = [
  {
    label: "Editor",
    ids: [
      "undo",
      "debugger",
      "viewport",
      "graph",
      "assets",
      "thumbnails",
      "focus",
      "keybinds",
      "interface",
      "accessibility",
      "about",
    ],
  },
  { label: "Projects", ids: ["templates", "plugins", "extensions"] },
];

export function matchesSearch(
  label: string,
  keywords: string,
  needle: string,
): boolean {
  return !needle || `${label} ${keywords}`.toLowerCase().includes(needle);
}
