import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Audio Channel","description":"","frontmatter":{},"headers":[],"relativePath":"assets/audio-channel.md","filePath":"assets/audio-channel.md"}');
const _sfc_main = { name: "assets/audio-channel.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="audio-channel" tabindex="-1">Audio Channel <a class="header-anchor" href="#audio-channel" aria-label="Permalink to &quot;Audio Channel&quot;">​</a></h1><p>A group that sounds play through, such as Music, Effects or Voice, with optional reverb and wall muffling.</p><h2 id="create" tabindex="-1">Create <a class="header-anchor" href="#create" aria-label="Permalink to &quot;Create&quot;">​</a></h2><p>In the <strong>Content Browser</strong>, choose <strong>New Asset &gt; Audio &gt; Audio Channel</strong>. To use it, set <strong>Routing &gt; Audio Channel</strong> on an <a href="./audio">Audio</a> asset. To control its volume, list it on an <a href="./audio-mixer">Audio Mixer</a>.</p><h2 id="editor" tabindex="-1">Editor <a class="header-anchor" href="#editor" aria-label="Permalink to &quot;Editor&quot;">​</a></h2><p>Double-tap the asset to open it. The window has an <strong>Inspector</strong> only.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Parent Channel</td><td>Another channel this one sits under. A channel&#39;s volume is multiplied by its parents&#39; volumes. None by default.</td></tr><tr><td>Environment Reverb</td><td>Gives the channel&#39;s sounds the echo of the space around the listener. Off by default.</td></tr><tr><td>Muffle Through Walls</td><td>Muffles 3D sounds when static geometry lies between the sound and the listener. Off by default.</td></tr></tbody></table><p>A channel has no volume of its own. Set it on the mixer.</p><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../audio/mixing">Mixing</a></li><li><a href="./audio-mixer">Audio Mixer</a></li><li><a href="./sound-attenuation">Sound Attenuation</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("assets/audio-channel.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const audioChannel = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  audioChannel as default
};
