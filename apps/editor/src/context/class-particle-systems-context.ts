import { createContext } from "react";

/**
 * The Particle Systems the edited Class's own and inherited Particle components play (sorted
 * guids). The Class graph canvas provides it, so particle parameter nodes on Self can list the
 * parameter names those Systems declare.
 */
export const ClassParticleSystemsContext = createContext<readonly string[]>([]);
