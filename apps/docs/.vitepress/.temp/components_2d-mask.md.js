import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"2D Mask","description":"","frontmatter":{},"headers":[],"relativePath":"components/2d-mask.md","filePath":"components/2d-mask.md"}');
const _sfc_main = { name: "components/2d-mask.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="2d-mask" tabindex="-1">2D Mask <a class="header-anchor" href="#2d-mask" aria-label="Permalink to &quot;2D Mask&quot;">​</a></h1><p>Clips an actor and everything under it to a rectangle, without affecting layout.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor in a Scene Layer, then choose <strong>Add Component &gt; Overlay &gt; 2D Mask</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Overlay &gt; 2D Mask</strong>.</p><p>Put it on the actor whose visuals you want to clip. Or add it to an empty child actor to clip that child&#39;s parent, the same way a <a href="./2d-padding">2D Padding</a> helper works.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Width</td><td>Width of the visible rectangle, in layer units. Default 4.</td></tr><tr><td>Height</td><td>Height of the visible rectangle, in layer units. Default 4.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Scene Layers only.</li><li>The rectangle is centred on the mask. Anything outside it, on the owning actor, its other components and its child actors, is not drawn and cannot be clicked.</li><li>The mask takes no layout slot and does not move or resize anything it clips. It does not clip siblings of the owning actor.</li><li>Masks combine with other clips, such as those of a scroll box, and only the overlap shows.</li><li>Hidden masks do nothing.</li><li>To arrange children and clip them in one step, use a <a href="./2d-mask-panel">2D Mask Panel</a>.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../scenes/scene-layers">Scene Layers</a></li><li><a href="./2d-mask-panel">2D Mask Panel</a></li><li><a href="./2d-scroll-box">2D Scroll Box</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/2d-mask.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const _2dMask = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  _2dMask as default
};
