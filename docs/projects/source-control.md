# Source Control

When a team shares a project through Git, Haptic can lock the files you edit with Git LFS file locking, so two people don't change the same asset at once.

Haptic handles locks only. Clone, commit, pull and push with your Git app, such as Working Copy on iPad or a desktop Git client. Source Control is available in the iPad, iPhone, Android and desktop apps, not on the web, and is off until you turn it on for a project.

## Before you start

- Keep the project in a folder that is a Git working copy (see [Where Projects Live](storage.md)).
- The repository must use Git LFS, on a host that supports LFS file locking such as GitHub, GitLab or Gitea.
- Create an access token on your Git host. On GitHub, use a classic token with **repo** scope or a fine-grained token with **Contents: Read and Write**. GitLab and Gitea tokens need push access.

## Turn it on

1. Open **Project Settings > Source Control** and turn on **Enable**. Haptic fills in the repository and branch from the folder's Git settings when it can read them.
2. Check the settings below.
3. Paste your token into **Token** and choose **Save Token**.

| Setting | Description |
| --- | --- |
| Enable | Turns locking on for this project. |
| Repository URL | The repository's HTTPS or SSH address. Haptic always talks to it over HTTPS. |
| Branch | The branch the locks belong to. Default `main`. |
| Auto-Lock On First Edit | Lock a file the first time you edit it in this session. On by default. |
| Poll Interval (Seconds) | How often Haptic checks other people's locks. Default 60. |
| Token | Your access token. **Save Token** stores it on this device for this project; **Clear Token** removes it. |

The token is never written to the project files or to Git. Each person, on each device, saves their own.

## Working with locks

- **Your edits:** with Auto-Lock on, the first change to a document locks its file. If locking fails, the edit still applies and an **Unlocked** banner warns you.
- **Someone else's lock:** the document opens read-only with a **Locked by** banner showing the owner and how long ago they locked it. Choose **Edit Anyway** only after talking to them; your changes may conflict.
- **Content Browser:** locked assets show a lock badge, **Locked By You** or **Locked By** the owner's name.
- **Renaming and moving:** your locks move with the file. Haptic refuses to rename, move or delete a file someone else has locked.

## The Locks window

When Source Control is on, the **Windows** menu has **Locks**. It lists every lock with its path, owner and age.

| Control | Description |
| --- | --- |
| Refresh | Check locks now. |
| Release | Release one of your locks. |
| Release All My Locks | Release all your locks. Unpushed work becomes editable by others. |
| Force Unlock | Remove someone else's lock, after a confirmation. They may still have unpushed changes. |

Locks are released only when you choose to. Closing a document or the project keeps them, so release them after you push.

If a check fails, the window keeps showing the last known locks and says the status is unavailable.

## After a pull or branch switch

When you come back to Haptic after your Git app changed files, Haptic offers to reload them. See [Files changed outside Haptic](../editor/undo-and-saving.md#files-changed-outside-haptic).
