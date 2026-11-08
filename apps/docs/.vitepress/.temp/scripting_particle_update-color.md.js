import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Update Color","description":"","frontmatter":{"node":"update.color"},"headers":[],"relativePath":"scripting/particle/update-color.md","filePath":"scripting/particle/update-color.md"}');
const _sfc_main = { name: "scripting/particle/update-color.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="update-color" tabindex="-1">Update Color <a class="header-anchor" href="#update-color" aria-label="Permalink to &quot;Update Color&quot;">​</a></h1><p>Sets the colour of every particle each frame.</p><h2 id="inputs" tabindex="-1">Inputs <a class="header-anchor" href="#inputs" aria-label="Permalink to &quot;Inputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th></tr></thead><tbody><tr><td>Particle</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-particle)" })}"></span></span>Particle</td></tr><tr><td>Color</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-color)" })}"></span></span>Color</td></tr></tbody></table><h2 id="outputs" tabindex="-1">Outputs <a class="header-anchor" href="#outputs" aria-label="Permalink to &quot;Outputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th></tr></thead><tbody><tr><td>Particle</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-particle)" })}"></span></span>Particle</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>It replaces the particle&#39;s colour, so read <a href="./initial-color"><strong>Initial Color</strong></a> or <a href="./particle-color"><strong>Particle Color</strong></a> in its input to keep the colour from <a href="./create-particle"><strong>Create Particle</strong></a>.</li><li>Multiply <a href="./initial-color"><strong>Initial Color</strong></a> by a <a href="./gradient"><strong>Gradient</strong></a> over <a href="./normalized-age"><strong>Normalized Age</strong></a> to tint particles over their life.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/particle/update-color.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const updateColor = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  updateColor as default
};
