import { useEffect, useRef } from "react";
import { ArrowUpRightIcon, MoreHorizontalIcon } from "lucide-react";
import { ContextMenuOverlay, useContextMenu } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
import type { ListedProject } from "../lib/listed-projects";
import { displayProjectName } from "../lib/display-project-name";
import { ProjectIdentityBadge } from "./homepage-project-identity";
import { useHomepageCardTouch } from "./use-homepage-card-touch";

export function HomepageProjectCard({
  project,
  busy,
  layout = "large",
  deleting,
  onOpen,
  onEdit,
  onRemove,
}: {
  project: ListedProject;
  busy: boolean;
  layout?: "large" | "small" | "list";
  deleting: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const name = displayProjectName(project.label);
  const holding = useRef(false);
  const { menu, closeMenu, bind, openMenuAt } = useContextMenu({
    enabled: !busy,
    items: [
      {
        id: "open",
        label: "Open",
        testId: "homepage-project-open",
        onSelect: onOpen,
      },
      {
        id: "edit",
        label: "Edit",
        testId: "homepage-project-rename",
        onSelect: onEdit,
      },
      {
        id: "remove",
        label: deleting ? "Delete" : "Remove From List",
        testId: "homepage-project-remove",
        onSelect: onRemove,
      },
    ],
  });
  const touch = useHomepageCardTouch(!busy && !menu?.open);
  useEffect(() => {
    if (menu?.open) {
      holding.current = true;
      return;
    }
    const id = requestAnimationFrame(() => {
      holding.current = false;
    });
    return () => cancelAnimationFrame(id);
  }, [menu?.open]);

  return (
    <Card
      className="homepage-project-card"
      data-layout={layout}
      data-color={project.appearance?.color ?? "stone"}
      data-testid={`open-listed-project-${project.name}`}
      {...bind}
      onPointerEnter={touch.onPointerEnter}
      onPointerDown={(event) => {
        if (touch.onPointerDown(event)) bind.onPointerDown(event);
      }}
      onKeyDown={(event) => {
        if (
          event.key === "ContextMenu" ||
          (event.key === "F10" && event.shiftKey)
        ) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          openMenuAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
        }
      }}
    >
      <CardContent className="homepage-project-well">
        <ProjectIdentityBadge appearance={project.appearance} />
      </CardContent>
      <CardHeader className="homepage-project-caption">
        <CardTitle>{name}</CardTitle>
        <ArrowUpRightIcon aria-hidden="true" />
      </CardHeader>
      <Button
        className="homepage-card-open"
        variant="ghost"
        aria-label={`Open Project ${name}`}
        disabled={busy}
        onClick={(event) => {
          // Keyboard/assistive activation must not be swallowed by the hold release guard.
          if (
            touch.shouldActivate(event) &&
            (event.detail === 0 || !holding.current)
          )
            onOpen();
        }}
      />
      <Button
        variant="ghost"
        size="touch-icon"
        className="homepage-project-actions"
        aria-label={`Project Actions for ${name}`}
        disabled={busy}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          openMenuAt(rect.right, rect.bottom);
        }}
      >
        <MoreHorizontalIcon />
      </Button>
      <ContextMenuOverlay
        menu={menu}
        onClose={closeMenu}
        contentTestId="homepage-project-menu"
      />
    </Card>
  );
}
