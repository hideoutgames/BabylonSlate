import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Gradient","description":"","frontmatter":{"node":"gradient.sample"},"headers":[],"relativePath":"scripting/particle/gradient.md","filePath":"scripting/particle/gradient.md"}');
const _sfc_main = { name: "scripting/particle/gradient.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="gradient" tabindex="-1">Gradient <a class="header-anchor" href="#gradient" aria-label="Permalink to &quot;Gradient&quot;">​</a></h1><p>Returns a value sampled from a gradient of 2 to 8 stops at a position from 0 to 1.</p><h2 id="inputs" tabindex="-1">Inputs <a class="header-anchor" href="#inputs" aria-label="Permalink to &quot;Inputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody><tr><td>Ratio</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-float)" })}"></span></span>Float</td><td>0</td><td>Position along the gradient. Values outside 0 to 1 are limited to that range.</td></tr></tbody></table><h2 id="outputs" tabindex="-1">Outputs <a class="header-anchor" href="#outputs" aria-label="Permalink to &quot;Outputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th></tr></thead><tbody><tr><td>Value</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-color)" })}"></span></span>Color</td></tr></tbody></table><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Value Type</td><td>The type of the stops and of the output: Float, Vector 2, Vector 3 or Color. The default is Color.</td></tr><tr><td>Stops</td><td>The gradient stops, each with a position from 0 to 1 and a value. Colour stops use a gradient editor and Float stops use a curve editor.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Wire <a href="./normalized-age"><strong>Normalized Age</strong></a> into <strong>Ratio</strong> to change a value over a particle&#39;s life.</li><li>Values between two stops are blended in a straight line.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/particle/gradient.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const gradient = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  gradient as default
};
