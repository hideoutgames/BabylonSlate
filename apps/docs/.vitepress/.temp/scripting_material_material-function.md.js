import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Material Function","description":"","frontmatter":{"node":"function.call"},"headers":[],"relativePath":"scripting/material/material-function.md","filePath":"scripting/material/material-function.md"}');
const _sfc_main = { name: "scripting/material/material-function.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="material-function" tabindex="-1">Material Function <a class="header-anchor" href="#material-function" aria-label="Permalink to &quot;Material Function&quot;">​</a></h1><p>Runs a Material Function, with pins that match the function&#39;s inputs and outputs.</p><div class="dark haptic-graph haptic-node-preview" inert aria-hidden="true"><div><div class="relative"><div data-node-role="function" class="overflow-hidden border border-border bg-graph-node text-card-foreground shadow-sm w-max min-w-80 rounded-lg"><div class="group/title relative rounded-t-lg px-4 py-2.5 text-base font-semibold leading-snug whitespace-nowrap text-node-title bg-node-function">Material Function</div><div class="flex flex-col py-1"></div></div></div></div></div><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Material Function</td><td>The Material Function asset to call.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Choose the function in the <strong>Inspector</strong>. Changing it removes the node&#39;s existing connections.</li><li>A function can call other functions, but not itself, directly or in a loop.</li><li>Every node inside the function must be allowed in the domain of the material that calls it.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/material/material-function.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const materialFunction = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  materialFunction as default
};
