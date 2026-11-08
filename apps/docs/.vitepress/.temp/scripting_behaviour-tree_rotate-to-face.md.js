import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Rotate To Face","description":"","frontmatter":{"node":"bt.task.rotateToFace"},"headers":[],"relativePath":"scripting/behaviour-tree/rotate-to-face.md","filePath":"scripting/behaviour-tree/rotate-to-face.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/rotate-to-face.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="rotate-to-face" tabindex="-1">Rotate To Face <a class="header-anchor" href="#rotate-to-face" aria-label="Permalink to &quot;Rotate To Face&quot;">​</a></h1><p>Turns the actor to face a world position.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Target</td><td>The world position to face.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Only the heading changes: rotation around Y in 3D scenes and around Z in 2D scenes.</li><li>The turn happens at once and the task succeeds immediately. It fails if <strong>Target</strong> is not a valid position.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/rotate-to-face.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const rotateToFace = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  rotateToFace as default
};
