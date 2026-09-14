import { useReactFlow, useStore, type FitViewOptions } from "@xyflow/react";
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";

/** Canvas sibling so transformed or elevated nodes cannot cover navigation. */
export function GraphViewportControls({ fitViewOptions }: { fitViewOptions: FitViewOptions }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const atMinZoom = useStore((state) => state.transform[2] <= state.minZoom);
  const atMaxZoom = useStore((state) => state.transform[2] >= state.maxZoom);
  const actions = [
    { label: "Zoom In", Icon: PlusIcon, disabled: atMaxZoom, run: () => zoomIn() },
    { label: "Zoom Out", Icon: MinusIcon, disabled: atMinZoom, run: () => zoomOut() },
    { label: "Size Graph To Fit", Icon: MaximizeIcon, disabled: false, run: () => fitView(fitViewOptions) },
  ];

  return (
    <div
      role="group"
      aria-label="Graph Navigation"
      data-testid="graph-viewport-controls"
      className="absolute bottom-2 left-2 z-10 flex flex-col gap-1 rounded-lg border border-border bg-popover p-1 shadow-sm"
    >
      {actions.map(({ label, Icon, disabled, run }) => (
        <Tooltip key={label}>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="graph-viewport-control"
                aria-label={label}
                disabled={disabled}
                onClick={() => { void run(); }}
              />
            }
          >
            <Icon />
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
