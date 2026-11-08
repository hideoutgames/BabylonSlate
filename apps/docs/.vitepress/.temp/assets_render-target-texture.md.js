import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Render Target Texture","description":"","frontmatter":{},"headers":[],"relativePath":"assets/render-target-texture.md","filePath":"assets/render-target-texture.md"}');
const _sfc_main = { name: "assets/render-target-texture.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="render-target-texture" tabindex="-1">Render Target Texture <a class="header-anchor" href="#render-target-texture" aria-label="Permalink to &quot;Render Target Texture&quot;">​</a></h1><p>A live Render Target that Materials can sample like a Texture, for security monitors, mirrors and minimaps.</p><h2 id="create" tabindex="-1">Create <a class="header-anchor" href="#create" aria-label="Permalink to &quot;Create&quot;">​</a></h2><p>In the <strong>Content Browser</strong>, choose <strong>New Asset &gt; Rendering &gt; Render Target Texture</strong>.</p><p>Or right-click a <a href="./render-target">Render Target</a> and choose <strong>Create Render Target Texture</strong> for one that already shows it. See <a href="./../editor/content-browser#create-from-assets">Create from assets</a>.</p><h2 id="editor" tabindex="-1">Editor <a class="header-anchor" href="#editor" aria-label="Permalink to &quot;Editor&quot;">​</a></h2><p>Double-tap the asset to open it. The window has an <strong>Inspector</strong> only.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Render Target</td><td>The <a href="./render-target">Render Target</a> whose output this texture shows. A <a href="./../components/render-target-capture">Render Target Capture</a> in the scene fills it.</td></tr></tbody></table><h2 id="use-it" tabindex="-1">Use it <a class="header-anchor" href="#use-it" aria-label="Permalink to &quot;Use it&quot;">​</a></h2><p>In a <a href="./material">Material</a>, sample the asset with a <a href="./../scripting/material/texture-sample">Texture Sample</a> or <a href="./../scripting/material/texture-parameter">Texture Parameter</a> node, then assign the Material to a mesh.</p><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>A Material preview shows a Render Target Texture as black, because the preview has no scene to capture.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/render-targets">Render Targets</a></li><li><a href="./../components/render-target-capture">Render Target Capture</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("assets/render-target-texture.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const renderTargetTexture = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  renderTargetTexture as default
};
