# Publishing

**Packaging** builds your project as a game: a web game in a ZIP, ready for itch.io or any static web host, a desktop game for Windows (ZIP), Linux (Debian package or ZIP) or macOS (a signed app in a ZIP), an Android game (APK or App Bundle), or an iOS game (an IPA for the App Store or your own devices).

## Before you package

1. Set **Project Settings > Game > Startup Scene**. The exported game always starts there, whatever **Start In Open Scene** says.
2. **Save All** (<kbd>Mod</kbd>+<kbd>S</kbd>). Packaging uses the saved project, not unsaved edits in open tabs.
3. Bake each NavMesh your scenes use. Packaging does not bake navigation.
4. Try a [Preview Build](preview-build.md) to check the packaged game.

## Package the game

1. In the toolbar, choose **Settings > Packaging** (<kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>).
2. In the platform list, select a platform under **Available**. Platforms under **Unavailable** can't be packaged with this copy of Haptic.
3. Check the summary: the output file, **Startup Scene**, **Bundle Debugger** and **Always Package Folders**. If no Startup Scene is set, choose **Game Settings** to set one; **Package** stays unavailable until you do.
4. Choose **Package**.
5. Save the file when Haptic asks (see [Saving exported files](../projects/index.md#saving-exported-files)); in a browser, a message such as **Game package downloaded. Check your downloads.** appears. The file is named after the project, with underscores for spaces, and native packages end in `-Windows`, `-Linux`, `-macOS`, `-Android` or `-iOS`.

The web ZIP has `index.html` at its root. Upload it to itch.io as an HTML game, or unzip it and serve the folder from any static web host. The page's title is the project name. For desktop ZIPs, see [Desktop games](#desktop-games).

If packaging fails, the reason appears in the **Packaging** window.

## App icon

Set **Project Settings > Export > App Identity > App Icon** to a Texture, and every package uses it as its icon. Without one, each platform keeps its default icon.

Use a square image of at least 1024 × 1024 pixels; Haptic scales it down to each size a platform needs. Packaging uses the image the Texture was imported from, not its compressed copy, so the Texture's settings don't affect the icon. The App Icon row shows a message when the Texture is missing, not square or too small, and packaging fails with the same reason.

| Package | Where the icon appears |
| --- | --- |
| Web | The browser tab (`icon.png` beside `index.html`) |
| Windows | The `.exe` in File Explorer and on shortcuts, the game window and the taskbar. The `.exe` also shows the game's name and version in its file details and in Task Manager. |
| Linux | The app menu and the dock (Debian package); the game window |
| macOS | The app in Finder, the Dock and the app switcher |
| Android | The launcher and the app list, in the shape the device uses for every app |
| iOS | The Home Screen, the App Library and Settings. iOS shows icons without transparency, so transparent areas turn black. |

With an App Icon, packaging for Windows takes noticeably longer, because Haptic rewrites and recompresses the game's `.exe`.

## Desktop games

Windows and Linux games are the same web game in a desktop player built on Electron, so they look and play as they do in Play. A ZIP holds one folder named after the project:

| Platform | Start the game with | Notes |
| --- | --- | --- |
| Windows (64-bit) | `<Project Name>.exe` | Unsigned, so Windows SmartScreen may warn on first launch: choose **More info**, then **Run anyway**. |
| Linux (64-bit) | the lowercase command, such as `space-game` | Unzip with a tool that keeps file permissions, such as `unzip`. Prefer the Debian package for Ubuntu. |

- Keep the whole folder together; the game reads its files from the `resources` folder beside the program.
- The game's saves are stored per project in your user data folder under `Haptic Games`, so renaming the project keeps them.
- The game window cannot open other pages. Links it opens go to the system browser.
- The folder includes the licences of Electron and Chromium (`LICENSE`, `LICENSES.chromium.html`) beside `legal/THIRD-PARTY-NOTICES.txt` in `resources/game`. Keep them when you share the game.
### Linux formats

For Linux, choose the **Format** in the Packaging summary:

| Format | Use it for | How players install it |
| --- | --- | --- |
| Debian Package (default) | Debian, Ubuntu and their derivatives | `sudo apt install ./Space_Game-Linux.deb`, or open it in the software installer. The game appears in the app menu and as the `space-game` command. |
| ZIP | Other distributions | Unzip and run the command in the folder. |

Ubuntu 23.10 and later block the way the game's browser engine sandboxes itself unless its sandbox helper is installed by an administrator. The Debian package installs it that way, so the game starts with its sandbox on. From the ZIP on those systems, the game stops at start with a sandbox message until someone runs `sudo chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox` in its folder.

Which platforms you can package depends on where you run Haptic:

| Haptic | Can package |
| --- | --- |
| Browser, iPad and Android | Web, Windows, Linux |
| Windows and Linux desktop apps | Web, Windows, Linux, Android |
| macOS desktop app | Web, Windows, Linux, macOS, Android, iOS |

## macOS games

The Haptic desktop app on a Mac packages macOS games for Apple Silicon Macs, as the app in a ZIP. It signs them with Apple's tools on your Mac, so macOS games cannot be packaged in the browser, on iPad or on other computers.

| Signing | Who can open the game | What you need |
| --- | --- | --- |
| Ad-hoc (default) | Your Macs, and others after **System Settings > Privacy & Security > Open Anyway** | Nothing |
| Developer ID | Every Mac, after it is notarized | An Apple Developer Program membership |

To sign and notarize with your Developer ID:

1. Install your **Developer ID Application** certificate on the Mac, for example in Xcode under **Settings > Accounts > Manage Certificates**.
2. Store your notarization credentials in the keychain once, in Terminal: `xcrun notarytool store-credentials haptic-notary --apple-id you@example.com --team-id TEAMID` (it asks for an app-specific password, which you make at appleid.apple.com). Haptic never sees them.
3. In **Engine Settings > Packaging**, choose the **Signing Identity** and enter the **Notarization Profile** name, here `haptic-notary`.

Packaging then signs the app, sends it to Apple and attaches the notarization ticket, which can take several minutes. Without a profile, the app is signed but not notarized, and other Macs block it until a player allows it.

The app's ID, name and build number come from **Project Settings > Export > App Identity**; its version is the project's. Until you set an App ID, the app uses a placeholder such as `com.example.spacegame` and Packaging reminds you.

## Android games

The Haptic desktop apps package Android games for phones and tablets running Android 7 or later. The game runs in the device's own web view, full screen, and plays as it does on the web. Haptic builds it with Android's build tools on your computer, so Android games cannot be packaged in the browser or on mobile.

You need a JDK (Java 17 or later) and the Android SDK. Installing [Android Studio](https://developer.android.com/studio) gives you both, and Haptic finds them there, or through `JAVA_HOME` and `ANDROID_HOME`. To use others, choose them in **Engine Settings > Packaging** under **Android**. The Packaging window's **Build Tools** row shows what it found.

Choose the **Format** in the Packaging summary:

| Format | Use it for |
| --- | --- |
| APK (default) | Installing on a device yourself, and stores that take APKs, such as itch.io |
| App Bundle | Uploading to Google Play |

The first package downloads Gradle and the Android libraries it needs, which can take several minutes; later packages are faster.

### Signing

Android installs only signed apps. Without a keystore, Haptic signs with Android's debug key: the game installs on your devices, but Google Play refuses it, and a game signed with another key cannot replace it. To publish, sign with your own key:

1. Make a keystore once, in Android Studio (**Build > Generate Signed App Bundle or APK**) or in a terminal: `keytool -genkeypair -keystore my-game.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`. Keep it and its passwords safe; you sign every update with the same key.
2. In **Engine Settings > Packaging > Android**, choose the **Keystore**, enter the **Key Alias** and the **Keystore Password**, and the **Key Password** if the key has its own.

The passwords stay in this computer's secret store. For Google Play, this key is your upload key: Play signs the app players download.

The app's ID, name and build number come from **Project Settings > Export > App Identity**; its version is the project's. Android calls the build number the version code: raise it for every upload, and keep it at most 2,100,000,000.

In the game, the device's Back button acts as <kbd>Esc</kbd>.

## iOS games

The Haptic desktop app on a Mac packages iOS games for iPhone and iPad running iOS 17 or later. The game runs in the system's web view, full screen, and plays as it does on the web. Haptic writes an Xcode project and builds it with Xcode on your Mac, so iOS games cannot be packaged anywhere else.

You need:

- Xcode 16 or later, opened once to finish installing, with the iOS platform (**Xcode > Settings > Components**).
- An Apple Developer Program membership, with your Apple account signed in to Xcode under **Xcode > Settings > Accounts**.
- Your team's **Team ID**, from the Membership page on the Apple Developer website, entered in **Engine Settings > Packaging** under **iOS**.

Xcode signs the game for your team and makes or renews its provisioning profile itself; Haptic never sees your Apple account. Choose the **Format** in the Packaging summary:

| Format | Use it for |
| --- | --- |
| App Store (default) | Uploading to TestFlight and the App Store with Apple's **Transporter** app. Needs an [app icon](#app-icon). |
| Development | Installing on the devices registered to your team, for example from Xcode's **Window > Devices and Simulators** |

The app's ID, name and build number come from **Project Settings > Export > App Identity**; its version is the project's, which iOS needs as up to three numbers, such as `1.2.3`. Raise the build number for every upload. Packaging can take several minutes.

## Packaging settings

These settings are in **Project Settings > Export**, under **Game Packaging**, **App Identity** and **Always Package Folders**. **Export Settings** in the **Packaging** window opens them.

| Setting | Description |
| --- | --- |
| Bundle Debugger | Includes debugging tools and Development Only nodes. Off by default. |
| File Count Warn | Warning threshold for the number of files in the export. Default 800. Preview Build logs a warning above it. |
| File Count Fail | File count above which the export fails. Default 1000. |
| App ID | Identifies a native app to the operating system and app stores, such as `com.studio.game`: two or more parts of letters and digits, each starting with a letter. Keep it once you publish. |
| Display Name | The name under the app's icon. The project name when empty. |
| App Icon | The Texture every package uses as its icon. See [App icon](#app-icon). |
| Build Number | Raise it for every upload to an app store. |
| Always Package Folders | Folders whose assets always ship, even when nothing references them. Subfolders are included. |

**Export Project**, under **Project Backup** on the same page, makes an editable backup of the project instead. See [Projects](../projects/index.md).

## What the game contains

Export includes only what the game can reach:

- the Startup Scene and everything it references, following references from asset to asset;
- the Game Instance class and every subsystem class;
- Input assets and your console command classes;
- everything in **Always Package Folders**.

Every export also includes `legal/THIRD-PARTY-NOTICES.txt`, the licences of the open-source software the game runs on. Keep it when you upload or repackage the game.

Editor-only assets, such as Editor Utility Objects, Plugin Settings and Skybox Creator, never ship. Neither does content from disabled plugins.

::: tip
If a script finds assets at runtime by path, folder or class instead of by reference, add their folder to **Always Package Folders** so they ship.
:::

## Release and debugger builds

| | Release (Bundle Debugger off) | Bundle Debugger on |
| --- | --- | --- |
| Development Only nodes, such as Print and Draw Debug | Left out | Kept |
| Debug-only [console commands](../debugging/console.md) | Unavailable | Available |
| Line Trace debug lines | Never drawn | Drawn when **Draw Debug** is on |
| Stats display | None | Available |
| Infinite Loop Detection | Off | Follows Project Settings |

Your own console commands work in both.

## In this section

- [Preview Build](preview-build.md): test the packaged game inside the editor before you publish.

## Related

- [Settings](../editor/settings.md)
- [Undo and Saving](../editor/undo-and-saving.md)
