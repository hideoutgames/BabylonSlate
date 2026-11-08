import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Selector","description":"","frontmatter":{"node":"bt.composite.selector"},"headers":[],"relativePath":"scripting/behaviour-tree/selector.md","filePath":"scripting/behaviour-tree/selector.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/selector.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="selector" tabindex="-1">Selector <a class="header-anchor" href="#selector" aria-label="Permalink to &quot;Selector&quot;">​</a></h1><p>Runs its children from left to right until one succeeds.</p><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>It succeeds as soon as a child succeeds, and fails if every child fails.</li><li>Use it to try options in priority order, with the preferred option on the left.</li><li>A Selector with no children fails.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/selector.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const selector = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  selector as default
};
