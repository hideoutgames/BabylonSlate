import { useMemo, useState } from "react";
import {
  ArrowUpDownIcon,
  BoxIcon,
  FileIcon,
  Grid2x2Icon,
  LayoutTemplateIcon,
  PlusIcon,
} from "lucide-react";
import { SearchInput } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { HomepageGallery } from "./homepage-gallery";
import { TemplatePickCard } from "./homepage-template-card";

export type HomepageTemplate = { id: string; name: string; imageUrl?: string };
const usageKey = "slate:template-usage";
function readUsage(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(usageKey) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}
export function recordTemplateUse(id: string) {
  try {
    const usage = readUsage();
    usage[id] = (Number(usage[id]) || 0) + 1;
    localStorage.setItem(usageKey, JSON.stringify(usage));
  } catch {
    /* Optional preference. */
  }
}
export function homepageTemplates(templates: HomepageTemplate[]) {
  return [
    { id: "blank", name: "Blank", icon: FileIcon, imageUrl: undefined },
    { id: "empty", name: "Basic 3D", icon: BoxIcon, imageUrl: undefined },
    { id: "2d", name: "Basic 2D", icon: Grid2x2Icon, imageUrl: undefined },
    ...templates.map((template) => ({
      ...template,
      id: `template:${template.id}`,
      icon: LayoutTemplateIcon,
    })),
  ];
}
export function HomepageTemplateBrowser({
  templates,
  selected,
  disabled,
  onSelect,
  onImport,
  composing = false,
}: {
  templates: HomepageTemplate[];
  selected?: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onImport?: () => void;
  composing?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("frequent");
  const [usage] = useState(readUsage);
  const choices = useMemo(() => {
    const filtered = homepageTemplates(templates).filter((template) =>
      template.name
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
    );
    return filtered.sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : (Number(usage[b.id]) || 0) - (Number(usage[a.id]) || 0),
    );
  }, [templates, search, sort, usage]);
  return (
    <div className="homepage-template-browser">
      <div className="homepage-template-toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search Templates"
          data-testid="homepage-template-search"
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="touch-icon"
                aria-label="Sort Templates"
              />
            }
          >
            <ArrowUpDownIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="homepage-theme" align="end">
            <DropdownMenuGroup>
              <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
                <DropdownMenuRadioItem closeOnClick value="frequent">
                  Most Used
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem closeOnClick value="name">
                  Name A-Z
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {onImport && (
          <Button
            variant="ghost"
            size="touch-icon"
            aria-label="Add Template"
            disabled={disabled}
            onClick={onImport}
          >
            <PlusIcon />
          </Button>
        )}
      </div>
      <HomepageGallery
        label="Templates"
        items={choices.map((choice) => ({
          id: choice.id,
          content: (
            <TemplatePickCard
              title={choice.name}
              icon={choice.icon}
              imageUrl={choice.imageUrl}
              selected={choice.id === selected}
              disabled={disabled}
              testId={
                composing
                  ? `create-project-${choice.id}`
                  : `homepage-start-${choice.id}`
              }
              onSelect={() => onSelect(choice.id)}
            />
          ),
        }))}
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Templates Found</EmptyTitle>
            </EmptyHeader>
          </Empty>
        }
      />
    </div>
  );
}
