import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Global Parameter","description":"","frontmatter":{"node":"global.parameter"},"headers":[],"relativePath":"scripting/particle/global-parameter.md","filePath":"scripting/particle/global-parameter.md"}');
const _sfc_main = { name: "scripting/particle/global-parameter.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="global-parameter" tabindex="-1">Global Parameter <a class="header-anchor" href="#global-parameter" aria-label="Permalink to &quot;Global Parameter&quot;">​</a></h1><p>Returns one parameter of a <a href="./../../assets/global-parameter-collection">Global Parameter Collection</a>: a value the whole game shares, which any Class graph can set while it plays.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Collection</td><td>The Global Parameter Collection to read from. Picking another one clears <strong>Parameter</strong>.</td></tr><tr><td>Parameter</td><td>One of the collection&#39;s parameters. The node is named after it, for example <strong>Wind Strength (Global Float)</strong>.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Its <strong>Value</strong> output takes the parameter&#39;s type: Float, Vector 2, Vector 3 or Color. Without a parameter the node has no output, and its wires are removed.</li><li>The value is the parameter&#39;s default until a Class graph sets it with <strong>Set Global Float Parameter</strong>, <strong>Set Global Vector Parameter</strong> or <strong>Set Global Color Parameter</strong>. Every running emitter that reads it takes the new value on its next frame, and so does every Material.</li><li>Values start at their defaults when Play starts, keep across Scene changes and are never saved.</li><li>Editing a default in the collection updates previews and a running Play at once. In Play, a parameter a Class graph has already set keeps its value.</li><li>Unlike a graph <a href="./parameter">Parameter</a>, it cannot be set per Particle component: it is the same for every emitter.</li><li>A warning shows when no parameter is selected, when the parameter has left its collection or when its type has changed. Select the parameter again to update the node.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/particle/global-parameter.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const globalParameter = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  globalParameter as default
};
