import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Material Function","description":"","frontmatter":{},"headers":[],"relativePath":"assets/material-function.md","filePath":"assets/material-function.md"}');
const _sfc_main = { name: "assets/material-function.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="material-function" tabindex="-1">Material Function <a class="header-anchor" href="#material-function" aria-label="Permalink to &quot;Material Function&quot;">​</a></h1><p>A reusable shader subgraph for Materials.</p><h2 id="create" tabindex="-1">Create <a class="header-anchor" href="#create" aria-label="Permalink to &quot;Create&quot;">​</a></h2><p>In the <strong>Content Browser</strong>, choose <strong>New Asset &gt; Rendering &gt; Material Function</strong>.</p><h2 id="editor" tabindex="-1">Editor <a class="header-anchor" href="#editor" aria-label="Permalink to &quot;Editor&quot;">​</a></h2><p>Double-tap a Material Function to open it.</p><ul><li><strong>Graph</strong>: the subgraph. Start and end it with <a href="./../scripting/material/function-inputs">Function Inputs</a> and <a href="./../scripting/material/function-outputs">Function Outputs</a>.</li><li><strong>Interface</strong>: the function&#39;s pins. Under <strong>Inputs</strong> and <strong>Outputs</strong>, add pins, name them and choose their types. Select an input to set its <strong>Default Value</strong>.</li><li><strong>Inspector</strong>: the function&#39;s settings, or the selected node&#39;s properties.</li><li><strong>Compiler Results</strong>: problems with the graph.</li></ul><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Description</td><td>A short note about what the function does.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Call the function from a Material with a <a href="./../scripting/material/material-function">Material Function</a> node.</li><li>Renaming a pin does not break the Materials that already call the function.</li><li>Parameters inside a function are internal. To change a value from outside, expose it as a function input.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/materials">Materials</a></li><li><a href="./material">Material</a></li><li><a href="./../scripting/material/">Material nodes</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("assets/material-function.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const materialFunction = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  materialFunction as default
};
