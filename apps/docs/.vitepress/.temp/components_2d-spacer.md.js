import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"2D Spacer","description":"","frontmatter":{},"headers":[],"relativePath":"components/2d-spacer.md","filePath":"components/2d-spacer.md"}');
const _sfc_main = { name: "components/2d-spacer.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="2d-spacer" tabindex="-1">2D Spacer <a class="header-anchor" href="#2d-spacer" aria-label="Permalink to &quot;2D Spacer&quot;">​</a></h1><p>Adds empty space inside a box, either a fixed size or a flexible share of what is left.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor in a Scene Layer, then choose <strong>Add Component &gt; Overlay &gt; 2D Spacer</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Overlay &gt; 2D Spacer</strong>. Put it between the elements it should separate, inside a 2D Vertical Box or 2D Horizontal Box.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Width Mode, Height Mode</td><td>Fixed and Content use Width or Height. Fill takes a share of the space left in the parent. Default Fill.</td></tr><tr><td>Width, Height</td><td>Size in layer units, used when the mode is not Fill. Default 1.</td></tr><tr><td>Fill Weight</td><td>Weight for sharing the leftover space with other Fill siblings. Default 1.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Scene Layers only.</li><li>A Spacer with Fill takes whatever room the other children leave, so it pushes them apart. Two Fill spacers with equal weights centre the elements between them.</li><li>It draws nothing.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../scenes/scene-layers">Scene Layers</a></li><li><a href="./2d-vertical-box">2D Vertical Box</a></li><li><a href="./2d-horizontal-box">2D Horizontal Box</a></li><li><a href="./2d-padding">2D Padding</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/2d-spacer.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const _2dSpacer = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  _2dSpacer as default
};
