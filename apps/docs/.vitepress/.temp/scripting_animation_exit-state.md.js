import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Exit State","description":"","frontmatter":{"node":"anim.rule.exitState"},"headers":[],"relativePath":"scripting/animation/exit-state.md","filePath":"scripting/animation/exit-state.md"}');
const _sfc_main = { name: "scripting/animation/exit-state.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="exit-state" tabindex="-1">Exit State <a class="header-anchor" href="#exit-state" aria-label="Permalink to &quot;Exit State&quot;">​</a></h1><p>Decides whether the transition may leave its source state.</p><h2 id="inputs" tabindex="-1">Inputs <a class="header-anchor" href="#inputs" aria-label="Permalink to &quot;Inputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th><th>Description</th></tr></thead><tbody><tr><td>Value</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-bool)" })}"></span></span>Boolean</td><td>True lets the transition leave the source state.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>A transition fires only when both <a href="./enter-state"><strong>Enter State</strong></a> and <strong>Exit State</strong> are true. An unconnected input counts as true.</li><li>For a one-way transition, this node is dimmed and always counts as true.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/animation/exit-state.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const exitState = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  exitState as default
};
