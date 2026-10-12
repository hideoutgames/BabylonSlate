import { useMemo } from "react";
import { useRegistryState } from "../context/document-context";
import { FEATURE_TEST_CHECK_SCENES } from "../services/feature-test-check";

/** True when the open project contains the Feature Test starter's scenes. */
export function useIsFeatureTestProject(): boolean {
  const { assetRegistry, registryEpoch } = useRegistryState();
  return useMemo(
    () => Boolean(assetRegistry && FEATURE_TEST_CHECK_SCENES.every((scene) => assetRegistry.getByPath(scene.path))),
    // registryEpoch advances when assets are added, moved or removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assetRegistry, registryEpoch],
  );
}
