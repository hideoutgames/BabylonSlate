# Multiplayer Plan

Deferred design for Haptic multiplayer: listen-server networking on free services, testable inside the editor before any online backend exists. None of it is built. The first step of [Order](#order) writes the reference (`architecture/multiplayer.md`) and the wire format; until then this file is the source of the decisions, and [engine-plan.md](engine-plan.md#multiplayer-planned) points here.

## Scope

- In: swappable transports, an Online Subsystem, a Replication Component, typed network messages, a Multiplayer Play mode.
- Out for now: dedicated servers and any paid hosting, host migration, client-side rigid-body prediction, voice chat, anti-cheat, web cross-play with Epic Online Services (no browser SDK).
- Free services only: no transport or provider may need a Haptic-run server or a paid plan.

## Network model

- Listen server only. The host's game is the authority (physics, spawning, rules); clients send input and messages and receive state.
- Net Mode: Standalone, Host or Client (**Get Net Mode**, **Is Host**, **Is Client**).
- Player ids: host 0, clients 1 and up (**Get Local Player Id**, **Get Players**). A session's **Max Players** defaults to 4.
- Joining checks project id and build id, then the host assigns the id and sends a full snapshot of every replicated Actor, so late joins work.
- Every client plays the host's scene; a host scene change moves every client; a client cannot open another scene while connected.
- Game Instance and subsystems stay per client and are not replicated; rules that must agree live on the host.
- A client silent for 10 s is removed. The host leaving ends the session for everyone (**Host Left**).
- Game Instance events: **On Player Joined**, **On Player Left**, **On Session Ended**.

## Transports

One interface; every transport offers a reliable ordered channel (spawns, messages, joining) and an unreliable one (snapshots, input). Gameplay never sees which one runs.

| Transport | Works in | Provides | Needs from the developer |
| --- | --- | --- | --- |
| Local | The editor (Multiplayer Play mode, pop-out windows) | Simulated latency, jitter, packet loss | Nothing |
| WebRTC | Web, iPad, Android, desktop games and editors | Peer-to-peer data channels | A signaling choice; optional TURN servers |
| Epic Online Services | Desktop games first; iOS and Android later | Peer-to-peer with Epic's free relays | An Epic Developer Portal product and its ids |
| Steam | Desktop games on Steam | Steam's relayed networking | A Steam App ID and their own Steamworks SDK |

- **WebRTC settings** in **Project Settings > Multiplayer**: STUN servers (default the free public `stun:stun.l.google.com:19302` and `stun:stun.cloudflare.com:3478`), optional TURN servers (URL, username, credential; they ship in the game, so they are not secret), signaling. Without TURN some players behind strict networks cannot connect; the connection screen says so instead of hanging.
- **Native SDKs** (Epic, Steam) run only in the desktop game host and the desktop editor's main process, behind a checked channel as Discord Rich Presence does (`/.haptic/<service>` on the game's own `app://` origin). Desktop packages then need native files (an FFI library, the SDK's shared libraries), which packaging does not carry today.
- **Steam** uses Steam's flat C API through an FFI library and the developer's own Steamworks SDK, so Haptic never redistributes Valve's files. This replaces a separate Steamworks extension.

## Online Subsystem

- An engine-provided Game Subsystem: **Get Online Subsystem**, one node set whatever the backend. Engine subsystems have no native member functions today, so this adds them.
- A provider per platform (web, desktop, mobile) in **Project Settings > Multiplayer**; Multiplayer Play mode always uses Local.
- First version: identity (**Log In**, **Get Local Player**, **Is Logged In**), sessions (**Create Session**, **Find Sessions** with filters, **Join Session**, **Leave Session**, **Get Session Players**, session attributes), invites (**Show Invite Dialog** where an overlay exists, **On Invite Accepted**, **On Session Players Changed**), presence (**Set Presence**). Steam and Epic lobbies map onto sessions; creating a session makes the player the host.
- Provider-neutral structs owned by the subsystem:

| Struct | Fields |
| --- | --- |
| Online Player | Id (text), Display Name |
| Online Session | Id, Name, Host, Player Count, Max Players, Attributes (text map) |
| Session Filter | Key, Comparison (Equal, Not Equal, Less, Greater), Value |
| Session Settings | Name, Max Players, Visibility (Public, Friends Only, Private), Joinable, Attributes |

- Later: achievements, stats, leaderboards, friends, cloud saves, provider-only features (Workshop, Steam Input); Discord presence may move under presence.

## Replication Component

| Property | Default | Does |
| --- | --- | --- |
| Replicate Movement | On | Position and rotation; scale only when it changes |
| Smooth Movement | On | Remote copies interpolate between snapshots; off snaps |
| Interpolation Delay | 100 ms | How far behind the newest snapshot remote copies draw |
| Update Rate | 20 per second | How often the host sends the Actor's state |
| Owner | Host | Whose input drives it; **Is Locally Controlled** on that player |

- Host-spawned replicated Actors appear on every client with the same network id; destroying on the host removes them everywhere. Placed Actors match by scene id. A client's spawn of a replicated class stays local, with a warning.
- Physics simulates on the host only; clients' replicated bodies follow snapshots.
- Class variables get a **Replicated** option and an **On Replicated** event; sendable types: primitives, vectors, rotators, transforms, colours, enums, structs, arrays, replicated Actor references (as network ids). A client's change is overwritten by the next snapshot.
- **Has Authority** is true on the host; game rules check it.
- Character movement prediction for owned characters only: numbered input, host simulates and confirms the last input applied, the client rewinds and replays unconfirmed input; corrections blend over 100 ms, large ones snap. Rigid bodies are never predicted on clients.
- Snapshots are quantized and sent as deltas against the client's last acknowledged one.
- Later: run-on-host, run-on-owning-client and run-on-everyone events.

## Messaging

- **Network Message** assets hold a signature: a name and an ordered list of typed pins, like a Structure; identity survives renames.
- **Send Message to Other Clients**: the signature's pins plus **Target** (All Others, Host, a player id) and **Reliable** (default on). **Event On Message Received**: **Sender** (player id) plus the same pins. Pins are added, renamed or removed from either node's Inspector, which edits the signature and updates every node using it.
- The event fires in every graph that has it for that signature: Game Instance, subsystems and Actors.
- Pin types: primitives, vectors, rotators, transforms, colours, enums, structs, arrays, maps, replicated Actor references (as network ids) and Object (a copy by value: same class, same variable values, nested Objects copied too).
- Wire: a message number (from signature ids; the join build check guarantees agreement), then the values in pin order as binary; only an Object pin carries its class.
- Limits: 16 KiB reliable, 1 KiB unreliable; a larger message fails at the sending node, naming its size.
- Clients connect only to the host, which relays client-to-client messages and can check them.
- A missing signature or pins that no longer match it is a compiler error.

## Multiplayer Play mode

| | Desktop editor | Web and tablet |
| --- | --- | --- |
| Clients, host included | 2 to 4 | 2 |
| Where they show | Host in the Play overlay or popped out; each client in its own window | Side by side in the Play overlay |
| Simulated latency, jitter, loss | Yes | Yes |

- Chosen in the **Debug** menu; uses the Local transport, no account or network.
- Each client is a full game: its own game worker, world, physics and Game Instance, joined like a real client.
- Input and audio follow the focused client (window, or the view last tapped or clicked, outlined).
- Closing a client's window disconnects it; **Stop** ends every client and the host.
- The **Output Log** tags lines Host / Client 1 to 3; the debugger, breakpoints and Pause On Errors work per client; a stats overlay per view shows round-trip time, bandwidth and loss.
- On iPad two full games may run short of memory with heavy scenes; the mode warns when it starts there.
- Later: Preview Build multiplayer and testing between two real devices on a local network.

## Order

1. Design and wire format: `architecture/multiplayer.md`.
2. Local transport and Multiplayer Play mode (split view, pop-out windows), **Is Host**, player events.
3. Messaging: Network Message assets, send and receive nodes.
4. Replication Component: spawn and destroy, movement, replicated variables, smooth movement.
5. Character movement prediction.
6. Gate: four clients play one game together over Local.
7. Online Subsystem and WebRTC.
8. Epic Online Services on desktop.
9. Steam on desktop.
10. Epic Online Services on iOS and Android (native plugins).

## Open decisions

| Decision | Recommendation |
| --- | --- |
| WebRTC signaling | A small open-source signaling server developers host themselves, its URL a setting; no Haptic-run service |
| First online backend | WebRTC: it reaches every platform Haptic runs on |
| Max players online | 8 by default, raised per project once bandwidth is measured |
| Steam binding | Flat C API with the developer's own SDK (reaches every function, nothing of Valve's redistributed) |
| Epic on iOS and Android | After desktop; each platform needs a native plugin |
