# Default skybox cubemap

New 3D scenes seed a `SkyboxComponent` with empty `faces`. Empty faces load this
engine default cubemap — a **runtime geometric daylight gradient** encoded as six
PNG buffers and built with `CubeTexture.CreateFromImages` in Babylon order
(`px`, `py`, `pz`, `nx`, `ny`, `nz`). It is not a Content Browser Texture and not IBL.

The six painterly cube faces from the original authoring brief are not in this
repository. Do not generate stand-in artwork. Authors assign imported Texture
assets on the component when they want a custom sky.
