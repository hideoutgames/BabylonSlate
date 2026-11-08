import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Audio","description":"","frontmatter":{},"headers":[],"relativePath":"components/audio.md","filePath":"components/audio.md"}');
const _sfc_main = { name: "components/audio.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="audio" tabindex="-1">Audio <a class="header-anchor" href="#audio" aria-label="Permalink to &quot;Audio&quot;">​</a></h1><p>Plays an Audio asset from an actor, at the start of Play or when a script says so.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; Audio &gt; Audio</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Audio &gt; Audio</strong>. An Audio asset listed in <strong>Place Actors</strong> creates an actor that already has it assigned.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Audio</td><td>The <a href="./../assets/audio">Audio</a> asset to play. Play On Start needs one.</td></tr><tr><td>Play On Start</td><td>Starts the sound when Play begins. Default on.</td></tr><tr><td>Loop</td><td>Repeats the sound until it is stopped. Default off.</td></tr><tr><td>Volume</td><td>Level from 0 to 1, multiplied with the Audio asset&#39;s own volume. Default 1.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Works in world scenes and in Scene Layers.</li><li>The sound is spatial when the Audio asset uses a <a href="./../assets/sound-attenuation">Sound Attenuation</a> asset. It then plays from the actor&#39;s position, and a selected Audio component shows its inner and maximum radius in the viewport.</li><li>Sound starts only after the player has clicked or tapped the game view.</li><li>Scripts can use the component&#39;s <strong>Play</strong> and <strong>Stop</strong> functions and its <strong>Volume</strong> and <strong>Loop</strong> variables. <a href="./../scripting/class/event-on-audio-finished">Event On Audio Finished</a> runs when a sound that does not loop ends.</li><li>To play a sound without a component, use <a href="./../scripting/class/play-sound">Play Sound</a>.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../audio/">Audio</a></li><li><a href="./../audio/spatial-audio">Spatial audio</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/audio.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const audio = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  audio as default
};
