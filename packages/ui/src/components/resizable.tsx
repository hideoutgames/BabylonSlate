import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "#lib/utils";

function ResizablePanelGroup({
  className,
  resizeTargetMinimumSize = { coarse: 0, fine: 0 },
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className,
      )}
      // The separator owns its hit area, including its transparent edges.
      // Keep the library from claiming gestures beyond that element.
      resizeTargetMinimumSize={resizeTargetMinimumSize}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  withHandle,
  className,
  disabled,
  onPointerDown,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative z-10 -mx-[2.5px] flex w-1.5 items-center justify-center bg-transparent p-0 ring-offset-background after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:mx-0 aria-[orientation=horizontal]:-my-[2.5px] aria-[orientation=horizontal]:h-1.5 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:inset-y-auto aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-px aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90 [@media(pointer:coarse)]:-mx-[calc((var(--touch-target)-1px)/2)] [@media(pointer:coarse)]:w-(--touch-target) [@media(pointer:coarse)]:aria-[orientation=horizontal]:mx-0 [@media(pointer:coarse)]:aria-[orientation=horizontal]:-my-[calc((var(--touch-target)-1px)/2)] [@media(pointer:coarse)]:aria-[orientation=horizontal]:h-(--touch-target) [@media(pointer:coarse)]:aria-[orientation=horizontal]:w-full",
        className,
      )}
      disabled={disabled}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (disabled || event.pointerType !== "mouse" || event.button !== 0)
          return;
        // Adjacent editor controls may stop pointermove propagation. Capture
        // before leaving the divider so the library receives the first move.
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      {...props}
    >
      {withHandle && (
        <div className="pointer-events-none z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
