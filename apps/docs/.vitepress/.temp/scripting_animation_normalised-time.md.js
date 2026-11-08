import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Normalised Time","description":"","frontmatter":{"node":"anim.state.normalisedTime"},"headers":[],"relativePath":"scripting/animation/normalised-time.md","filePath":"scripting/animation/normalised-time.md"}');
const _sfc_main = { name: "scripting/animation/normalised-time.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="normalised-time" tabindex="-1">Normalised Time <a class="header-anchor" href="#normalised-time" aria-label="Permalink to &quot;Normalised Time&quot;">​</a></h1><p>Returns how far through its clip the current state is, from 0 to 1.</p><h2 id="outputs" tabindex="-1">Outputs <a class="header-anchor" href="#outputs" aria-label="Permalink to &quot;Outputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th></tr></thead><tbody><tr><td>Value</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-float)" })}"></span></span>Float</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>In a looping state it wraps back to 0 and never reaches 1. Use <a href="./exit-time-reached"><strong>Exit Time Reached</strong></a> to detect the end of a loop.</li><li>Only available in transition rule graphs, where it reads the state the transition leaves.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/animation/normalised-time.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const normalisedTime = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  normalisedTime as default
};
