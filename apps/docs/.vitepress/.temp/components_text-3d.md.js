import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"3D Text","description":"","frontmatter":{},"headers":[],"relativePath":"components/text-3d.md","filePath":"components/text-3d.md"}');
const _sfc_main = { name: "components/text-3d.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="3d-text" tabindex="-1">3D Text <a class="header-anchor" href="#3d-text" aria-label="Permalink to &quot;3D Text&quot;">​</a></h1><p>Flat, unlit text drawn in the world.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; Rendering &gt; 3D Text</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Environment &gt; 3D Text</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Size</td><td>Text size in world units, 0.01 to 100. Default 1.</td></tr><tr><td>Color</td><td>The text colour. Default white.</td></tr><tr><td>Alignment</td><td><strong>Left</strong>, <strong>Center</strong> or <strong>Right</strong>. Default Left.</td></tr><tr><td>Font</td><td>A <a href="./../assets/font">Font</a> asset. Empty uses a built-in typeface.</td></tr><tr><td>Text</td><td>The text, which can run over several lines. Default &quot;Text&quot;.</td></tr><tr><td>Cast Shadows</td><td>Whether it casts a shadow in a lit world scene. Default off, because it is unlit.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Works in world scenes and in Scene Layers.</li><li>Lights and shadows do not affect the text, and it casts no shadow unless you turn on <strong>Cast Shadows</strong>.</li><li>Each new line sits above the previous one. The actor&#39;s origin stays at the bottom of the block.</li><li>Without a Font, or with a Font that has no 3D typeface data, the text uses a built-in typeface with basic ASCII characters. The Inspector then shows <strong>Typeface</strong>.</li><li>Change the text from a script with the component&#39;s <strong>Set Text</strong> function.</li><li>For text in HUDs and menus, use <a href="./2d-text">2D Text</a> in a Scene Layer.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/geometry">Geometry</a></li><li><a href="./../assets/font">Font</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/text-3d.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const text3d = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  text3d as default
};
