import { useMemo, useSyncExternalStore } from "react";
import { useRegistryState } from "../context/document-context";
import { areaEmissionPreparationsRevision, areaEmissionStatusDescription, subscribeAreaEmissionPreparations } from "./area-emission-preparation";

/** Inspector notes for emission Textures, current with the registry and automatic jobs. */
export function useAreaEmissionStatus(): (guid: string) => string | undefined {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const preparations = useSyncExternalStore(subscribeAreaEmissionPreparations, areaEmissionPreparationsRevision);
  return useMemo(() => {
    void registryEpoch;
    void preparations;
    return (guid: string) => areaEmissionStatusDescription(assetRegistry?.getByGuid(guid));
  }, [assetRegistry, registryEpoch, preparations]);
}
