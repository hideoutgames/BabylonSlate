# Platforms and Install

Haptic runs on iPad, iPhone, Android, Mac, Windows, Linux and in a web browser, with the same editor on every platform.

## Supported platforms

| Platform | Requirements and notes |
| --- | --- |
| iPad | iPadOS 17 or later. The editor runs in landscape. |
| iPhone | iOS 17 or later. Portrait and landscape, with the compact phone layout. |
| Android | Android 7.0 or later. Phones use the compact phone layout; tablets use the full layout. |
| Mac | Desktop app for Apple silicon and Intel Macs. |
| Windows | Desktop app for 64-bit Windows, installed with a standard installer. |
| Linux | Desktop app for 64-bit Linux, packaged as an AppImage. |
| Web | Runs in a current browser. Projects are kept in the browser's own storage on that device. |

Every platform opens the same project format, so you can move a project between devices. See [Where Projects Live](../projects/storage.md) for what each platform stores and where.

## Differences between platforms

- **Source Control** (Git LFS file locking) is available in the iPad, iPhone, Android and desktop apps, not on the web.
- **Choose Folder** (keeping a project in a folder you pick, such as iCloud Drive or a Git working copy) is available in the apps. On the web, use **Export Project** and **Import ZIP** to move projects in and out.
- Narrow windows and phones in landscape use the phone layout, which shows one window at a time. See [Windows and Layout](../editor/index.md).

## Accounts and sign-in

| Platform | Sign-in |
| --- | --- |
| Web and desktop | Optional. You can create and open projects as a guest. |
| iPad, iPhone and Android | Required before the project list appears. Sign in with your email address and a verification code, or choose **Use Temporary Demo Account**. |

The demo account is for local testing. It has no cloud access and ends when the app restarts; your projects stay on the device.

Open the account menu from your profile picture at the top right of the Homepage. Depending on the platform and whether you are signed in, it offers **Account Settings**, **Manage Subscription**, **Application Settings**, **Engine Settings**, **Changelog**, and **Sign In** or **Sign Out** (**End Demo** for the demo account).

Signing in does not sync projects. Projects stay where you saved them.

## Updates

The desktop app can download new releases and install them when you quit. Turn this on or off with **Automatic Updates** in **Engine Settings > About** or in **Application Settings** on the Homepage. It is on by default.

To see what changed in each version, choose **Changelog** in the account menu.

## Next steps

- [Create your first project](first-project.md)
- [Take the editor tour](editor-tour.md)
