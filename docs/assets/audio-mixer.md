# Audio Mixer

Sets a global volume and a default volume for each Audio Channel in the project.

## Create

In the **Content Browser**, choose **New Asset > Audio > Audio Mixer**. Then choose it in **Project Settings > Audio > Audio Mixer**. A project uses one mixer.

## Editor

Double-tap the asset to open it. The window has an **Inspector** only.

- Set **Global Volume**.
- Tap **Add Channel** and pick an [Audio Channel](audio-channel.md). Set that channel's **Volume**.
- A channel can be listed once. A duplicate entry is reported as invalid.

## Settings

| Setting | Description |
| --- | --- |
| Global Volume | Level from 0 to 1 applied to every sound. Default 1. |
| Channel 1, Channel 2... | The channels listed on the mixer. Pick another asset to replace one, or choose None to remove it. |
| Volume | The level for that channel, from 0 to 1. |

With no channels listed, **Global Volume** still applies.

## Related

- [Mixing](../audio/mixing.md)
- [Set Channel Volume](../scripting/class/set-channel-volume.md)
- [Set Global Volume](../scripting/class/set-global-volume.md)
