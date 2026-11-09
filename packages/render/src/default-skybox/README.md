# Default skybox cubemap

New 3D scenes seed a `SkyboxComponent` with empty `faces`. Empty faces load the
engine default cubemap from [`engine-content/skybox/`](../../../engine-content/skybox/)
(`px.png` … `nz.png`, 1024×1024) via `CubeTexture` in Babylon order
(`px`, `py`, `pz`, `nx`, `ny`, `nz`). Vite copies those six files into editor
and player `public/engine-content/skybox/`. They are not Content Browser
Textures and not IBL.

The faces are Kenney's CC0 `skybox-day` panorama reprojected into a cube, with
its sun disc turned toward `DEFAULT_SCENE_SUN_POSITION`; `Source.txt` and
`License.txt` beside them record the origin, the reprojection and the license.
New 3D scenes' fog colour (`DEFAULT_3D_FOG_COLOR` in `@haptic/core`) is the
faces' mean horizon colour: change it with the faces.

`cubemap_layout.png` in that folder is the 4×3 mapping diagram only — it is not
a cube face. Skybox Creator Preview letterboxes that same 4×3 of **square**
cells so Create crops 1:1 faces. Authors assign Texture assets on the component
(or Skybox Creator output) when they want a custom sky.
