import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Sound Attenuation","description":"","frontmatter":{},"headers":[],"relativePath":"assets/sound-attenuation.md","filePath":"assets/sound-attenuation.md"}');
const _sfc_main = { name: "assets/sound-attenuation.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="sound-attenuation" tabindex="-1">Sound Attenuation <a class="header-anchor" href="#sound-attenuation" aria-label="Permalink to &quot;Sound Attenuation&quot;">​</a></h1><p>How a sound fades with distance from the listener. Giving an Audio asset a Sound Attenuation makes it 3D.</p><h2 id="create" tabindex="-1">Create <a class="header-anchor" href="#create" aria-label="Permalink to &quot;Create&quot;">​</a></h2><p>In the <strong>Content Browser</strong>, choose <strong>New Asset &gt; Audio &gt; Sound Attenuation</strong>. Then set <strong>Routing &gt; Sound Attenuation</strong> on an <a href="./audio">Audio</a> asset. One attenuation can serve many sounds.</p><h2 id="editor" tabindex="-1">Editor <a class="header-anchor" href="#editor" aria-label="Permalink to &quot;Editor&quot;">​</a></h2><p>Double-tap the asset to open it. The window has an <strong>Inspector</strong> only. A plot at the top shows how volume falls with distance.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Inner Radius</td><td>Within this distance the sound plays at full volume. Default 10.</td></tr><tr><td>Max Radius</td><td>Beyond this distance the sound is silent. Default 250.</td></tr><tr><td>Distance Model</td><td><strong>Linear</strong> (default), <strong>Inverse</strong> or <strong>Exponential</strong>.</td></tr><tr><td>Rolloff</td><td>How steeply volume falls with Inverse and Exponential. Default 1.</td></tr><tr><td>Spatialisation</td><td><strong>Equal Power</strong> (default) or <strong>HRTF</strong>, which works best on headphones.</td></tr><tr><td>Cone</td><td>Makes the sound directional. Off by default.</td></tr><tr><td>Inner Angle, Outer Angle, Outer Gain</td><td>Cone only. Defaults 90, 120 and 0.</td></tr><tr><td>Doppler</td><td>Shifts pitch as the sound moves towards or away from the listener. Off by default.</td></tr><tr><td>Doppler Factor</td><td>Doppler only. Strength of the effect. Default 1.</td></tr></tbody></table><p>Distances are in world units.</p><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../audio/spatial-audio">Spatial Audio</a></li><li><a href="./../components/audio">Audio component</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("assets/sound-attenuation.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const soundAttenuation = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  soundAttenuation as default
};
