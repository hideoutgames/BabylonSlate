import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Loop","description":"","frontmatter":{"node":"bt.decorator.loop"},"headers":[],"relativePath":"scripting/behaviour-tree/loop.md","filePath":"scripting/behaviour-tree/loop.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/loop.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="loop" tabindex="-1">Loop <a class="header-anchor" href="#loop" aria-label="Permalink to &quot;Loop&quot;">​</a></h1><p>Repeats the node it is attached to.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Default</th><th>Description</th></tr></thead><tbody><tr><td>Num Loops</td><td>0</td><td>How many times the node runs in total. 0 repeats forever.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>It repeats whether the node succeeds or fails.</li><li>With <strong>Num Loops</strong> at 0 the node repeats forever, so the tree stays on it until something aborts it.</li><li>Each repeat of a node that waits takes at least one frame.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/loop.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const loop = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  loop as default
};
