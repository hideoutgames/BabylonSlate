import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Render Target","description":"","frontmatter":{},"headers":[],"relativePath":"assets/render-target.md","filePath":"assets/render-target.md"}');
const _sfc_main = { name: "assets/render-target.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="render-target" tabindex="-1">Render Target <a class="header-anchor" href="#render-target" aria-label="Permalink to &quot;Render Target&quot;">​</a></h1><p>The image a scene capture renders into: what it records and how many pixels it has.</p><h2 id="create" tabindex="-1">Create <a class="header-anchor" href="#create" aria-label="Permalink to &quot;Create&quot;">​</a></h2><p>In the <strong>Content Browser</strong>, choose <strong>New Asset &gt; Rendering &gt; Render Target</strong>. Then pick it in the <strong>Render Target</strong> field of a <a href="./../components/render-target-capture">Render Target Capture</a> component. To show the result on a mesh, add a <a href="./render-target-texture">Render Target Texture</a> for it.</p><h2 id="editor" tabindex="-1">Editor <a class="header-anchor" href="#editor" aria-label="Permalink to &quot;Editor&quot;">​</a></h2><p>Double-tap the asset to open it. The window has an <strong>Inspector</strong> only.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Render Mode</td><td><strong>Scene Color</strong> (default) captures the lit scene. <strong>Depth Pass</strong> stores distance from the capture, from near (0) to far (1). <strong>World Normal</strong> stores surface directions.</td></tr><tr><td>Width, Height</td><td>Size in pixels, from 1 to 4096. Default 512 by 512.</td></tr></tbody></table><p>Depth Pass and World Normal skip scene lighting and post-processing.</p><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Large or many Render Targets use GPU memory. Keep sizes as small as the effect allows.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/render-targets">Render Targets</a></li><li><a href="./../components/render-target-capture">Render Target Capture</a></li><li><a href="./render-target-texture">Render Target Texture</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("assets/render-target.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const renderTarget = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  renderTarget as default
};
