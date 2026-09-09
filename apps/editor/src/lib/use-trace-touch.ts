import { usePlatformLayoutOptions } from "../shell/use-platform-layout";

export function useTraceTouch(): boolean {
  return usePlatformLayoutOptions().dndStrategy === "pointer";
}
