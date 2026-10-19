import type {
  NativeClerkClient,
  NativeClerkSession,
} from "../services/native-clerk";
import type { NativeProfileActions } from "./homepage-account-types";

/**
 * Profile changes for the signed-in native account. The owner of the session
 * learns about the refreshed user, or that the account no longer exists.
 */
export function nativeProfileActions(
  client: Pick<
    NativeClerkClient,
    "updateName" | "setProfileImage" | "removeProfileImage" | "deleteAccount"
  >,
  session: NativeClerkSession,
  owner: {
    onSession: (next: NativeClerkSession) => void;
    onDeleted: () => void;
  },
): NativeProfileActions {
  return {
    updateName: async (name) =>
      owner.onSession(await client.updateName(session, name)),
    setImage: async (file) =>
      owner.onSession(await client.setProfileImage(session, file)),
    removeImage: async () =>
      owner.onSession(await client.removeProfileImage(session)),
    deleteAccount: async () => {
      await client.deleteAccount(session);
      owner.onDeleted();
    },
  };
}
