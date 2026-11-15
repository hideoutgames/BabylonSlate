# Source Control

When a team shares a project through Git, Haptic can sync it for you and lock the files you edit with Git LFS file locking, so two people don't change the same asset at once.

Source Control is available in the iPad, iPhone, Android and desktop apps, not on the web, and is **Off** for a project until you turn it on. While it is Off, Haptic shows nothing for it and never contacts a Git host.

| Mode | Who syncs | What Haptic does |
| --- | --- | --- |
| Off | Nobody | Nothing. |
| Integrated | Haptic | Clones, commits, pulls and pushes the project, stores large asset data with Git LFS, and locks files. |
| Manual | Your Git app, such as Working Copy on iPad or a desktop Git client | Locks files only. |

Only one Git app may work in a project folder at a time. Integrated projects come from **Clone** or **Publish**; a folder another Git app syncs stays in Manual mode.

## Link your accounts

Accounts belong to this device, not to a project: each person signs in once on each device, and every project on that host uses it. Open **Engine Settings > Source Control**, from the Homepage or the editor.

| Section | What it holds |
| --- | --- |
| Accounts | **GitHub** and **GitLab** (gitlab.com). Each row shows the signed-in user with **Sign Out**, or **Sign In**. |
| Self-Managed GitLab | Your own GitLab instance: enter its **Instance URL** and a personal access token in **Token**, then choose **Save Token**. Saved instances are listed with **Remove**. |
| Other Git Hosts | Any other host, such as Gitea: enter its **Host URL** and an access token, then choose **Add Host**. Each saved host shows **Token Saved** with **Remove**. |

Use a token with push access to the repository. Haptic sends a token only to the host it was saved for, always over HTTPS, and never writes it to the project files or to Git.

Commits you make in Haptic name your account on the repository's host as their author. With GitHub or GitLab sign-in they use the host's private no-reply email, so the host links them to your account without showing your email address.

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

## Clone a project

On the Homepage, choose **Clone** next to **New Project**.

1. Choose **GitHub**, **GitLab** or **URL**. For GitHub and GitLab, the dialog shows who you are signed in as, or **Sign In**.
2. Pick a repository from the list (search it by name), or type its address under **URL**. A host other than GitHub or GitLab needs a token in **Engine Settings > Source Control** first.
3. Choose the **Branch** and a **Project Name**, then choose **Clone**.

Haptic clones the branch into its own storage (the Projects folder on desktop, the app's documents on iPad, iPhone and Android) and opens it in Integrated mode. **Cancel** stops a clone and removes what it had copied. The branch must hold a Haptic project.

## Publish a project

To put a project that has no repository yet on GitHub or GitLab, open **Project Settings > Source Control** while **Mode** is **Off** and choose **Publish Project…**.

| Field | Description |
| --- | --- |
| Host | **GitHub** or **GitLab**. You need to be signed in to it. |
| Owner | Your account, or an organization (on GitLab, a group) you can create repositories in. |
| Repository Name | The new repository's name. |
| Visibility | **Private** or **Public**. |

The dialog sums up what Publish does: the repository it creates, the Git LFS settings and ignore list it adds, and how many assets and how much data it pushes, with the share stored through Git LFS. Save your documents first. **Publish** creates the empty repository, commits the whole project, pushes it and switches the project to Integrated mode.

On iPad, iPhone and Android, only a project in Haptic's own storage can be published. On desktop, any project folder can.

## Integrated mode

### The Changes window

In Integrated mode the **Source Control** tab opens on **Changes**, with **Locks** beside it. The tab shows how many assets have uncommitted changes.

- The top row shows the branch, **Refresh**, and **Pull** and **Push** with the number of commits each would bring in or send.
- The status line says how many commits there are to pull and to push, and when Haptic last checked.
- **Changes** lists each changed asset with its type, folder and **A** (added), **M** (modified) or **D** (deleted). A lock icon marks assets you have locked. An asset's change includes the large data stored with it, so it is always committed whole. Project settings and other project files appear by name.
- **Incoming** lists the newest commits waiting to be pulled, with their author and age.

Haptic reads changes after you save and when you come back to the app, and checks the host when you open the project, come back to the app, choose **Refresh** and after a push.

### Commit and push

1. Clear the checkbox of any asset you don't want in this commit.
2. Type a **Commit Message**.
3. Keep **Push After Commit** on to send the commit at once, or turn it off to commit only on this device.
4. Choose **Commit N Assets**.

**Push** sends your commits. Before it does, Haptic checks the locks on what it sends and refuses if someone else has locked one of those assets, naming who. With **Release Locks After Push** on, a push then releases your locks on the assets it sent, except any you have changed again or have unsaved edits in.

If the host has moved on since your last pull, the push is refused: pull first.

### Pull

**Pull** brings in your teammates' commits:

1. If documents have unsaved changes, choose **Save All** or **Discard** first.
2. Confirm. A pull replaces files and cannot be undone.
3. If an asset changed both on your device and on the branch, **Pull Conflicts** lists each one. Choose **Keep Mine** or **Take Theirs** for every asset; **Apply And Finish Pull** stays unavailable until each has a choice. **Cancel Pull** changes nothing.

Open documents whose files the pull changed reload, as after any change on disk. An asset you kept stays as an uncommitted change, ready to commit and push.

### Repositories Haptic didn't publish

A repository needs a Git LFS rule for the data Haptic stores beside assets. If a commit is refused because it is missing, choose **Add Git LFS Rule**: Haptic adds the rule to `.gitattributes`, commits it, and you can commit again.

### The status bar

In Integrated mode the status bar starts with the branch. Its menu holds **Commit…**, **Pull**, **Push**, **Refresh** and **Open Source Control**. Next to it, **N Changes** opens the Changes window, and **Pull N** and **Push N** appear when there is something to pull or push. While a pull, push or publish runs, its progress takes their place. When a commit, pull or push fails, its reason (such as **Could Not Push**) appears there too and opens the Changes window, which says what went wrong. On the right, a small **Saved** shows that everything is saved; save problems such as **Auto-Save Failed — Use Save All** show there instead.

In the phone layout, which has no status bar, **More Tools** holds the same actions; when one fails, the Changes window opens to say why.

### On desktop: an existing Git folder

On desktop, a project folder that is already a Git working copy can switch to **Integrated** in **Project Settings > Source Control**. Haptic first warns that no other Git app may use the folder at the same time, then takes the repository and branch from the folder's Git settings. On iPad, iPhone and Android, such a folder stays in Manual mode.

## Manual mode

Keep the project in a folder that is a Git working copy whose top folder is the project folder (see [Where Projects Live](storage.md)). The repository must use Git LFS, on a host with LFS file locking, such as GitHub, GitLab or Gitea.

1. Open **Project Settings > Source Control** and set **Mode** to **Manual**. If no repository is set yet, Haptic fills in the repository and branch from the folder's Git settings when it can read them. When it cannot, Mode stays **Off** until you enter a repository.
2. Check the settings below.

## Project settings

| Setting | Description |
| --- | --- |
| Mode | **Off**, **Integrated** or **Manual**. Integrated is offered for a project that already uses it and, on desktop, for a folder that is a Git working copy. |
| Publish | **Publish Project…**, while Mode is Off. |
| Repository | The repository's HTTPS or SSH address. Signed in to GitHub or GitLab, choose it from your repositories; **Use Typed URL** in the list takes an address on another host. Haptic always talks to the host over HTTPS; for an SSH address it uses the same host on the standard HTTPS port. In Integrated mode it shows the repository the project was cloned from or published to, and can't be changed here. |
| Branch | The branch the locks belong to and, in Integrated mode, the branch Haptic syncs. Default `main`. Signed in to the repository's host, choose it from the host's branches. In Integrated mode it shows the project's branch and can't be changed here. |
| Account | Who you are signed in as on the repository's host, or **Not Signed In** with **Sign In**. |
| Auto-Lock On First Edit | Lock a file the first time you edit it in this session. On by default. |
| Release Locks After Push | Integrated mode: release your locks on the assets a push sent. On by default. |

Setting **Mode** back to **Off** asks first. Your locks stay until you release them.

If you open a project in Integrated or Manual mode on a device that has no account for its host, a banner says **This project uses GitHub file locking.** (or the host's name) with **Sign In**. Until you sign in, Haptic doesn't check or take any locks, and can't pull or push. For a host that takes a token, **Sign In** opens **Engine Settings > Source Control**.

## Working with locks

- **Your edits:** with Auto-Lock on, the first change to a document locks its file. If locking fails, the edit still applies and an **Unlocked** banner warns you.
- **Someone else's lock:** the document opens read-only with a **Locked by** banner showing the owner and how long ago they locked it. Choose **Edit Anyway** only after talking to them; your changes may conflict.
- **Content Browser:** locked assets show a lock badge, **Locked By You** or **Locked By** the owner's name.
- **Renaming and moving:** your locks move with the file. Haptic refuses to rename, move or delete a file someone else has locked.

Haptic checks locks every minute while it is in the foreground.

## The Source Control tab

While a project's mode is not Off, the **Source Control** tab sits at the right end of the document tabs, beside **Open Documents**. It can't be closed. In the phone layout, which has no tabs, a **Source Control** button beside the **Content Browser** button opens it.

In Integrated mode it holds **Changes** and **Locks**; in Manual mode, **Locks** only. **Locks** lists every lock with its path, owner and age.

| Control | Description |
| --- | --- |
| Refresh | Check locks now. |
| Release Pushed Locks | Manual mode: release your locks on files you have already pushed. GitHub and GitLab only. |
| Release All My Locks | Release all your locks, after a confirmation. Unpushed work becomes editable by others. |
| Release | Release one of your locks. |
| Force Unlock | Remove someone else's lock, after a confirmation. They may still have unpushed changes. |

Locks are released only when you choose to, or by a push with **Release Locks After Push**. Closing a document or the project keeps them.

### Release Pushed Locks

In Manual mode on GitHub and GitLab, each of your locks shows **Pushed** when the file on your device is exactly the file on the branch, and **Not Pushed** when it isn't there yet or differs. **Release Pushed Locks** checks the branch again and releases only the locks marked **Pushed**. It leaves a lock alone while its document has unsaved changes.

### When a check fails

If a check fails, the window keeps showing the last known locks and says the status is unavailable. On GitHub or GitLab, **Repository Not Found Or No Access** means your account can't see the repository: check the repository address and that you are signed in with an account that has access. On another host that has no file locking at all, the window says **This Host Does Not Support File Locking.** and Haptic stops trying to lock files on it; Integrated mode still syncs.

## After a pull or branch switch in another app

When you come back to Haptic after your Git app changed files, Haptic offers to reload them. See [Files changed outside Haptic](../editor/undo-and-saving.md#files-changed-outside-haptic).
