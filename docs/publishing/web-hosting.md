# Hosting web games

The web package is a folder of static files: `index.html` at its root, the game's scripts and data beside it. Any static web host can serve it, and itch.io takes the ZIP as it is. This page covers what the game asks of the host, and the response headers you can set to help it.

## What the game needs

| Need | Why |
| --- | --- |
| HTTPS | Browsers offer what the game uses to check its files, keep saves and get cross-origin isolation only to secure pages, so over plain HTTP the game does not start. `localhost` counts as secure while you test. |
| The whole folder, as packaged | The game reads its files by paths relative to `index.html`. Keep every file and subfolder in place. |
| JavaScript files served as JavaScript | Browsers refuse to run the game's `.js` files under any other type. Use `text/javascript`. |
| `.wasm` files served as `application/wasm` | Recommended. With another type the game still runs, but the physics and decoder runtimes start more slowly and the browser console shows warnings. |

The game can live at the root of a site or in a subfolder, such as `https://example.com/games/space-game/`. Several games can share a site, each in its own folder.

Opening `index.html` straight from your file system does not work: browsers do not run the game's scripts from local files. To try the unzipped game on your computer, serve the folder with a local web server and open its `localhost` address.

## Cross-origin isolation

Browsers let a page share memory between threads, and give it more precise timers, only when the page is cross-origin isolated. The game plays the same without it, and uses both when the browser offers them. A page is isolated when the host sends these two response headers with it:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- Use `require-corp`. `credentialless` also isolates the page in Chromium-based browsers and Firefox, but Safari does not support it.
- With `require-corp`, the page can load files from other sites only when those sites allow it. The game itself loads only its own files, so this matters only if you add something from another site to the page, such as a web portal's script.
- If another site's cross-origin isolated page embeds your game in a frame, also send `Cross-Origin-Resource-Policy: cross-origin`.

### When your host cannot set headers

Some hosts, such as GitHub Pages, do not let you set response headers. The package includes `coi-serviceworker.js` for them: a small service worker that adds the isolation headers to the game's own files in the browser.

- On a player's first visit, the page reloads once so that the service worker can take over. Later visits start isolated straight away.
- It needs a secure page (HTTPS or `localhost`) and a browser that allows service workers. Some browsers turn service workers off in private windows, and then the game runs without isolation.
- It cannot isolate a game that another site shows in a frame unless that site's page is isolated too. Hosts that embed games in their own page, such as itch.io, decide this; check your host's documentation for a cross-origin isolation or SharedArrayBuffer option.
- When the host already sends the headers, the page is isolated from the start and the service worker does not install itself.

## Content Security Policy

The web package sets no Content Security Policy of its own, so it runs unchanged on every host and inside other sites' pages. If your host adds a policy, or you want one, allow at least what the game uses:

```
default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' data: blob: https: wss:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'
```

This is the policy Haptic's desktop, Android and iOS games use.

| Directive | Why the game needs it |
| --- | --- |
| `script-src 'unsafe-eval'` | Your graphs and **Execute JavaScript** bodies ship as code that the game compiles when it loads. Without it, no script runs. |
| `script-src 'wasm-unsafe-eval'` | Physics, navigation and the texture and mesh decoders are WebAssembly. |
| `worker-src 'self' blob:` | The game runs its scripts and physics on a separate thread. |
| `style-src 'unsafe-inline'` | The page's styles are inside `index.html`. |
| `img-src`, `media-src`, `font-src` with `data:` and `blob:` | Textures, sounds and fonts are unpacked in the browser and shown from memory. |
| `connect-src 'self' data: blob:` | The game downloads its own files. |
| `connect-src https: wss:` | Lets your scripts reach any HTTPS or secure WebSocket server. List only the servers your game uses if you prefer; the game itself needs none. |

- Send the policy with every file the game serves, not only `index.html`. The game's scripts run in a worker, which follows the policy sent with its own file rather than the page's.
- `frame-ancestors` decides which sites may show the game in a frame. Leave it out, or list those sites, if a portal embeds your game; `'none'` stops it working there.
- If you add another site's script to `index.html`, such as a web portal's script, add that site to `script-src` and to the other directives it needs.

## Example header settings

These set the isolation headers and the `.wasm` type on common hosts. Where to put each file, and whether your plan allows it, is in your host's documentation.

A `_headers` file in the folder you publish, on hosts that read one, such as Netlify and Cloudflare Pages:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

nginx, in the `server` block, with the path where the game lives:

```nginx
location /games/space-game/ {
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
}
```

Check that nginx's `mime.types` maps `wasm` to `application/wasm`, and add the line `application/wasm wasm;` to it if not.

Apache, in an `.htaccess` file beside `index.html` (the server must allow `.htaccess` overrides and have `mod_headers`):

```apache
<IfModule mod_headers.c>
    Header set Cross-Origin-Opener-Policy "same-origin"
    Header set Cross-Origin-Embedder-Policy "require-corp"
</IfModule>
AddType application/wasm .wasm
```

To add a Content Security Policy, add a `Content-Security-Policy` header the same way, with the policy above as its value.

## Related

- [Publishing](index.md)
- [Preview Build](preview-build.md)
