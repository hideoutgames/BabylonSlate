import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Sequence","description":"","frontmatter":{"node":"bt.composite.sequence"},"headers":[],"relativePath":"scripting/behaviour-tree/sequence.md","filePath":"scripting/behaviour-tree/sequence.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/sequence.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="sequence" tabindex="-1">Sequence <a class="header-anchor" href="#sequence" aria-label="Permalink to &quot;Sequence&quot;">​</a></h1><p>Runs its children from left to right until one fails.</p><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>It succeeds only if every child succeeds, and fails as soon as one child fails.</li><li>Use it for steps that must happen in order.</li><li>A Sequence with no children succeeds.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/sequence.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const sequence = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  sequence as default
};
