import { useMemo, useState } from "react";
import {
  ArrowUpDownIcon,
  BoxIcon,
  FileIcon,
  Grid2x2Icon,
  LayersIcon,
  LayoutTemplateIcon,
  PackageIcon,
  PlusIcon,
  SparklesIcon,
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
    {
      id: "blank",
      name: "Blank",
      description: "Empty Project",
      icon: FileIcon,
      imageUrl: undefined,
    },
    {
      id: "empty",
      name: "Basic 3D",
      description: "Starter 3D Scene",
      icon: BoxIcon,
      imageUrl: undefined,
    },
    {
      id: "2d",
      name: "Basic 2D",
      description: "Starter 2D Scene",
      icon: Grid2x2Icon,
      imageUrl: undefined,
    },
    ...templates.map((template) => ({
      ...template,
      id: `template:${template.id}`,
      description: "Installed Template",
      icon: LayoutTemplateIcon,
    })),
  ];
}

const TEMPLATE_CATEGORIES = [
  { id: "all", label: "All Templates", icon: LayersIcon },
  { id: "starters", label: "Starters", icon: SparklesIcon },
  { id: "installed", label: "Installed", icon: PackageIcon },
] as const;
type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]["id"];

function inCategory(id: string, category: TemplateCategory) {
  if (category === "all") return true;
  return id.startsWith("template:") === (category === "installed");
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
  const [category, setCategory] = useState<TemplateCategory>("all");
  const [usage] = useState(readUsage);
  const all = useMemo(() => homepageTemplates(templates), [templates]);
  const choices = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = all.filter(
      (template) =>
        inCategory(template.id, category) &&
        template.name.toLocaleLowerCase().includes(query),
    );
    return filtered.sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : (Number(usage[b.id]) || 0) - (Number(usage[a.id]) || 0),
    );
  }, [all, category, search, sort, usage]);
  const searchField = (
    <SearchInput
      value={search}
      onChange={setSearch}
      placeholder="Search Templates…"
      aria-label="Search Templates"
      data-testid="homepage-template-search"
    />
  );
  const sortMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant={composing ? "ghost" : "outline"}
            size="sm"
            aria-label="Sort Templates"
          />
        }
      >
        <ArrowUpDownIcon data-icon="inline-start" />
        <span className="homepage-optional-label">
          {composing ? (sort === "name" ? "Name A-Z" : "Most Used") : "Sort"}
        </span>
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
  );
  const importButton = onImport && (
    <Button
      variant="outline"
      size="sm"
      className="homepage-template-import"
      aria-label="Add Template"
      disabled={disabled}
      onClick={onImport}
    >
      <PlusIcon data-icon="inline-start" />
      <span className="homepage-optional-label">Add Template</span>
    </Button>
  );
  const gallery = (
    <HomepageGallery
      label="Templates"
      items={choices.map((choice) => ({
        id: choice.id,
        content: (
          <TemplatePickCard
            title={choice.name}
            description={choice.description}
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
  );

  if (composing) {
    const heading =
      TEMPLATE_CATEGORIES.find((entry) => entry.id === category)?.label ??
      "All Templates";
    return (
      <div className="homepage-template-browser" data-composing="true">
        <aside className="homepage-template-sidebar">
          {searchField}
          <div
            className="homepage-template-categories"
            role="group"
            aria-label="Template Category"
          >
            {TEMPLATE_CATEGORIES.map((entry) => (
              <Button
                key={entry.id}
                type="button"
                variant="ghost"
                size="sm"
                className="homepage-template-category"
                aria-pressed={category === entry.id}
                onClick={() => setCategory(entry.id)}
              >
                <entry.icon data-icon="inline-start" />
                <span>{entry.label}</span>
                <span className="homepage-template-category-count">
                  {all.filter((template) => inCategory(template.id, entry.id))
                    .length}
                </span>
              </Button>
            ))}
          </div>
          {importButton}
        </aside>
        <section className="homepage-template-results">
          <div className="homepage-template-results-header">
            <h3>{heading}</h3>
            <span className="homepage-template-category-count">
              {choices.length}
            </span>
            {sortMenu}
          </div>
          {gallery}
        </section>
      </div>
    );
  }

  return (
    <div className="homepage-template-browser">
      <div className="homepage-template-toolbar">
        {searchField}
        {sortMenu}
        {importButton}
      </div>
      {gallery}
    </div>
  );
}
