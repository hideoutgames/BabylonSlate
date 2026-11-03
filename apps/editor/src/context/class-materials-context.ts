import { createContext } from "react";

/**
 * The Materials and Material Instances the edited Class's own and inherited mesh components draw
 * with (sorted guids). The Class graph canvas provides it, so Set, Get and Reset Material
 * Parameter nodes can list the parameter names those Materials declare.
 */
export const ClassMaterialsContext = createContext<readonly string[]>([]);
