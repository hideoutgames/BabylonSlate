import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Skybox","description":"","frontmatter":{},"headers":[],"relativePath":"components/skybox.md","filePath":"components/skybox.md"}');
const _sfc_main = { name: "components/skybox.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="skybox" tabindex="-1">Skybox <a class="header-anchor" href="#skybox" aria-label="Permalink to &quot;Skybox&quot;">​</a></h1><p>A cubemap sky that surrounds the scene.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; Rendering &gt; Skybox</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Environment &gt; Skybox</strong>. New 3D scenes already contain a locked Skybox actor that shows the engine&#39;s default sky.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Size</td><td>Edge length of the sky cube, 1 to 10,000. Default 1000.</td></tr><tr><td>Positive X, Positive Y, Positive Z</td><td>The Texture for each positive cube face. Empty shows the default sky&#39;s face.</td></tr><tr><td>Negative X, Negative Y, Negative Z</td><td>The Texture for each negative cube face. Empty shows the default sky&#39;s face.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>World scenes only.</li><li>The Skybox follows its actor&#39;s position, rotation and scale. Rotate the actor to turn the sky.</li><li>It always draws behind the scene, even beyond the camera&#39;s Far Clip.</li><li>It cannot be picked in the viewport. Select it in the <strong>Outliner</strong>. The default Skybox is locked, so unlock it first.</li><li>It does not cast shadows or receive fog. When the scene&#39;s <strong>Environment Source</strong> is <strong>Skybox</strong> (the default in new 3D scenes), it also provides <a href="./../graphics/lighting#environment-lighting">environment lighting</a>.</li><li>To cut six face Textures from a single image, use <a href="./../assets/skybox-creator">Skybox Creator</a>.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/sky-and-fog">Sky and fog</a></li><li><a href="./../graphics/lighting#environment-lighting">Lighting</a></li><li><a href="./../assets/texture">Texture</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/skybox.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const skybox = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  skybox as default
};
