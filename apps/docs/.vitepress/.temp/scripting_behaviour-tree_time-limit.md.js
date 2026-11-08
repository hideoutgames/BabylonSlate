import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Time Limit","description":"","frontmatter":{"node":"bt.decorator.timeLimit"},"headers":[],"relativePath":"scripting/behaviour-tree/time-limit.md","filePath":"scripting/behaviour-tree/time-limit.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/time-limit.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="time-limit" tabindex="-1">Time Limit <a class="header-anchor" href="#time-limit" aria-label="Permalink to &quot;Time Limit&quot;">​</a></h1><p>Fails a node if it runs for longer than a set time.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Default</th><th>Description</th></tr></thead><tbody><tr><td>Duration MS</td><td>1000</td><td>The longest the node may run, in milliseconds.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>The node is aborted when the limit passes, so a long <a href="./wait"><strong>Wait</strong></a> or <a href="./move-to"><strong>Move To</strong></a> cannot stall the tree.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/time-limit.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const timeLimit = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  timeLimit as default
};
