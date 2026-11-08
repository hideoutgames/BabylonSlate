import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Blackboard Is Set","description":"","frontmatter":{"node":"bt.decorator.blackboardIsSet"},"headers":[],"relativePath":"scripting/behaviour-tree/blackboard-is-set.md","filePath":"scripting/behaviour-tree/blackboard-is-set.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/blackboard-is-set.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="blackboard-is-set" tabindex="-1">Blackboard Is Set <a class="header-anchor" href="#blackboard-is-set" aria-label="Permalink to &quot;Blackboard Is Set&quot;">​</a></h1><p>Lets a node run only while a Blackboard key has a value.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Key</td><td>The Blackboard key to check.</td></tr><tr><td>Abort Mode</td><td>Controls whether a change in the result interrupts running nodes: None, Self, Lower Priority or Both.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>A key counts as set unless it has no value or is false, and the node fails without running when the check fails.</li><li>Set <strong>Abort Mode</strong> to stop the node when the key becomes unset, or to interrupt lower-priority branches when it becomes set.</li><li>Attach it to a node with <strong>Add Decorator</strong> in the <strong>Inspector</strong>.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/blackboard-is-set.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const blackboardIsSet = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  blackboardIsSet as default
};
