import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Script Interface","description":"","frontmatter":{},"headers":[],"relativePath":"assets/script-interface.md","filePath":"assets/script-interface.md"}');
const _sfc_main = { name: "assets/script-interface.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="script-interface" tabindex="-1">Script Interface <a class="header-anchor" href="#script-interface" aria-label="Permalink to &quot;Script Interface&quot;">​</a></h1><p>A list of methods that any <a href="./../scripting/classes">Class</a> can implement, so one call works on different kinds of objects.</p><h2 id="create" tabindex="-1">Create <a class="header-anchor" href="#create" aria-label="Permalink to &quot;Create&quot;">​</a></h2><p>In the <strong>Content Browser</strong>, choose <strong>New Asset &gt; Scripting &gt; Script Interface</strong>.</p><h2 id="editor" tabindex="-1">Editor <a class="header-anchor" href="#editor" aria-label="Permalink to &quot;Editor&quot;">​</a></h2><p>Double-tap the asset to open it. The window has <strong>Methods</strong>, <strong>Preview</strong> and <strong>Inspector</strong>.</p><ul><li><strong>Methods</strong> lists the methods. Tap <strong>Add method</strong> (<strong>+</strong>) to add one, named NewMethod. Select a method and tap <strong>Remove method</strong> to delete it.</li><li><strong>Preview</strong> shows the selected method as a function node, with its inputs and outputs.</li><li>The <strong>Inspector</strong> edits the selected method. Tap a pin in <strong>Preview</strong> to select it in the pin list.</li></ul><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Name</td><td>The method&#39;s name.</td></tr><tr><td>Pins</td><td>The method&#39;s inputs and outputs. Choose <strong>Add Input</strong> or <strong>Add Output</strong>, then set each pin&#39;s name and type.</td></tr></tbody></table><p>An interface has no logic. Each class that implements it builds the method&#39;s graph.</p><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../scripting/interfaces">Script Interfaces</a>: implement an interface in a class and call its methods.</li><li><a href="./../scripting/class/call-interface-function">Call Interface Function</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("assets/script-interface.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const scriptInterface = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  scriptInterface as default
};
