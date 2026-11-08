import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"2D Material","description":"","frontmatter":{},"headers":[],"relativePath":"components/2d-material.md","filePath":"components/2d-material.md"}');
const _sfc_main = { name: "components/2d-material.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="2d-material" tabindex="-1">2D Material <a class="header-anchor" href="#2d-material" aria-label="Permalink to &quot;2D Material&quot;">​</a></h1><p>Draws a Material as a flat square on a Scene Layer, for effects such as gradients, glows and animated shaders.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor in a Scene Layer, then choose <strong>Add Component &gt; Overlay &gt; 2D Material</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Overlay &gt; 2D Material</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Material</td><td>The <a href="./../assets/material">Material</a> or Material Instance to draw.</td></tr><tr><td>Hit Test</td><td>Whether taps hit the square. Ignore (default) lets them pass through. Block takes the tap and stops it. Pass Through takes it and lets it continue to what is behind.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Scene Layers only.</li><li>There is no size setting. The square is one unit across until you resize it with the box around the actor in the viewport.</li><li>The Material is drawn unlit, so lights have no effect on it.</li><li>The component has <strong>Opacity</strong> and <strong>Tint</strong> variables for graphs. Animate them with <a href="./../scripting/class/tween-2d-opacity">Tween 2D Opacity</a> and <a href="./../scripting/class/tween-2d-tint">Tween 2D Tint</a>.</li><li>Add a <a href="./2d-button">2D Button</a> to the same actor to make the square clickable.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../scenes/scene-layers">Scene Layers</a></li><li><a href="./../graphics/materials">Materials</a></li><li><a href="./2d-texture">2D Texture</a></li><li><a href="./2d-panel">2D Panel</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/2d-material.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const _2dMaterial = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  _2dMaterial as default
};
