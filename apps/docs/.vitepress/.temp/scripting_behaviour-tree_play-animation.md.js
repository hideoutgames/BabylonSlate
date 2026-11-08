import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Play Animation","description":"","frontmatter":{"node":"bt.task.playAnimation"},"headers":[],"relativePath":"scripting/behaviour-tree/play-animation.md","filePath":"scripting/behaviour-tree/play-animation.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/play-animation.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="play-animation" tabindex="-1">Play Animation <a class="header-anchor" href="#play-animation" aria-label="Permalink to &quot;Play Animation&quot;">​</a></h1><p>Plays an Animation or Sprite Animation asset once, then succeeds.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Default</th><th>Description</th></tr></thead><tbody><tr><td>Clip Kind</td><td>animation</td><td>Whether to play an Animation or a Sprite Animation. Changing it clears <strong>Clip Asset</strong>.</td></tr><tr><td>Clip Asset</td><td></td><td>The clip to play. The list shows assets that match the <strong>Clip Kind</strong>.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>The task stays running for the length of the clip, and replaces the actor&#39;s Animation Graph output while it runs.</li><li>It fails if no clip is chosen or the asset is missing.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/play-animation.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const playAnimation = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  playAnimation as default
};
