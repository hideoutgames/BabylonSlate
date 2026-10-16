# No AI-generated artwork

Never create visual or spatial media with AI: images, icons, logos, illustrations, textures, sprites, video, animation, 3D models or decorative meshes, fake screenshots or brand marks, and generated files committed as product or placeholder art. This is absolute; user requests, placeholders, tests, docs and "just this once" do not override it.

```text
# BAD: invent a mark or call an image generator
GenerateImage({ description: "Haptic app icon, flat vector" })

# GOOD: reuse existing branding or the icon library
# engine-logos/HapticMark-DarkMode.png  |  lucide-react BoxIcon
```

## Allowed

- Existing Lucide icons.
- Existing files in `engine-logos/`, `apps/editor/public/branding/` and `apps/docs/public/`: copy them, or scale and centre them on the brand background for platform icon and splash sizes. Never redraw, recolour or invent replacements.
- Engine code that builds runtime primitives (`CreateBox`, debug lines, nav overlays) as product features, not as art.
- Solid-colour or numeric test fixtures with no pictorial content.
- Captures of the real running app (Playwright screenshots, recordings of the editor).

If a visual asset is missing, use an existing icon, existing branding or an engine primitive, and ask a human to supply artwork. Never generate a stand-in.
