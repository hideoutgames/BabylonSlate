import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Set Blackboard","description":"","frontmatter":{"node":"bt.service.setBlackboard"},"headers":[],"relativePath":"scripting/behaviour-tree/set-blackboard-service.md","filePath":"scripting/behaviour-tree/set-blackboard-service.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/set-blackboard-service.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="set-blackboard" tabindex="-1">Set Blackboard <a class="header-anchor" href="#set-blackboard" aria-label="Permalink to &quot;Set Blackboard&quot;">​</a></h1><p>Writes a value to a Blackboard key at regular intervals while its node is active.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Default</th><th>Description</th></tr></thead><tbody><tr><td>Key</td><td></td><td>The Blackboard key to write.</td></tr><tr><td>Value</td><td>true</td><td>The value to store. It appears once you pick a key, and its editor matches the key&#39;s type.</td></tr><tr><td>Interval</td><td></td><td>How often the service writes, in milliseconds. The default is 250.</td></tr><tr><td>Random Deviation</td><td></td><td>Varies each interval by up to this many milliseconds, either way. The default is 0.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Attach it to a node with <strong>Add Service</strong> in the <strong>Inspector</strong>.</li><li>It runs while that node, or any of its children, is running.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/set-blackboard-service.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const setBlackboardService = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  setBlackboardService as default
};
