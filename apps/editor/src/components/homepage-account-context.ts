import { createContext, useContext } from "react";
import type { NativeClerkSession } from "../services/native-clerk";

export type NativeHomepageAccount = {
  session: NativeClerkSession;
  signOut: () => Promise<void>;
};

export const NativeHomepageAccountContext =
  createContext<NativeHomepageAccount | null>(null);

export function useNativeHomepageAccount() {
  return useContext(NativeHomepageAccountContext);
}
