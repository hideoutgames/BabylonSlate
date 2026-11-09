import {
  ActivityIcon,
  AudioLinesIcon,
  BoxIcon,
  BoxesIcon,
  BracesIcon,
  CameraIcon,
  CodeIcon,
  CompassIcon,
  DatabaseIcon,
  FilmIcon,
  FlagIcon,
  FolderIcon,
  Gamepad2Icon,
  GlobeIcon,
  HammerIcon,
  ImageIcon,
  LayersIcon,
  LightbulbIcon,
  MapIcon,
  MousePointerClickIcon,
  MusicIcon,
  PackageIcon,
  PaintbrushIcon,
  PaletteIcon,
  PersonStandingIcon,
  PlugIcon,
  PuzzleIcon,
  RocketIcon,
  SettingsIcon,
  ShieldIcon,
  SparklesIcon,
  StarIcon,
  TerminalIcon,
  WandSparklesIcon,
  WorkflowIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import SiDiscord from "@icons-pack/react-simple-icons/icons/SiDiscord";
import { createElement, forwardRef } from "react";

/** Static Lucide imports keep plugin metadata from loading the whole icon library. */
export const PLUGIN_ICON_OPTIONS: ReadonlyArray<{
  key: string;
  label: string;
  icon: LucideIcon;
}> = [
  { key: "Activity", label: "Activity", icon: ActivityIcon },
  { key: "AudioLines", label: "Audio Lines", icon: AudioLinesIcon },
  { key: "Box", label: "Box", icon: BoxIcon },
  { key: "Boxes", label: "Boxes", icon: BoxesIcon },
  { key: "Braces", label: "Braces", icon: BracesIcon },
  { key: "Camera", label: "Camera", icon: CameraIcon },
  { key: "Code", label: "Code", icon: CodeIcon },
  { key: "Compass", label: "Compass", icon: CompassIcon },
  { key: "Database", label: "Database", icon: DatabaseIcon },
  { key: "Film", label: "Film", icon: FilmIcon },
  { key: "Flag", label: "Flag", icon: FlagIcon },
  { key: "Folder", label: "Folder", icon: FolderIcon },
  { key: "Gamepad2", label: "Gamepad", icon: Gamepad2Icon },
  { key: "Globe", label: "Globe", icon: GlobeIcon },
  { key: "Hammer", label: "Hammer", icon: HammerIcon },
  { key: "Image", label: "Image", icon: ImageIcon },
  { key: "Layers", label: "Layers", icon: LayersIcon },
  { key: "Lightbulb", label: "Lightbulb", icon: LightbulbIcon },
  { key: "Map", label: "Map", icon: MapIcon },
  {
    key: "MousePointerClick",
    label: "Mouse Pointer Click",
    icon: MousePointerClickIcon,
  },
  { key: "Music", label: "Music", icon: MusicIcon },
  { key: "Package", label: "Package", icon: PackageIcon },
  { key: "Paintbrush", label: "Paintbrush", icon: PaintbrushIcon },
  { key: "Palette", label: "Palette", icon: PaletteIcon },
  { key: "PersonStanding", label: "Person Standing", icon: PersonStandingIcon },
  { key: "Plug", label: "Plug", icon: PlugIcon },
  { key: "Puzzle", label: "Puzzle", icon: PuzzleIcon },
  { key: "Rocket", label: "Rocket", icon: RocketIcon },
  { key: "Settings", label: "Settings", icon: SettingsIcon },
  { key: "Shield", label: "Shield", icon: ShieldIcon },
  { key: "Sparkles", label: "Sparkles", icon: SparklesIcon },
  { key: "Star", label: "Star", icon: StarIcon },
  { key: "Terminal", label: "Terminal", icon: TerminalIcon },
  { key: "WandSparkles", label: "Wand Sparkles", icon: WandSparklesIcon },
  { key: "Workflow", label: "Workflow", icon: WorkflowIcon },
  { key: "Wrench", label: "Wrench", icon: WrenchIcon },
  { key: "Zap", label: "Zap", icon: ZapIcon },
];

/**
 * Discord's mark from Simple Icons, filled with its `--platform-discord` token (Discord's blurple) wherever it shows.
 * Lucide props that do not apply to a filled mark are dropped.
 */
const LUCIDE_ONLY_PROPS = new Set(["color", "strokeWidth", "absoluteStrokeWidth"]);
const DiscordIcon = forwardRef<SVGSVGElement, LucideProps>(function DiscordIcon({ size, style, ...props }, ref) {
  const svgProps = Object.fromEntries(Object.entries(props).filter(([key]) => !LUCIDE_ONLY_PROPS.has(key)));
  return createElement(SiDiscord, { ...svgProps, ref, size: size ?? 24, color: "currentColor", style: { ...style, color: "var(--platform-discord)" } });
}) as LucideIcon;

/** Brand marks for bundled extensions. Extensions can name them, but the icon picker does not offer them. */
const BRAND_ICONS: ReadonlyMap<string, LucideIcon> = new Map([["Discord", DiscordIcon]]);

export function resolvePluginIcon(
  iconKey: string | null | undefined,
): LucideIcon | undefined {
  const key = iconKey?.trim().replace(/Icon$/, "");
  if (!key) return undefined;
  return PLUGIN_ICON_OPTIONS.find((option) => option.key === key)?.icon ?? BRAND_ICONS.get(key);
}
