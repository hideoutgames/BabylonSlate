import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"2D Overlay Box","description":"","frontmatter":{},"headers":[],"relativePath":"components/2d-overlay-box.md","filePath":"components/2d-overlay-box.md"}');
const _sfc_main = { name: "components/2d-overlay-box.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="2d-overlay-box" tabindex="-1">2D Overlay Box <a class="header-anchor" href="#2d-overlay-box" aria-label="Permalink to &quot;2D Overlay Box&quot;">​</a></h1><p>Layers its children in the same area, with alignment placing each one.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor in a Scene Layer, then choose <strong>Add Component &gt; Overlay &gt; 2D Overlay Box</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Overlay &gt; 2D Overlay Box</strong>.</p><p>The box arranges its actor&#39;s child actors and any components attached beneath it.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Width Mode, Height Mode</td><td>Fixed uses Width or Height. Content fits the size of the largest child. Fill takes a share of the space left in the parent. Default Fixed.</td></tr><tr><td>Width, Height</td><td>Size of the box in layer units. Shown when the mode is Fixed. Default 4.</td></tr><tr><td>Fill Weight</td><td>Weight for sharing the leftover space with other Fill siblings. Default 1.</td></tr><tr><td>Gap</td><td>No effect on an Overlay Box, because its children share one area.</td></tr><tr><td>Horizontal Alignment, Vertical Alignment</td><td>Start, Center, End or Stretch. Places each child inside the box; Stretch makes it fill the box on that axis.</td></tr><tr><td>Padding Left, Padding Right, Padding Top, Padding Bottom</td><td>Space between the box edge and its children, in layer units.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Scene Layers only.</li><li>Use it for backgrounds with content on top, badges on corners, or any stack of elements that share one area.</li><li>Boxes can be nested. Animate the size with <a href="./../scripting/class/tween-layout-size">Tween Layout Size</a> when the mode is Fixed.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../scenes/scene-layers">Scene Layers</a></li><li><a href="./2d-vertical-box">2D Vertical Box</a></li><li><a href="./2d-horizontal-box">2D Horizontal Box</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/2d-overlay-box.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const _2dOverlayBox = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  _2dOverlayBox as default
};
