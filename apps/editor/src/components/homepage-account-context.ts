import { createContext, useContext } from "react";
import type { NativeClerkSession } from "../services/native-clerk";
import type {
  NativeProfileActions,
  NativeProfileEditing,
} from "./homepage-account-types";

export type NativeHomepageAccount = {
  session: NativeClerkSession;
  signOut: () => Promise<void>;
  profile: NativeProfileActions;
};

export const NativeHomepageAccountContext =
  createContext<NativeHomepageAccount | null>(null);

export function useNativeHomepageAccount() {
  return useContext(NativeHomepageAccountContext);
}

/** The Account dialog's view of a native account's editable profile. */
export function nativeProfileEditing({
  session,
  profile,
}: NativeHomepageAccount): NativeProfileEditing {
  return {
    ...profile,
    firstName: session.firstName ?? "",
    lastName: session.lastName ?? "",
    hasImage: Boolean(session.imageUrl),
    canDelete: session.deleteSelfEnabled === true,
  };
}
