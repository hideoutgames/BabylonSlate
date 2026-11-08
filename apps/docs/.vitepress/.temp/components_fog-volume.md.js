import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Fog Volume","description":"","frontmatter":{},"headers":[],"relativePath":"components/fog-volume.md","filePath":"components/fog-volume.md"}');
const _sfc_main = { name: "components/fog-volume.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="fog-volume" tabindex="-1">Fog Volume <a class="header-anchor" href="#fog-volume" aria-label="Permalink to &quot;Fog Volume&quot;">​</a></h1><p>A local box or sphere of fog with soft edges.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; Rendering &gt; Fog Volume</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Environment &gt; Fog Volume</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Enabled</td><td>Turns the fog on or off. Default on.</td></tr><tr><td>Shape</td><td><strong>Box</strong> or <strong>Sphere</strong>. Default Box.</td></tr><tr><td>Size</td><td>Full width, height and depth along local X, Y and Z, in scene units. A sphere with unequal values stretches. Default 10, 10, 10.</td></tr><tr><td>Density</td><td>Fog added inside the volume. 0 adds none. Default 0.1.</td></tr><tr><td>Edge Falloff</td><td>Soft edge as a fraction of the half-size. 0 is a hard edge and 1 fades from the centre. Default 0.2.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>World scenes only.</li><li>Actor and component scale also change the size.</li><li>Overlapping volumes add their density. Up to eight nearby visible volumes contribute at once.</li><li>A Fog Volume works without Scene-Wide Fog. Shared quality settings are in <strong>Project Settings &gt; Rendering &gt; Post Processing</strong>.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/sky-and-fog">Sky and fog</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/fog-volume.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const fogVolume = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  fogVolume as default
};
