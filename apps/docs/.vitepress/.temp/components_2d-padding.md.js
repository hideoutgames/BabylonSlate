import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"2D Padding","description":"","frontmatter":{},"headers":[],"relativePath":"components/2d-padding.md","filePath":"components/2d-padding.md"}');
const _sfc_main = { name: "components/2d-padding.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="2d-padding" tabindex="-1">2D Padding <a class="header-anchor" href="#2d-padding" aria-label="Permalink to &quot;2D Padding&quot;">​</a></h1><p>Insets the content of its parent without drawing anything or taking a layout slot.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Place a ready-made helper from <strong>Place Actors &gt; Overlay &gt; 2D Padding</strong> and drag it under the box in the Outliner. Or add a new empty child actor to the box, select it, then choose <strong>Add Component &gt; Overlay &gt; 2D Padding</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Padding Left</td><td>Space added on the left edge, in layer units. Default 0.</td></tr><tr><td>Padding Right</td><td>Space added on the right edge. Default 0.</td></tr><tr><td>Padding Top</td><td>Space added on the top edge. Default 0.</td></tr><tr><td>Padding Bottom</td><td>Space added on the bottom edge. Default 0.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Scene Layers only.</li><li>It affects only its immediate parent, and adds to any padding already set on the parent box.</li><li>It has no size and no visual. Hidden helpers are ignored.</li><li>Boxes have their own four padding settings. 2D Padding adds to them.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../scenes/scene-layers">Scene Layers</a></li><li><a href="./2d-vertical-box">2D Vertical Box</a></li><li><a href="./2d-horizontal-box">2D Horizontal Box</a></li><li><a href="./2d-spacer">2D Spacer</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/2d-padding.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const _2dPadding = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  _2dPadding as default
};
