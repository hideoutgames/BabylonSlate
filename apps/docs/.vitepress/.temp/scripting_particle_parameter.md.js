import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Parameter","description":"","frontmatter":{"node":"input.parameter"},"headers":[],"relativePath":"scripting/particle/parameter.md","filePath":"scripting/particle/parameter.md"}');
const _sfc_main = { name: "scripting/particle/parameter.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="parameter" tabindex="-1">Parameter <a class="header-anchor" href="#parameter" aria-label="Permalink to &quot;Parameter&quot;">​</a></h1><p>Returns a graph parameter: a value that gameplay can change while the emitter runs.</p><h2 id="outputs" tabindex="-1">Outputs <a class="header-anchor" href="#outputs" aria-label="Permalink to &quot;Outputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th></tr></thead><tbody><tr><td>Value</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-float)" })}"></span></span>Any</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Each parameter has one Parameter node. Add one from <strong>Add Node</strong> under <strong>Parameter</strong>, or right-click a constant node and choose <strong>Convert to Parameter</strong>. <strong>Convert to Constant</strong> turns it back into a constant holding the parameter&#39;s default.</li><li>Select it to edit the parameter&#39;s <strong>Name</strong>, <strong>Type</strong> and <strong>Default</strong> in the <strong>Inspector</strong>. A name that is already taken gets <strong>_1</strong>, <strong>_2</strong> and so on.</li><li>A copy, duplicate or paste of the node gets its own new parameter.</li><li>Its type is the parameter&#39;s: Float, Vector 2, Vector 3 or Color.</li><li>Gameplay sets the value by the parameter&#39;s name for every emitter of a Particle System that reads it, with a Particle component&#39;s <strong>Set Float Parameter</strong> function and its Vector and Color versions (<a href="./../../components/particle#scripting">Particle</a>). Without a value set, the Particle System&#39;s default applies, then the parameter&#39;s own default.</li><li>Changing a parameter&#39;s name or default keeps the running emitter; its particles take the new value.</li><li>The parameter is removed when its node is deleted or converted.</li><li>A node whose parameter is missing shows an error until you convert it or delete it.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/particle/parameter.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const parameter = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  parameter as default
};
