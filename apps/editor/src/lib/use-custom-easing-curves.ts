import { useMemo } from "react";
import type { CustomEasingCurveRef } from "@haptic/core";
import { useRegistryState } from "../context/document-context";
import { projectCustomEasingCurves } from "./custom-easing-curves";

/** `projectCustomEasingCurves` for the open project, rebuilt when its asset registry changes. */
export function useProjectCustomEasingCurves(): readonly CustomEasingCurveRef[] {
  const { assetRegistry, registryEpoch } = useRegistryState();
  return useMemo(() => {
    void registryEpoch;
    return projectCustomEasingCurves(assetRegistry?.list() ?? []);
  }, [assetRegistry, registryEpoch]);
}
