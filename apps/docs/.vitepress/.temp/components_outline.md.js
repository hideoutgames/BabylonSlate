import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Outline","description":"","frontmatter":{},"headers":[],"relativePath":"components/outline.md","filePath":"components/outline.md"}');
const _sfc_main = { name: "components/outline.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="outline" tabindex="-1">Outline <a class="header-anchor" href="#outline" aria-label="Permalink to &quot;Outline&quot;">​</a></h1><p>Draws a coloured silhouette around an actor, with its own colour, width and visibility.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; Rendering &gt; Outline</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Enabled</td><td>Shows the outline. Turning it off reveals any global CEL outline that applies. Default on.</td></tr><tr><td>Color</td><td>The outline colour. Default near black.</td></tr><tr><td>Width</td><td>Width in screen pixels, 0.25 to 8. It does not change with the actor&#39;s scale. Default 1.</td></tr><tr><td>Render Through Meshes</td><td>Shows the outline through other geometry, for example to highlight a target behind a wall. Default off.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>World scenes only.</li><li>The outline follows the geometry of the actor it is on, such as a <a href="./mesh">Mesh</a>.</li><li>Global CEL outlines stay hidden behind other geometry. Only this component can draw through meshes.</li><li>For outlines on every object in a CEL project, use the project&#39;s CEL Shading settings.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/lighting#cel-shading">Lighting</a></li><li><a href="./../graphics/geometry">Geometry</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/outline.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const outline = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  outline as default
};
