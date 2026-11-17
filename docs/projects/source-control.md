# Source Control

When a team shares a project through Git, Haptic can sync it for you and lock the files you edit with Git LFS file locking, so two people don't change the same asset at once.

Source Control is available in the iPad, iPhone, Android and desktop apps, not on the web, and is **Off** for a project until you turn it on. While it is Off, Haptic shows nothing for it and never contacts a Git host.

| Mode | Who syncs | What Haptic does |
| --- | --- | --- |
| Off | Nobody | Nothing. |
| Integrated | Haptic | Clones, commits, pulls and pushes the project, stores large asset data with Git LFS, and locks files. |
| Manual | Your Git app, such as Working Copy on iPad or a desktop Git client | Locks files only. |

Only one Git app may work in a project folder at a time. Integrated projects come from **Clone**, from **Publish**, or from a **Remote** New Project; a folder another Git app syncs stays in Manual mode. On desktop, Haptic asks once before it runs Git in a folder it didn't clone or publish there (see [On desktop: an existing Git folder](#on-desktop-an-existing-git-folder)).

## Link your accounts

Accounts belong to this device, not to a project: each person signs in once on each device, and every project on that host uses it. Open **Engine Settings > Source Control**, from the Homepage or the editor.

| Section | What it holds |
| --- | --- |
| Accounts | **GitHub** and **GitLab** (gitlab.com). Each row shows the signed-in user with **Sign Out**, or **Sign In**. A sign-in the host no longer accepts shows **Sign-In Refused** or **Sign-In Expired** with **Sign In Again**. |
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

GitHub asks you to let Haptic access your repositories and read your organization memberships, which Publish uses to offer your organizations. An organization that restricts OAuth apps must approve Haptic before its repositories and membership are available.

The dialog shows how long the code stays valid. If the code expires or you deny access, choose **Try Again** for a new code. **Cancel** stops waiting.

A GitLab sign-in renews itself in the background. If GitLab no longer accepts it, Haptic signs you out of GitLab on this device and the sign-in banner returns.

Your sign-ins stay on this device when the app updates. When you open a project that uses source control, or **Engine Settings > Source Control**, Haptic asks each host once whether your saved sign-in still works. A sign-in can stop working when you revoke Haptic's access on the host, when the host's sign-in app changes, or when the host gave it an expiry that has passed. Haptic renews GitLab sign-ins itself, but not GitHub ones. Haptic then shows the sign-in banner with **Sign In Again**, and **Engine Settings > Source Control** shows **Sign-In Refused** or **Sign-In Expired**. A token the host refuses shows **Token Refused**; remove it and save a new one.

## Clone a project

On the Homepage, choose **Clone** next to **New Project**.

1. Choose **GitHub**, **GitLab** or **URL**. For GitHub and GitLab, the dialog shows who you are signed in as, or **Sign In**.
2. Pick a repository from the list (search it by name), or type its address under **URL**. A host other than GitHub or GitLab needs a token in **Engine Settings > Source Control** first.
3. Choose the **Branch** and a **Project Name**, then choose **Clone**.

Haptic clones the branch into its own storage (the Projects folder on desktop, the app's documents on iPad, iPhone and Android) and opens it in Integrated mode. **Cancel** stops a clone and removes what it had copied. The branch must hold a Haptic project.

## Create a Remote project

To start a new project with its own repository, choose **New Project** on the Homepage and set **Hosting** to **Remote** ([Your First Project](../start/first-project.md#create-a-project)). Haptic creates the project, opens it and then publishes it to a new repository, as [Publish](#publish-a-project) does.

| Field | Description |
| --- | --- |
| Host | An account on this device that can create repositories: GitHub, GitLab or a self-managed GitLab. A host added under **Other Git Hosts** can't. With no such account, choose **Sign In To GitHub** or **Sign In To GitLab** here; the link warning comes first. |
| Owner | Your account, or an organization (on GitLab, a group) you can create repositories in. |
| Repository Name | Follows the project's name until you change it. |
| Visibility | **Private** or **Public**. |

Haptic remembers **Local** or **Remote** and the host on this device, so the next New Project starts from them. On iPad, iPhone and Android a Remote project is created in App Documents: Haptic can't run Git in a folder you choose there. On desktop, **Choose Folder** works for a Remote project too.

If the repository can't be created (the name is taken by a repository with commits, or the host can't be reached), the project is still created as a Local project and opens. A notice above the documents says why; publish it later from **Project Settings > Source Control**. If the repository is created but the first push fails, the project opens in Integrated mode with the commit waiting: choose **Push** in the status bar's branch menu once the host is back.

## Publish a project

To put a project that has no repository yet on GitHub or GitLab, open **Project Settings > Source Control** while **Mode** is **Off** and choose **Publish Project…**.

| Field | Description |
| --- | --- |
| Host | **GitHub** or **GitLab**. You need to be signed in to it. |
| Owner | Your account, or an organization (on GitLab, a group) you can create repositories in. Organizations are listed only when the host lets Haptic read them; otherwise only your account is offered. |
| Repository Name | The new repository's name. |
| Visibility | **Private** or **Public**. |

The dialog sums up what Publish does: the repository it creates, the Git LFS settings and ignore list it adds, and how many assets and how much data it pushes, with the share stored through Git LFS. Save your documents first. **Publish** creates the empty repository, commits the whole project, pushes it and switches the project to Integrated mode.

On iPad, iPhone and Android, only a project in Haptic's own storage can be published. On desktop, any project folder can.

If only the first push fails, the project is already in Integrated mode with the commit waiting: choose **Push** in the status bar's branch menu once the host is back. If Publish stops earlier (the app closes, or the host can't be reached), the project stays Off. On iPad, iPhone and Android you can publish it again under the same name: if the first attempt already created the repository and nothing was pushed to it yet, Haptic publishes into it. Haptic never publishes into a repository that already has commits; choose another name for that. On desktop the folder now has Git, so choose **Integrated** under **Mode** and push instead.

## Integrated mode

### The Changes window

In Integrated mode the **Source Control** tab opens on **Changes**, with **History** and **Locks** as tabs beside it, taking a quarter of the width; **Actors** takes the next quarter and **Diff** the other half. Your own arrangement of the windows is kept. The tab shows how many assets have uncommitted changes.

- The top row shows the branch you are on (choose it to switch branches or start a **New Branch…**, see [Branches](#branches)), **Refresh**, **Pull** and **Push** with the number of commits each would bring in or send, and **More Actions** with **Remove Unused Files…** ([Remove unused files](#remove-unused-files)).
- The status line says how many commits there are to pull and to push, and when Haptic last checked.
- **Changes** lists each changed asset with its type, folder and a green **+** (added), **M** (modified) or a red **−** (deleted). A lock badge marks locked assets: filled for yours, an outlined red badge with a person for someone else's (a push that sends it is refused). The Content Browser marks the same assets on their tiles and in its folder tree: **+** for added, **M** for modified. An asset's change includes the large data stored with it, so it is always committed whole. Project settings and other project files appear by name.
- **Incoming** lists the newest commits waiting to be pulled, with their author and age.
- Choose an asset (anywhere on its row but the checkbox) to see what changed in it: see [Compare versions](#compare-versions).

Haptic reads changes after you save (while a game covers the editor, once you are back) and when you come back to the app, and checks the host when you open the project, come back to the app, choose **Refresh** and after a push.

### Commit and push

1. Clear the checkbox of any asset you don't want in this commit.
2. Type a **Commit Message**.
3. Keep **Push After Commit** on to send the commit at once, or turn it off to commit only on this device.
4. Choose **Commit N Assets**.

In the iPad, iPhone, Android and desktop apps, large asset data travels straight between the host and the project folder, without passing through the editor's memory. The status bar shows how much has been transferred.

A commit takes each asset with the large data it uses. Large data that no asset in the commit uses, such as what an edit you reverted had added, stays on your device and out of the commit until you remove it ([Remove unused files](#remove-unused-files)).

**Push** sends your commits. Before it does, Haptic checks the locks on what it sends, on the branch it pushes, and refuses if someone else has locked one of those assets, naming who. With **Release Locks After Push** on, a push then releases your locks on the assets it sent, except any you have changed again or have unsaved edits in. Haptic then checks the host for new commits; if that check fails (**Could Not Check For Changes**), the push still went through.

If the host has moved on since your last pull, the push is refused: pull first.

### Remove unused files

Large asset data that no asset uses any more stays on your device: what an edit you reverted or discarded had stored, what a deleted asset used, and what another branch's assets use after you switch away from it. **Remove Unused Files…** in the **Changes** window's **More Actions** menu removes it.

1. Save or discard your changes first: Haptic doesn't remove files while documents have unsaved changes.
2. Haptic lists what no asset in the project, its plugins or its extensions uses, and confirms with the number of files and their size. Removing them cannot be undone.
3. **Remove** removes them. Saves and imports wait until it is done. If a save, import or Texture encode is still running, Haptic waits for it first; **Cancel** stops while it waits, with nothing removed. Once files are being removed, it finishes.

Haptic keeps every file an asset uses, every file that is part of a commit (data you committed is never removed), and data that only a commit you haven't pushed yet holds, on any branch: until you push, your device has the only copy. It also keeps data a committed version of an asset uses when that commit doesn't hold it, as when another Git app committed the asset without its data: your device has the only copy, and comparing or reverting to that version needs it. Data of commits on the host can be downloaded again when a branch, pull or revert needs it. On desktop, while a folder of asset data is a symbolic link (or sits inside one, or holds one), Haptic removes nothing and says so (**Nothing Removed**), since one file may then belong to two folders.

### Pull

**Pull** brings in your teammates' commits:

1. If documents have unsaved changes, choose **Save All** or **Discard** first.
2. Confirm. A pull replaces files and cannot be undone.
3. **Pulling** covers the editor until the pull is done. Documents are read-only meanwhile, and Play, Simulate and Preview Build wait: the Output Log says why they didn't start.
4. If an asset changed both on your device and on the branch, **Pull Conflicts** lists each one. Choose **Keep Mine** or **Take Theirs** for every asset; **Apply And Finish Pull** stays unavailable until each has a choice. **Cancel Pull** changes nothing. **Compare** shows that asset's diff in the Source Control tab, from the branch's version to yours: Pull Conflicts waits in the corner meanwhile, with your choices kept, until you choose **Back To Pull Conflicts**.

Open documents whose files the pull changed reload before you can edit again, as after any change on disk (the whole project reloads when project settings or many assets changed; if anything is still unsaved, Haptic asks first instead of replacing it). An asset you kept stays as an uncommitted change, ready to commit and push.

While a pull, branch switch or revert is open, including while Pull Conflicts waits in the corner, another **Pull**, **Switch Branch** or **Revert** doesn't start.

### Branches

The branch you are on belongs to your copy of the project on this device: switching it changes nothing for your teammates and is not a change to commit. The project's **Default Branch** (in **Project Settings > Source Control**) stays as it is.

**Switch a branch:** choose the branch in **Changes**, **Switch Branch** in the status bar menu, or **Switch Branch** in **More Tools**. The menu lists the branches on this device, with yours checked, then the other branches on the host.

1. If documents have unsaved changes, choose **Save All** or **Discard** first.
2. Confirm. Files that differ on the other branch are replaced with its versions, and this cannot be undone. Uncommitted changes to other files stay as they are.
3. **Switching To** covers the editor until the other branch's files are loaded; documents are read-only meanwhile, as during a pull.

If an asset the other branch has a different version of has uncommitted changes, Haptic doesn't switch and names the assets: commit or revert them first. A branch you haven't used on this device yet is downloaded first, without its older history.

Haptic also doesn't switch to a branch whose project settings turn Source Control **Off** or **Manual**, or name another repository: switching would load those settings and stop Haptic syncing your copy. It says why; change that branch's settings with another Git app first.

**Start a branch:** choose **New Branch…**, enter a name and choose **Create Branch**. The branch starts at your last commit and becomes your branch at once, with your uncommitted changes kept. Your next push creates it on the host; until then there is nothing to pull, and **Push** counts only the commits the host doesn't have on any branch. Names that are already taken, here or on the host, are refused as you type. While documents are read-only, for example during a pull, **New Branch…** says why and creates nothing.

### Compare versions

Choosing a change opens its asset in **Actors** and **Diff**, comparing the last commit (**Base**) with your working copy (**Compare**). While the diff is shown, the toolbar holds the **Base** and **Compare** pickers: choose **Working Copy**, the branch's last commit, the branch on the host as last checked, or a commit that changed the asset. The pickers list the same commits as [History](#history) for the asset, newest first; **Load Older** at the end reads more, as **Load Older History** does.

- **Actors** lists the asset itself first (choose it to see its name, type, stored data and settings), then its items: a Scene's folders and actors, a graph asset's changed graphs and nodes with its changed **Variables**, **Parameters**, **Inputs**, **Outputs** and **Functions**, or another asset's groups of properties. Added items are green with **+**, changed ones amber with **M**, removed ones red with **−**; items that didn't change are dimmed. The counts at the top say how many were added, removed and changed, and **Search Actors** finds an item by name. Choose one to see it in **Diff**.
- **Diff** shows the chosen item in the view for the asset's kind:
  - Scenes and most assets show **Property**, **Base** and **Working Copy** columns grouped by component, with changed values tinted. **Side By Side** or **Inline** (the old value struck through beside the new) sets the layout; **Changed Only** hides the rest. With no actor chosen, a Scene shows the asset itself and its settings.
  - Graphs show on a read-only canvas drawn as their own editor draws them: Classes, Scene scripts, Materials and Material Functions, Particle Graphs, Behaviour Trees, and an Animation Graph's State Machine, state graphs, transition rules and Animation Object. Choose **Overlay** for both versions, or only **Base** or **Working Copy**; when several graphs changed, choose one above the canvas. Changed nodes are outlined amber, added ones green and removed ones red and dashed, each tagged; a changed node lists its changed values, the old value struck through beside the new. Choose the asset itself in **Actors** to see a graph asset's settings, such as a Material's blend mode or an Animation Graph's transition settings.
  - Textures show both images over a checkerboard, **Side By Side**, as a **Swipe** or as their **Difference**, in **RGB** or **Alpha**, beside their size, file size, source image, usage and compression, and how many Materials use the Texture.
- **Open Scene**, **Open Class** and the like open the asset for editing.

Haptic reads the base version from the project's history, so a diff needs no network unless a large file the base used is no longer in your copy; it then downloads it from the host without adding it to your changes. While a game covers the editor, the diff waits. The diff follows your saves only while **Actors** or **Diff** is on screen: when you come back to them, it shows what changed meanwhile.

### History

**History** lists commits, newest first, with their message, author and age:

- **This Asset** shows the commits that changed the asset you last compared, or the one you were editing when you chose **Open History**. Project Settings and folders aren't assets, so comparing them leaves it as it was. **All Assets** shows every commit on your branch.
- **Uncommitted Changes** comes first while there are any; choose it to list them, and an asset to see its diff.
- Choose a commit to see its full message, author, time and short id (**Copy Commit Id** copies the full one), and the assets it changed, marked **+**, **M** or **−** as in **Changes**: choose one to see what that commit did to it.
- With **This Asset**, **Compare With Working Copy** opens the asset's diff from that commit to your working copy, and **Revert To This Version** puts the asset back as that commit has it, as [Revert Asset](#revert-an-asset) does.
- **Load Older History** reads more commits. A cloned project starts with only its latest commit, so older history is downloaded from the host the first time you ask for it.

### Revert an asset

**Revert Asset** in **Diff** puts the base version of the asset back in your working copy, with the large files it uses (an asset the base didn't have is removed). If the asset has unsaved edits, choose **Save All** or **Discard** first. Reverting replaces the file and cannot be undone; when the base version doesn't have the asset, the confirmation says **Delete** instead. Documents are read-only while it runs, and the reverted asset reloads as after a pull. **Revert Asset** is unavailable when **Base** is the working copy. Only assets can be reverted, not Project Settings.

### Repositories Haptic didn't publish

A repository needs a Git LFS rule for the data Haptic stores beside assets. If a commit is refused because it is missing, choose **Add Git LFS Rule**: Haptic adds the rule to `.gitattributes`, commits it, and you can commit again.

### The status bar

In Integrated mode the status bar starts with the branch. Its menu holds **Commit…**, **Pull**, **Push**, **Refresh**, **Switch Branch**, **New Branch…**, **Open Source Control** and **Open History**. Next to it, **N Changes** opens the Changes window, and **Pull N** and **Push N** appear when there is something to pull or push. While a pull, push, publish or branch switch runs, its progress takes their place. When a commit, pull or push fails, its reason (such as **Could Not Push**) appears there too and opens the Changes window, which says what went wrong. On the right, a small **Saved** shows that everything is saved; save problems such as **Auto-Save Failed — Use Save All** show there instead.

In the phone layout, which has no status bar, **More Tools** holds the same actions; when one fails, the Changes window opens to say why.

If Haptic can't open the repository, for example because another Git app left it with no branch checked out, the branch reads **No Branch Checked Out** and the branch menu says why. Check out a branch with that app, then choose **Refresh**.

### On desktop: an existing Git folder

On desktop, a project folder that is already a Git working copy can switch to **Integrated** in **Project Settings > Source Control**. Haptic first warns that no other Git app may use the folder at the same time, then takes the repository and branch from the folder's Git settings. On iPad, iPhone and Android, a folder another app syncs stays in Manual mode; a project Haptic cloned or published into its own storage can always switch back to **Integrated**, with no warning, since no other Git app uses it.

The mode is part of the project, so it reaches your teammates when you commit it. On desktop, Haptic doesn't start running Git in a folder just because the project says Integrated: until you agree, **Project Settings > Source Control** and the **Changes** window say **Haptic Does Not Run Git In This Folder Yet**. Choose **Use Haptic's Git Here** to see the same warning, then accept to let Haptic sync this folder. **Cancel** changes nothing, and Haptic doesn't ask again by itself. Your answer belongs to this folder on this device: Haptic keeps it in the folder's own Git settings, never in the project, so it isn't committed and stays when you reinstall Haptic. Folders Haptic cloned or published on this device don't ask.

To give the folder back to another Git app, choose **Stop Using Haptic's Git Here** in **Project Settings > Source Control**. Haptic stops syncing the folder on this device; the project stays Integrated for your teammates.

## Manual mode

Keep the project in a folder that is a Git working copy whose top folder is the project folder (see [Where Projects Live](storage.md)). The repository must use Git LFS, on a host with LFS file locking, such as GitHub, GitLab or Gitea.

1. Open **Project Settings > Source Control** and set **Mode** to **Manual**. If no repository is set yet, Haptic fills in the repository and branch from the folder's Git settings when it can read them. When it cannot, Mode stays **Off** until you enter a repository.
2. Check the settings below.

## Project settings

| Setting | Description |
| --- | --- |
| Mode | **Off**, **Integrated** or **Manual**. Integrated is offered for a project that already uses it, on desktop for a folder that is a Git working copy, and on iPad, iPhone and Android for a project in the app's own storage that has Git. |
| Publish | **Publish Project…**, while Mode is Off. |
| Git App | Desktop, Integrated mode: **Use Haptic's Git Here** for a folder Haptic doesn't sync yet, or **Stop Using Haptic's Git Here** for one it does. Applies to this device only. |
| Repository | The repository's HTTPS or SSH address. Signed in to GitHub or GitLab, choose it from your repositories; **Use Typed URL** in the list takes an address on another host. Haptic always talks to the host over HTTPS; for an SSH address it uses the same host on the standard HTTPS port. In Integrated mode it shows the repository the project was cloned from or published to, and can't be changed here. |
| Branch | The branch the locks belong to. Default `main`. Signed in to the repository's host, choose it from the host's branches. In Integrated mode it is the **Default Branch**, the team's branch, and can't be changed here; the branch you are on is your own, switched from the Source Control tab ([Branches](#branches)), and locks belong to the branch you are on. |
| Account | Who you are signed in as on the repository's host, or **Not Signed In** with **Sign In**. |
| Lock On Edit | What your first edit of a file does: **Ask** whether to lock it (the default), **Always** lock it, or **Never** lock it. |
| Release Locks After Push | Integrated mode: release your locks on the assets a push sent. On by default. |

Setting **Mode** back to **Off** asks first. Your locks stay until you release them.

If you open a project in Integrated or Manual mode on a device that has no account for its host, a banner says **This project uses GitHub file locking.** (or the host's name) with **Sign In**. Until you sign in, Haptic doesn't check or take any locks, and can't pull or push. For a host that takes a token, **Sign In** opens **Engine Settings > Source Control**. If the host refuses your saved sign-in, or it expired, the banner says **GitHub refused the saved sign-in.** or **The GitHub sign-in expired.** with **Sign In Again**; after you sign in, Haptic reads your changes and the remote again.

## Working with locks

- **Your edits:** with **Lock On Edit** set to **Ask**, your first change to a file asks **Lock** and the file's name, with **Don't Lock** and **Lock**. Changes that touch several files at once ask once, listing them. The question waits until you let go of the mouse or finger, and pressing Enter or Space while it appears doesn't answer it. Haptic asks about each file once, and again after its lock is released or a pull, branch switch, revert or another app changes the file. With **Always**, the first change locks the file without asking; with **Never**, Haptic doesn't lock it. If locking fails, the edit still applies and an **Unlocked** banner warns you. In Integrated mode locks belong to the branch you are on, so until Haptic has opened the repository and knows that branch, locking waits: edits made meanwhile are locked, or asked about, once it does, and **Release** says why it waits.
- **Switching branches:** on a host that keeps locks per branch, your locks on the branch you switched away from stay in **Locks**, marked **On** and the branch's name. **Release** releases them there, and **Release Locks After Push** releases them too when the push sent their assets.
- **Someone else's lock:** the document opens read-only with a **Locked by** banner showing the owner and how long ago they locked it. **Edit Anyway** lets you change it, but you can't save it until they release the lock.
- **Content Browser:** a locked asset shows a lock badge in its tile's corner: a filled lock for yours (**Locked By You**), an outlined red badge with a person for someone else's, named in its tooltip (**Locked By** and their name). Its menu's **Source Control** submenu says who holds it and offers **Lock**, **Release Lock** or **Force Unlock…**, and in Integrated mode **Show Changes**, **Show History** and **Revert…**. See [Source Control in the Content Browser](../editor/content-browser.md#source-control-in-the-content-browser).
- **Renaming and moving:** your locks move with the file. Haptic refuses to rename, move or delete a file someone else has locked.

Haptic checks locks every minute while it is in the foreground.

## The Source Control tab

While a project's mode is not Off, the **Source Control** tab sits at the right end of the document tabs, beside **Open Documents**. It can't be closed. In the phone layout, which has no tabs, a **Source Control** button beside the **Content Browser** button opens it.

In Integrated mode it holds **Changes**, **History**, **Locks**, **Actors** and **Diff** ([Compare versions](#compare-versions), [History](#history)); in Manual mode, **Locks** only. **Locks** lists every lock with its path, owner and age, each led by its lock badge.

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
