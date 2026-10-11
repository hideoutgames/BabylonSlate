import { useCallback, useEffect, useRef } from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "#lib/utils"

type SliderProps = SliderPrimitive.Root.Props & {
  /**
   * Let a touch or pen press on the track jump the value, as a mouse click
   * always does. Off by default so a swipe that starts on the track scrolls
   * the surrounding panel and only the thumb drags. Opt in only inside
   * surfaces that do not scroll (colour picker strips).
   */
  trackJumpOnTouch?: boolean
}

function thumbValues(
  value: SliderPrimitive.Root.Props["value"],
  defaultValue: SliderPrimitive.Root.Props["defaultValue"],
  min: number,
): number[] {
  if (Array.isArray(value)) return value
  if (typeof value === "number") return [value]
  if (Array.isArray(defaultValue)) return defaultValue
  if (typeof defaultValue === "number") return [defaultValue]
  return [min]
}

function isThumbTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-slot="slider-thumb"]') !== null
  )
}

function Slider({
  className,
  "aria-label": ariaLabel,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ref,
  trackJumpOnTouch = false,
  ...props
}: SliderProps) {
  const thumbs = thumbValues(value, defaultValue, min)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref],
  )

  useEffect(() => {
    const root = rootRef.current
    if (!root || trackJumpOnTouch) return
    // Base UI commits a track press from its own touchstart listener on the
    // control. Stop track touches above it so the swipe can scroll instead.
    const onTouchStart = (event: TouchEvent) => {
      if (!isThumbTarget(event.target)) event.stopPropagation()
    }
    root.addEventListener("touchstart", onTouchStart, {
      capture: true,
      passive: true,
    })
    return () =>
      root.removeEventListener("touchstart", onTouchStart, { capture: true })
  }, [trackJumpOnTouch])

  return (
    <SliderPrimitive.Root
      className={cn("data-horizontal:w-full data-vertical:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
      ref={setRootRef}
    >
      <SliderPrimitive.Control
        className={cn(
          "relative flex w-full items-center select-none data-disabled:opacity-50 data-horizontal:min-h-[var(--touch-target,44px)] data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col",
          trackJumpOnTouch
            ? "touch-none"
            : "data-horizontal:touch-pan-y data-vertical:touch-pan-x",
        )}
        onPointerDown={(event) => {
          // Touch and pen change the value only from the thumb; a mouse click
          // on the track still jumps. Decided per event for hybrid devices.
          if (
            trackJumpOnTouch ||
            event.pointerType === "mouse" ||
            isThumbTarget(event.target)
          ) {
            return
          }
          event.preventBaseUIHandler()
        }}
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-full bg-muted select-none data-horizontal:h-1.5 data-horizontal:w-full data-vertical:h-full data-vertical:w-1.5"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-primary select-none data-horizontal:h-full data-vertical:w-full"
          />
        </SliderPrimitive.Track>
        {thumbs.map((_, index) => (
          <SliderPrimitive.Thumb
            aria-labelledby={props["aria-labelledby"]}
            data-slot="slider-thumb"
            key={index}
            index={index}
            aria-label={ariaLabel}
            className="relative block size-4 shrink-0 touch-none rounded-full border border-ring bg-background ring-ring/50 transition-[color,box-shadow] select-none after:absolute after:-inset-3.5 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
