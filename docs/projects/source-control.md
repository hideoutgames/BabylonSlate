# Source Control

When a team shares a project through Git, Haptic can lock the files you edit with Git LFS file locking, so two people don't change the same asset at once.

In **Manual** mode Haptic handles locks only: clone, commit, pull and push with your Git app, such as Working Copy on iPad or a desktop Git client. Source Control is available in the iPad, iPhone, Android and desktop apps, not on the web, and is **Off** for a project until you turn it on. While it is Off, Haptic shows nothing for it and never contacts a Git host.

## Before you start

- Keep the project in a folder that is a Git working copy whose top folder is the project folder (see [Where Projects Live](storage.md)).
- The repository must use Git LFS, on a host with LFS file locking, such as GitHub, GitLab or Gitea.
- Link your Git host account on this device, in **Engine Settings > Source Control**.

## Link your accounts

Accounts belong to this device, not to a project: each person signs in once on each device, and every project on that host uses it. Open **Engine Settings > Source Control**, from the Homepage or the editor.

| Section | What it holds |
| --- | --- |
| Accounts | **GitHub** and **GitLab** (gitlab.com). Each row shows the signed-in user with **Sign Out**, or **Sign In**. |
| Self-Managed GitLab | Your own GitLab instance: enter its **Instance URL** and a personal access token in **Token**, then choose **Save Token**. Saved instances are listed with **Remove**. |
| Other Git Hosts | Any other host, such as Gitea: enter its **Host URL** and an access token, then choose **Add Host**. Each saved host shows **Token Saved** with **Remove**. |

Use a token with push access to the repository. Haptic sends a token only to the host it was saved for, always over HTTPS, and never writes it to the project files or to Git.

### The link warning

Every time you link a host, by signing in or by saving a token, Haptic first asks **Link GitHub?** (or the host's name) and explains that Haptic will clone, pull, commit, push and lock files in your repositories from this device, that you use the integration at your own risk, and that you should keep backups of important projects. **Accept** goes on to sign in or save the token. **Decline** closes the warning and saves nothing.

### Signing in to GitHub or GitLab

After you accept, **Sign In To GitHub** (or **Sign In To GitLab**) shows a code.

1. Choose **Copy** to copy the code.
2. Choose **Open GitHub** (or **Open GitLab**). The sign-in page opens in your browser.
3. Enter the code there and approve Haptic.
4. Come back to Haptic. The dialog closes by itself once the host approves, and the row shows your user name.

The dialog shows how long the code stays valid. If the code expires or you deny access, choose **Try Again** for a new code. **Cancel** stops waiting.

A GitLab sign-in renews itself in the background. If GitLab no longer accepts it, Haptic signs you out of GitLab on this device and the sign-in banner returns.

## Turn it on for a project

1. Open **Project Settings > Source Control** and set **Mode** to **Manual**. If no repository is set yet, Haptic fills in the repository and branch from the folder's Git settings when it can read them. When it cannot, Mode stays **Off** until you enter a repository.
2. Check the settings below.

| Setting | Description |
| --- | --- |
| Mode | **Off**: no Source Control. **Manual**: your Git app syncs the files, and Haptic locks them. |
| Repository | The repository's HTTPS or SSH address. Signed in to GitHub or GitLab, choose it from your repositories; **Use Typed URL** in the list takes an address on another host. Haptic always talks to the host over HTTPS; for an SSH address it uses the same host on the standard HTTPS port. |
| Branch | The branch the locks belong to. Default `main`. Signed in to the repository's host, choose it from the host's branches. |
| Account | Who you are signed in as on the repository's host, or **Not Signed In** with **Sign In**. |
| Auto-Lock On First Edit | Lock a file the first time you edit it in this session. On by default. |

Setting **Mode** back to **Off** asks first. Your locks stay until you release them.

If you open a project in Manual mode on a device that has no account for its host, a banner says **This project uses GitHub file locking.** (or the host's name) with **Sign In**. Until you sign in, Haptic doesn't check or take any locks. For a host that takes a token, **Sign In** opens **Engine Settings > Source Control**.

## Working with locks

- **Your edits:** with Auto-Lock on, the first change to a document locks its file. If locking fails, the edit still applies and an **Unlocked** banner warns you.
- **Someone else's lock:** the document opens read-only with a **Locked by** banner showing the owner and how long ago they locked it. Choose **Edit Anyway** only after talking to them; your changes may conflict.
- **Content Browser:** locked assets show a lock badge, **Locked By You** or **Locked By** the owner's name.
- **Renaming and moving:** your locks move with the file. Haptic refuses to rename, move or delete a file someone else has locked.

Haptic checks locks every minute while it is in the foreground.

## The Source Control tab

While a project's mode is not Off, the **Source Control** tab sits at the right end of the document tabs, beside **Open Documents**. It can't be closed. In the phone layout, which has no tabs, a **Source Control** button beside the **Content Browser** button opens it.

In Manual mode the tab holds the **Locks** window. It lists every lock with its path, owner and age.

| Control | Description |
| --- | --- |
| Refresh | Check locks now. |
| Release Pushed Locks | Release your locks on files you have already pushed. GitHub and GitLab only. |
| Release All My Locks | Release all your locks, after a confirmation. Unpushed work becomes editable by others. |
| Release | Release one of your locks. |
| Force Unlock | Remove someone else's lock, after a confirmation. They may still have unpushed changes. |

Locks are released only when you choose to. Closing a document or the project keeps them, so release them after you push.

### Release Pushed Locks

On GitHub and GitLab, each of your locks shows **Pushed** when the file on your device is exactly the file on the branch, and **Not Pushed** when it isn't there yet or differs. **Release Pushed Locks** checks the branch again and releases only the locks marked **Pushed**. It leaves a lock alone while its document has unsaved changes.

### When a check fails

If a check fails, the window keeps showing the last known locks and says the status is unavailable. On GitHub or GitLab, **Repository Not Found Or No Access** means your account can't see the repository: check the repository address and that you are signed in with an account that has access. On another host that has no file locking at all, the window says **This Host Does Not Support File Locking.** and Haptic stops trying to lock files on it.

## After a pull or branch switch

When you come back to Haptic after your Git app changed files, Haptic offers to reload them. See [Files changed outside Haptic](../editor/undo-and-saving.md#files-changed-outside-haptic).
