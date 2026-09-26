import type { SerializedScene } from "@babylonslate/core";
import { Separator } from "@babylonslate/ui/components/separator";
import { ToggleGroup, ToggleGroupItem } from "@babylonslate/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@babylonslate/ui/components/tooltip";
import { cn } from "@babylonslate/ui/lib/utils";
import { MountainIcon, TreesIcon } from "lucide-react";
import { useSceneTools } from "../context/scene-tools-context";
import { FOLIAGE_TOOL_GROUPS, LANDSCAPE_TOOL_GROUPS, type FoliageTool, type LandscapeTool } from "../lib/scene-brush-tools";
import type { SceneMode } from "../shell/scene-document-layout";

const TOOL_ITEM = "pointer-coarse:min-h-11 pointer-coarse:min-w-11";

function IslandSeparator() {
  return <Separator orientation="vertical" className="mx-0.5 data-vertical:h-5 data-vertical:self-center" />;
}

export function SceneBrushToolbar({ mode, scene, disabled }: { mode: SceneMode; scene: SerializedScene | null; disabled?: boolean }) {
  const tools = useSceneTools();
  const landscape = mode === "landscape";
  const groups = landscape ? LANDSCAPE_TOOL_GROUPS : FOLIAGE_TOOL_GROUPS;
  const active = landscape ? tools.landscapeTool : tools.foliageTool;
  const setTool = (value: string) => {
    if (landscape) tools.setLandscapeTool(value as LandscapeTool);
    else tools.setFoliageTool(value as FoliageTool);
  };
  const [actorId, componentId] = tools.landscapeSelection?.split("/") ?? [];
  const target = landscape
    ? scene?.actors.find((actor) => actor.id === actorId && actor.components.some((component) => component.id === componentId && component.classId === "LandscapeComponent"))?.name
    : scene?.settings.foliageGroups?.find((group) => group.id === tools.groupId)?.name;
  const TargetIcon = landscape ? MountainIcon : TreesIcon;
  return <div role="toolbar" aria-label={landscape ? "Landscape Tools" : "Foliage Tools"} className="flex flex-wrap items-center gap-1" data-testid="scene-brush-toolbar">
    {groups.map((group, index) => <div key={group[0]!.value} className="contents">
      {index > 0 && <IslandSeparator />}
      <ToggleGroup variant="outline" size="sm" spacing={0} disabled={disabled} value={group.some((tool) => tool.value === active) ? [active] : []}
        onValueChange={(values) => { if (values[0]) setTool(values[0]); }}>
        {group.map(({ value, label, icon: Icon }) => <Tooltip key={value}>
          <TooltipTrigger render={<ToggleGroupItem value={value} aria-label={label} className={TOOL_ITEM} data-testid={`scene-brush-tool-${value}`}><Icon /></ToggleGroupItem>} />
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>)}
      </ToggleGroup>
    </div>)}
    <IslandSeparator />
    <span className={cn("flex max-w-40 min-w-0 items-center gap-1.5 px-1.5 text-xs", !target && "text-muted-foreground")} data-testid="scene-brush-target">
      <TargetIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{target ?? (landscape ? "No Landscape" : "No Foliage Group")}</span>
    </span>
  </div>;
}
