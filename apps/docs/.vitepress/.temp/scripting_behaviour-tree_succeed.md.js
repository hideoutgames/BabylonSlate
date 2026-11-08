import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Succeed","description":"","frontmatter":{"node":"bt.task.succeed"},"headers":[],"relativePath":"scripting/behaviour-tree/succeed.md","filePath":"scripting/behaviour-tree/succeed.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/succeed.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="succeed" tabindex="-1">Succeed <a class="header-anchor" href="#succeed" aria-label="Permalink to &quot;Succeed&quot;">​</a></h1><p>Finishes immediately and reports success to its parent.</p><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Use it as a placeholder while you build a tree, or to make a branch always succeed.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/succeed.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const succeed = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  succeed as default
};
