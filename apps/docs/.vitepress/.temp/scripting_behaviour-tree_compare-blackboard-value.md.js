import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Compare Blackboard Value","description":"","frontmatter":{"node":"bt.decorator.compareBlackboardValue"},"headers":[],"relativePath":"scripting/behaviour-tree/compare-blackboard-value.md","filePath":"scripting/behaviour-tree/compare-blackboard-value.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/compare-blackboard-value.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="compare-blackboard-value" tabindex="-1">Compare Blackboard Value <a class="header-anchor" href="#compare-blackboard-value" aria-label="Permalink to &quot;Compare Blackboard Value&quot;">​</a></h1><p>Lets a node run only while a Blackboard key compares true against a value.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Default</th><th>Description</th></tr></thead><tbody><tr><td>Key</td><td></td><td>The Blackboard key to compare.</td></tr><tr><td>Op</td><td>eq</td><td>How the key is compared with <strong>Value</strong>: Equal, Not Equal, Greater, Greater Or Equal, Less, Less Or Equal.</td></tr><tr><td>Value</td><td></td><td>The value to compare against. It appears once you pick a key, and its editor matches the key&#39;s type.</td></tr><tr><td>Abort Mode</td><td></td><td>Controls whether a change in the result interrupts running nodes: None, Self, Lower Priority or Both.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Equal and Not Equal also compare vectors and other structured values field by field, while the other tests compare numbers.</li><li>If the comparison is false the node fails without running; set <strong>Abort Mode</strong> to also interrupt a running node.</li><li>Attach it to a node with <strong>Add Decorator</strong> in the <strong>Inspector</strong>.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/compare-blackboard-value.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const compareBlackboardValue = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  compareBlackboardValue as default
};
