import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Parallel","description":"","frontmatter":{"node":"bt.composite.parallel"},"headers":[],"relativePath":"scripting/behaviour-tree/parallel.md","filePath":"scripting/behaviour-tree/parallel.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/parallel.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="parallel" tabindex="-1">Parallel <a class="header-anchor" href="#parallel" aria-label="Permalink to &quot;Parallel&quot;">​</a></h1><p>Runs all of its children at the same time.</p><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>It stays running until every child has succeeded, then succeeds.</li><li>It fails as soon as any child fails, and stops the children that are still running.</li><li>A Parallel needs at least two children.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/parallel.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const parallel = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  parallel as default
};
