import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Material domains a picker can request for a new Material. */
export type AssetCreateMaterialDomain =
  | "surface"
  | "landscape"
  | "postProcess"
  | "particle";

export type AssetCreateRequest = {
  type: string;
  /** Preferred name (the picker's search text); the host makes it unique. */
  name?: string;
  materialDomain?: AssetCreateMaterialDomain;
};

/** Per-picker fields added to every create request. */
export type AssetCreateOptions = Omit<AssetCreateRequest, "type" | "name">;

export type ClassCreateRequest = {
  parentClass: string;
  name?: string;
};

export type AssetCreateApi = {
  /** True when a "Create New" row may be offered for this asset type. */
  canCreate: (type: string) => boolean;
  /** Title Case type label for the row (`Render Target`). */
  typeLabel: (type: string) => string;
  /** Creates the asset and resolves with its guid once pickers can list it. */
  createAsset: (request: AssetCreateRequest) => Promise<string>;
  /** Creates a Class asset and resolves with its class id. */
  createClass?: (request: ClassCreateRequest) => Promise<string>;
};

const AssetCreateContext = createContext<AssetCreateApi | null>(null);

/** Supplies asset creation to AssetPicker and ClassPicker "Create New" rows. */
export function AssetCreateProvider({
  value,
  children,
}: {
  value: AssetCreateApi;
  children: ReactNode;
}) {
  return (
    <AssetCreateContext.Provider value={value}>
      {children}
    </AssetCreateContext.Provider>
  );
}

export function useAssetCreate(): AssetCreateApi | null {
  return useContext(AssetCreateContext);
}

/**
 * Shared create-then-pick flow for picker "Create New" rows. The pick runs after
 * the render that follows creation, so `onPick` sees the refreshed asset list.
 * Closing the dialog while a create is pending drops that pick.
 */
export function usePickerCreate({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (id: string) => void;
}) {
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useRef(0);
  const latest = useRef({ onOpenChange, onPick });
  useLayoutEffect(() => {
    latest.current = { onOpenChange, onPick };
  });
  useLayoutEffect(() => {
    if (open) return;
    session.current += 1;
    setCreatingId(null);
    setCreatedId(null);
    setError(null);
  }, [open]);
  useEffect(() => {
    if (createdId === null) return;
    setCreatedId(null);
    setCreatingId(null);
    latest.current.onPick(createdId);
    latest.current.onOpenChange(false);
  }, [createdId]);

  const run = async (rowId: string, create: () => Promise<string>) => {
    if (creatingId !== null) return;
    const started = session.current;
    setCreatingId(rowId);
    setError(null);
    try {
      const id = await create();
      if (session.current === started) setCreatedId(id);
    } catch (cause) {
      if (session.current !== started) return;
      setCreatingId(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return { creatingId, error, run };
}
