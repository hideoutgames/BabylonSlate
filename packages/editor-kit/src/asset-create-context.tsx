import { createContext, useContext, type ReactNode } from "react";

/** Material domains a picker can request for a new Material. */
export type AssetCreateMaterialDomain =
  | "surface"
  | "landscape"
  | "postProcess"
  | "particle"
  | "text";

export type AssetCreateRequest = {
  type: string;
  /** Preferred name (the picker's search text); the host makes it unique. */
  name?: string;
  materialDomain?: AssetCreateMaterialDomain;
  /**
   * Path of the document that will hold the reference; the host creates the
   * asset in that document's content. `null` means the project itself (the
   * project content root). Omit to use the active document.
   */
  ownerPath?: string | null;
};

/** Per-picker fields added to every create request. */
export type AssetCreateOptions = Omit<AssetCreateRequest, "type" | "name">;

export type ClassCreateRequest = {
  parentClass: string;
  name?: string;
  /** Same as `AssetCreateRequest.ownerPath`. */
  ownerPath?: string | null;
};

/** Per-picker fields added to every Class create request. */
export type ClassCreateOptions = Omit<ClassCreateRequest, "parentClass" | "name">;

export type AssetCreateApi = {
  /** True when a "Create New" row may be offered for this asset type. */
  canCreate: (type: string) => boolean;
  /** Title Case type label for the row (`Render Target`). */
  typeLabel: (type: string) => string;
  /** Creates the asset and resolves with its guid once pickers can list it. */
  createAsset: (request: AssetCreateRequest) => Promise<string>;
  /** Creates a Class asset and resolves with its class id. */
  createClass?: (request: ClassCreateRequest) => Promise<string>;
  /**
   * True when a new Class may have this parent (New Asset's parent rule).
   * Omitted means every parent is allowed.
   */
  canCreateClass?: (parentClass: string) => boolean;
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
