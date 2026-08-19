# Default skybox cubemap

New 3D scenes seed a `SkyboxComponent` with empty `faces`. Empty faces load the
engine default cubemap from [`engine-content/skybox/`](../../../engine-content/skybox/)
(`px.png` … `nz.png`, 512×512) via `CubeTexture` in Babylon order
(`px`, `py`, `pz`, `nx`, `ny`, `nz`). Vite copies those six files into editor
and player `public/engine-content/skybox/`. They are not Content Browser
Textures and not IBL.

`cubemap_layout.png` in that folder is the 4×3 mapping diagram only — it is not
a cube face. Authors assign Texture assets on the component (or Skybox Creator
output) when they want a custom sky.
