import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Wait","description":"","frontmatter":{"node":"bt.task.wait"},"headers":[],"relativePath":"scripting/behaviour-tree/wait.md","filePath":"scripting/behaviour-tree/wait.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/wait.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="wait" tabindex="-1">Wait <a class="header-anchor" href="#wait" aria-label="Permalink to &quot;Wait&quot;">​</a></h1><p>Waits for a set time, then succeeds.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Default</th><th>Description</th></tr></thead><tbody><tr><td>Duration MS</td><td>1000</td><td>How long to wait, in milliseconds.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>The task stays running until the time has passed, and the timer restarts each time the task starts.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/wait.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const wait = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  wait as default
};
