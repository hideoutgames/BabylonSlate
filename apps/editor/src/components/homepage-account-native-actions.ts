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
    | "updateName"
    | "setProfileImage"
    | "removeProfileImage"
    | "beginReverification"
    | "resendReverificationCode"
    | "completeReverification"
    | "deleteAccount"
  >,
  session: NativeClerkSession,
  owner: {
    onSession: (next: NativeClerkSession) => void;
    onDeleted: () => void;
    /** Only the mobile account gate hides the app during a foreground check. */
    holdSessionCheck?: () => () => void;
  },
): NativeProfileActions {
  return {
    holdSessionCheck: owner.holdSessionCheck ?? (() => () => {}),
    updateName: async (name) =>
      owner.onSession(await client.updateName(session, name)),
    setImage: async (file) =>
      owner.onSession(await client.setProfileImage(session, file)),
    removeImage: async () =>
      owner.onSession(await client.removeProfileImage(session)),
    sendDeleteCode: (pending) =>
      pending
        ? client.resendReverificationCode(pending)
        : client.beginReverification(session),
    // Deleting is the last step: a wrong code or a lapsed verification stops here.
    deleteAccount: async (pending, code) => {
      await client.completeReverification(pending, code);
      await client.deleteAccount(session);
      owner.onDeleted();
    },
  };
}
