import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Normalized Age","description":"","frontmatter":{"node":"input.contextual.normalizedAge"},"headers":[],"relativePath":"scripting/particle/normalized-age.md","filePath":"scripting/particle/normalized-age.md"}');
const _sfc_main = { name: "scripting/particle/normalized-age.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="normalized-age" tabindex="-1">Normalized Age <a class="header-anchor" href="#normalized-age" aria-label="Permalink to &quot;Normalized Age&quot;">​</a></h1><p>Returns how far through its life the particle is, from 0 at birth to 1 at death.</p><h2 id="outputs" tabindex="-1">Outputs <a class="header-anchor" href="#outputs" aria-label="Permalink to &quot;Outputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th></tr></thead><tbody><tr><td>Normalized Age</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-float)" })}"></span></span>Float</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Wire it into the <strong>Ratio</strong> of a <a href="./gradient"><strong>Gradient</strong></a> to change a value over a particle&#39;s life.</li><li>Reads the particle being processed, so it gives no value in <strong>Emit Rate</strong>.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/particle/normalized-age.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const normalizedAge = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  normalizedAge as default
};
