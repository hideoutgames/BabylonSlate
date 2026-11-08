import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Skeleton","description":"","frontmatter":{},"headers":[],"relativePath":"assets/skeleton.md","filePath":"assets/skeleton.md"}');
const _sfc_main = { name: "assets/skeleton.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="skeleton" tabindex="-1">Skeleton <a class="header-anchor" href="#skeleton" aria-label="Permalink to &quot;Skeleton&quot;">​</a></h1><p>The bones of an imported model. Animations from the same file play on it.</p><h2 id="import" tabindex="-1">Import <a class="header-anchor" href="#import" aria-label="Permalink to &quot;Import&quot;">​</a></h2><p>Skeletons are not created from <strong>New Asset</strong>. Importing a rigged GLB or glTF model creates one, either from the model&#39;s skin or, when the model is built from parented mesh parts, from that hierarchy. See <a href="./../editor/importing">Importing Assets</a>.</p><h2 id="editor" tabindex="-1">Editor <a class="header-anchor" href="#editor" aria-label="Permalink to &quot;Editor&quot;">​</a></h2><p>Double-tap the asset to open it. The window has <strong>Preview</strong> and an <strong>Inspector</strong>. Both are read-only.</p><ul><li><strong>Preview</strong> shows the owning model. If it cannot load the mesh, it shows <strong>No Mesh</strong>; open the <a href="./model">Model</a> instead.</li><li>The <strong>Inspector</strong> lists the skeleton&#39;s bones.</li></ul><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Kind</td><td><strong>Skin</strong> for a rigged model, or <strong>Hierarchy</strong> for parented mesh parts.</td></tr><tr><td>Model</td><td>The Model the skeleton belongs to.</td></tr></tbody></table><p>The bone list is below these two rows.</p><h2 id="use-it" tabindex="-1">Use it <a class="header-anchor" href="#use-it" aria-label="Permalink to &quot;Use it&quot;">​</a></h2><ul><li>To reuse <a href="./animation">Animation</a> clips on another character, select the clips in the <strong>Content Browser</strong>, choose <strong>Retarget…</strong> and pick the target Skeleton.</li><li>To attach an actor to a bone, use <a href="./../scripting/class/attach-to-bone">Attach To Bone</a>.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/models">Models</a></li><li><a href="./animation-graph">Animation Graph</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("assets/skeleton.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const skeleton = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  skeleton as default
};
