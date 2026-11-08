import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Hemispheric Fill Light","description":"","frontmatter":{},"headers":[],"relativePath":"components/hemispheric-fill-light.md","filePath":"components/hemispheric-fill-light.md"}');
const _sfc_main = { name: "components/hemispheric-fill-light.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="hemispheric-fill-light" tabindex="-1">Hemispheric Fill Light <a class="header-anchor" href="#hemispheric-fill-light" aria-label="Permalink to &quot;Hemispheric Fill Light&quot;">​</a></h1><p>Soft fill light with one colour from above and another from below. It never casts shadows.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; Rendering &gt; Hemispheric Fill Light</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Lights &gt; Hemispheric Fill</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Enabled</td><td>Turns the light on or off. Default on.</td></tr><tr><td>Color</td><td>The colour of light from above. Default white.</td></tr><tr><td>Ground Color</td><td>The colour of light from below. Default black.</td></tr><tr><td>Intensity</td><td>Brightness, 0 to 16. Default 0.9.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>World scenes only.</li><li>Fill light lifts areas that direct lights do not reach. For lighting from a sky image, use <a href="./../graphics/lighting#environment-lighting">environment lighting</a>.</li><li>It lights without highlights in PBR and CEL. Glossy and metallic surfaces reflect the sky through <a href="./../graphics/lighting#environment-lighting">environment lighting</a> instead.</li><li>One fill light lights a scene at a time: with several on, the others add nothing. The fill does not count toward the local light budget.</li><li>Fill lights do not light volumetric fog.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/lighting">Lighting</a></li><li><a href="./light">Light</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/hemispheric-fill-light.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const hemisphericFillLight = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  hemisphericFillLight as default
};
