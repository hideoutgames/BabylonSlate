import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Play Sound","description":"","frontmatter":{"node":"bt.task.playSound"},"headers":[],"relativePath":"scripting/behaviour-tree/play-sound.md","filePath":"scripting/behaviour-tree/play-sound.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/play-sound.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="play-sound" tabindex="-1">Play Sound <a class="header-anchor" href="#play-sound" aria-label="Permalink to &quot;Play Sound&quot;">​</a></h1><p>Plays an Audio asset from the actor and succeeds.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Default</th><th>Description</th></tr></thead><tbody><tr><td>Audio</td><td></td><td>The Audio asset to play.</td></tr><tr><td>Volume</td><td>1</td><td>Playback volume from 0 (silent) to 1 (full).</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>The task succeeds as soon as playback starts, without waiting for the sound to finish.</li><li>It fails if no Audio asset is chosen or the asset is missing.</li><li>The Audio asset&#39;s own Loop setting applies.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/play-sound.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const playSound = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  playSound as default
};
