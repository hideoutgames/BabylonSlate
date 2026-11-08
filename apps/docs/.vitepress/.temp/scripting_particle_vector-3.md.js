import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Vector 3","description":"","frontmatter":{"node":"const.vec3"},"headers":[],"relativePath":"scripting/particle/vector-3.md","filePath":"scripting/particle/vector-3.md"}');
const _sfc_main = { name: "scripting/particle/vector-3.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="vector-3" tabindex="-1">Vector 3 <a class="header-anchor" href="#vector-3" aria-label="Permalink to &quot;Vector 3&quot;">​</a></h1><p>Returns a fixed Vector 3 that you set in the <strong>Inspector</strong>.</p><h2 id="outputs" tabindex="-1">Outputs <a class="header-anchor" href="#outputs" aria-label="Permalink to &quot;Outputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th></tr></thead><tbody><tr><td>Value</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-vector)" })}"></span></span>Vector 3</td></tr></tbody></table><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Value</td><td>The X, Y and Z values to return.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Right-click the node, or long-press it, and choose <strong>Convert to Parameter</strong> to let gameplay change the value. The node becomes a <a href="./parameter">Parameter</a> node whose default is this value; its wires stay.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/particle/vector-3.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const vector3 = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  vector3 as default
};
