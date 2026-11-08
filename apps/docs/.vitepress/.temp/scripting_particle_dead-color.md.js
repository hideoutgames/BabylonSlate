import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Dead Color","description":"","frontmatter":{"node":"input.contextual.deadColor"},"headers":[],"relativePath":"scripting/particle/dead-color.md","filePath":"scripting/particle/dead-color.md"}');
const _sfc_main = { name: "scripting/particle/dead-color.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="dead-color" tabindex="-1">Dead Color <a class="header-anchor" href="#dead-color" aria-label="Permalink to &quot;Dead Color&quot;">​</a></h1><p>Returns the dead colour that the particle was created with.</p><h2 id="outputs" tabindex="-1">Outputs <a class="header-anchor" href="#outputs" aria-label="Permalink to &quot;Outputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th></tr></thead><tbody><tr><td>Dead Color</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-color)" })}"></span></span>Color</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li><a href="./fade-to-dead-color"><strong>Fade To Dead Color</strong></a> blends the particle towards this colour over its life.</li><li>Reads the particle being processed, so it gives no value in <strong>Emit Rate</strong>.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/particle/dead-color.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const deadColor = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  deadColor as default
};
