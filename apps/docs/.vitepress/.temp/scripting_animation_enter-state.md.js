import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Enter State","description":"","frontmatter":{"node":"anim.rule.enterState"},"headers":[],"relativePath":"scripting/animation/enter-state.md","filePath":"scripting/animation/enter-state.md"}');
const _sfc_main = { name: "scripting/animation/enter-state.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="enter-state" tabindex="-1">Enter State <a class="header-anchor" href="#enter-state" aria-label="Permalink to &quot;Enter State&quot;">​</a></h1><p>Decides whether the transition may enter its target state.</p><h2 id="inputs" tabindex="-1">Inputs <a class="header-anchor" href="#inputs" aria-label="Permalink to &quot;Inputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th><th>Description</th></tr></thead><tbody><tr><td>Value</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-bool)" })}"></span></span>Boolean</td><td>True lets the transition enter the target state.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>A transition fires only when both <strong>Enter State</strong> and <a href="./exit-state"><strong>Exit State</strong></a> are true. An unconnected input counts as true.</li><li>Found in transition rule graphs, which you open with <strong>Open Rule</strong> on a transition. It cannot be deleted.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/animation/enter-state.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const enterState = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  enterState as default
};
