import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Exit Time Reached","description":"","frontmatter":{"node":"anim.state.exitTimeReached"},"headers":[],"relativePath":"scripting/animation/exit-time-reached.md","filePath":"scripting/animation/exit-time-reached.md"}');
const _sfc_main = { name: "scripting/animation/exit-time-reached.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="exit-time-reached" tabindex="-1">Exit Time Reached <a class="header-anchor" href="#exit-time-reached" aria-label="Permalink to &quot;Exit Time Reached&quot;">​</a></h1><p>Returns true in the update where the clip passes a given point in time.</p><h2 id="inputs" tabindex="-1">Inputs <a class="header-anchor" href="#inputs" aria-label="Permalink to &quot;Inputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th><th>Description</th></tr></thead><tbody><tr><td>Exit Time</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-float)" })}"></span></span>Float</td><td>Point in the clip to test, where 1 is the end. Defaults to 1.</td></tr></tbody></table><h2 id="outputs" tabindex="-1">Outputs <a class="header-anchor" href="#outputs" aria-label="Permalink to &quot;Outputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th></tr></thead><tbody><tr><td>Value</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-bool)" })}"></span></span>Boolean</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Exit Time is normalised: 0 is the start of the clip and 1 is the end. In a non-looping state it stays true once reached.</li><li>In a looping state it fires once per loop, on the update that crosses the point; a value above 1 fires once, after that many loops.</li><li>Only available in transition rule graphs, where it reads the state the transition leaves.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/animation/exit-time-reached.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const exitTimeReached = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  exitTimeReached as default
};
