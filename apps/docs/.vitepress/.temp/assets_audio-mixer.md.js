import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Audio Mixer","description":"","frontmatter":{},"headers":[],"relativePath":"assets/audio-mixer.md","filePath":"assets/audio-mixer.md"}');
const _sfc_main = { name: "assets/audio-mixer.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="audio-mixer" tabindex="-1">Audio Mixer <a class="header-anchor" href="#audio-mixer" aria-label="Permalink to &quot;Audio Mixer&quot;">​</a></h1><p>Sets a global volume and a default volume for each Audio Channel in the project.</p><h2 id="create" tabindex="-1">Create <a class="header-anchor" href="#create" aria-label="Permalink to &quot;Create&quot;">​</a></h2><p>In the <strong>Content Browser</strong>, choose <strong>New Asset &gt; Audio &gt; Audio Mixer</strong>. Then choose it in <strong>Project Settings &gt; Audio &gt; Audio Mixer</strong>. A project uses one mixer.</p><h2 id="editor" tabindex="-1">Editor <a class="header-anchor" href="#editor" aria-label="Permalink to &quot;Editor&quot;">​</a></h2><p>Double-tap the asset to open it. The window has an <strong>Inspector</strong> only.</p><ul><li>Set <strong>Global Volume</strong>.</li><li>Tap <strong>Add Channel</strong> and pick an <a href="./audio-channel">Audio Channel</a>. Set that channel&#39;s <strong>Volume</strong>.</li><li>A channel can be listed once. A duplicate entry is reported as invalid.</li></ul><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Global Volume</td><td>Level from 0 to 1 applied to every sound. Default 1.</td></tr><tr><td>Channel 1, Channel 2...</td><td>The channels listed on the mixer. Pick another asset to replace one, or choose None to remove it.</td></tr><tr><td>Volume</td><td>The level for that channel, from 0 to 1.</td></tr></tbody></table><p>With no channels listed, <strong>Global Volume</strong> still applies.</p><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../audio/mixing">Mixing</a></li><li><a href="./../scripting/class/set-channel-volume">Set Channel Volume</a></li><li><a href="./../scripting/class/set-global-volume">Set Global Volume</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("assets/audio-mixer.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const audioMixer = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  audioMixer as default
};
