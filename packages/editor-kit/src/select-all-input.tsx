import { type ComponentProps } from "react";
import { Input } from "@babylonslate/ui/components/input";
import { useSelectAllOnActivate } from "./select-all-on-activate";

/** Text `Input` that selects all on first click, tap, or Tab. */
export function SelectAllInput({
  onFocus,
  onBlur,
  onPointerDown,
  onPointerUp,
  onMouseUp,
  ...props
}: ComponentProps<typeof Input>) {
  const selectAll = useSelectAllOnActivate();
  return (
    <Input
      {...props}
      onFocus={(event) => {
        selectAll.onFocus(event);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        selectAll.onBlur();
        onBlur?.(event);
      }}
      onPointerDown={(event) => {
        selectAll.onPointerDown();
        onPointerDown?.(event);
      }}
      onPointerUp={(event) => {
        selectAll.onPointerUp(event);
        onPointerUp?.(event);
      }}
      onMouseUp={(event) => {
        selectAll.onMouseUp(event);
        onMouseUp?.(event);
      }}
    />
  );
}
