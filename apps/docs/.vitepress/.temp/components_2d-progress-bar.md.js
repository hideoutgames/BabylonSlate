import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"2D Progress Bar","description":"","frontmatter":{},"headers":[],"relativePath":"components/2d-progress-bar.md","filePath":"components/2d-progress-bar.md"}');
const _sfc_main = { name: "components/2d-progress-bar.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="2d-progress-bar" tabindex="-1">2D Progress Bar <a class="header-anchor" href="#2d-progress-bar" aria-label="Permalink to &quot;2D Progress Bar&quot;">​</a></h1><p>A display-only bar that fills to show a value between Min and Max, such as health or loading progress.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor in a Scene Layer, then choose <strong>Add Component &gt; Overlay &gt; 2D Progress Bar</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Overlay &gt; 2D Progress Bar</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Enabled</td><td>Turns the control on or off. Default on.</td></tr><tr><td>Width, Height</td><td>Size of the bar in layer units. Default 4 by 0.6.</td></tr><tr><td>Min, Max</td><td>The range. Default 0 to 1. If Min is above Max, the two swap.</td></tr><tr><td>Value</td><td>The current value, kept inside the range. Default is Min.</td></tr><tr><td>Orientation</td><td>Horizontal or Vertical. A vertical bar fills upward. Default Horizontal.</td></tr><tr><td>Opacity</td><td>Fades the whole control, from 0 to 1. Default 1.</td></tr><tr><td>Tint</td><td>Colour and alpha multiplied into every part. Default white.</td></tr><tr><td>Background, Track and Fill Material</td><td>Replace the default look of the body, the rail and the filled part. A Material or Material Instance.</td></tr><tr><td>Background, Track and Fill Texture</td><td>The same, using a Texture. A Material wins when both are set.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Scene Layers only.</li><li>The bar does not react to taps or keys and cannot take focus.</li><li>Drive it from a graph with the <strong>Value</strong> variable or <strong>Set Value</strong>.</li><li><a href="./../scripting/class/event-on-value-changed">Event On Value Changed</a> runs when the value changes.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../scenes/scene-layers">Scene Layers</a></li><li><a href="./2d-slider">2D Slider</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/2d-progress-bar.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const _2dProgressBar = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  _2dProgressBar as default
};
