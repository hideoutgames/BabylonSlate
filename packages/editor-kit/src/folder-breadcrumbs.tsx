import { useEffect, useRef } from "react";
import { ArrowUpIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { cn } from "@babylonslate/ui/lib/utils";

export interface FolderBreadcrumbsProps {
  root: { path: string; label: string };
  path: string;
  onNavigate: (path: string) => void;
  touch?: boolean;
}

/** Compact navigation confined to a content root, including plugin roots. */
export function FolderBreadcrumbs({
  root,
  path,
  onNavigate,
  touch = false,
}: FolderBreadcrumbsProps) {
  const tail = path.startsWith(`${root.path}/`)
    ? path.slice(root.path.length + 1)
    : "";
  const parts = tail.split("/").filter(Boolean);
  const crumbs = [
    root,
    ...parts.map((label, index) => ({
      label,
      path: `${root.path}/${parts.slice(0, index + 1).join("/")}`,
    })),
  ];
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    // Reveal the current folder without scrolling the containing panel or page.
    const list = listRef.current;
    if (list) list.scrollLeft = list.scrollWidth;
  }, [path]);
  return (
    <nav
      aria-label="Folder Location"
      className="flex min-w-0 items-center gap-1"
    >
      <Button
        variant="ghost"
        size={touch ? "touch-icon" : "icon-sm"}
        aria-label="Parent Folder"
        title="Parent Folder"
        disabled={crumbs.length === 1}
        onClick={() => onNavigate(crumbs[crumbs.length - 2]!.path)}
      >
        <ArrowUpIcon />
      </Button>
      <ol
        ref={listRef}
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-x-contain"
      >
        {crumbs.map((crumb, index) => (
          <li
            key={crumb.path}
            className="flex min-w-0 shrink-0 items-center gap-0.5"
          >
            {index > 0 ? (
              <ChevronRightIcon
                className="size-3 shrink-0 text-muted-foreground"
                aria-hidden
              />
            ) : null}
            {index === crumbs.length - 1 ? (
              <span
                aria-current="page"
                title={crumb.path}
                className={cn(
                  "max-w-64 truncate px-2 text-xs font-medium",
                  touch && "py-3 text-sm",
                )}
              >
                {crumb.label}
              </span>
            ) : (
              <Button
                variant="ghost"
                size={touch ? "touch" : "sm"}
                title={crumb.path}
                className="max-w-48"
                onClick={() => onNavigate(crumb.path)}
              >
                <span className="truncate">{crumb.label}</span>
              </Button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
