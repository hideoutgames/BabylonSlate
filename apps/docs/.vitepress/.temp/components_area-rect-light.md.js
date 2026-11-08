import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Rectangular Area Light","description":"","frontmatter":{},"headers":[],"relativePath":"components/area-rect-light.md","filePath":"components/area-rect-light.md"}');
const _sfc_main = { name: "components/area-rect-light.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="rectangular-area-light" tabindex="-1">Rectangular Area Light <a class="header-anchor" href="#rectangular-area-light" aria-label="Permalink to &quot;Rectangular Area Light&quot;">​</a></h1><p>A rectangular emitter for windows, screens and light panels. It does not cast shadows.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; Rendering &gt; Rectangular Area Light</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Enabled</td><td>Turns the light on or off. Default on.</td></tr><tr><td>Width</td><td>Width of the emitter in local units. Default 1.</td></tr><tr><td>Height</td><td>Height of the emitter in local units. Default 1.</td></tr><tr><td>Color</td><td>The light colour. Default white.</td></tr><tr><td>Intensity</td><td>Brightness. Default 1.</td></tr><tr><td>Emission Texture</td><td>A Texture the emitter shows. Empty emits a uniform colour.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>World scenes only.</li><li>The light emits along the component&#39;s forward (+Z) axis. It lights through walls, because it casts no shadows.</li><li>Actor and parent scale apply to Width and Height. Sheared transforms are not supported.</li><li>Picking an <strong>Emission Texture</strong> in a scene or prefab prepares it automatically. Until its emission data is ready the light stays off, and the Inspector says why. You can also prepare a Texture ahead of time: open it and choose <strong>Prepare Emission</strong>. A Texture that has not been prepared cannot be loaded for Play or export.</li><li>The emitter counts toward the local light budget.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/lighting">Lighting</a></li><li><a href="./../assets/texture">Texture</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/area-rect-light.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const areaRectLight = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  areaRectLight as default
};
