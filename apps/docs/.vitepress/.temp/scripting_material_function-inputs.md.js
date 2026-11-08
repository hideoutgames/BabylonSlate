import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Function Inputs","description":"","frontmatter":{"node":"function.input"},"headers":[],"relativePath":"scripting/material/function-inputs.md","filePath":"scripting/material/function-inputs.md"}');
const _sfc_main = { name: "scripting/material/function-inputs.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="function-inputs" tabindex="-1">Function Inputs <a class="header-anchor" href="#function-inputs" aria-label="Permalink to &quot;Function Inputs&quot;">​</a></h1><p>Provides the values passed into a Material Function, with one output pin per declared input.</p><div class="dark haptic-graph haptic-node-preview" inert aria-hidden="true"><div><div class="relative"><div data-node-role="function" class="overflow-hidden border border-border bg-graph-node text-card-foreground shadow-sm w-max min-w-80 rounded-lg"><div class="group/title relative rounded-t-lg px-4 py-2.5 text-base font-semibold leading-snug whitespace-nowrap text-node-title bg-node-function">Function Inputs</div><div class="flex flex-col py-1"></div></div></div></div></div><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Appears only inside Material Function graphs, where it is created for you.</li><li>Add, rename and retype inputs in the <strong>Interface</strong> panel.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/material/function-inputs.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const functionInputs = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  functionInputs as default
};
