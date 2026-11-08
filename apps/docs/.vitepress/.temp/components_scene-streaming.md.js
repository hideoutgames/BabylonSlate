import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Scene Streaming","description":"","frontmatter":{},"headers":[],"relativePath":"components/scene-streaming.md","filePath":"components/scene-streaming.md"}');
const _sfc_main = { name: "components/scene-streaming.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="scene-streaming" tabindex="-1">Scene Streaming <a class="header-anchor" href="#scene-streaming" aria-label="Permalink to &quot;Scene Streaming&quot;">​</a></h1><p>Marks where another Scene loads into the running game, so you can stream parts of a level in and out.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Choose <strong>Place Actors &gt; Environment &gt; Scene Streaming</strong>. It is not in the <strong>Add Component</strong> menu.</p><p>The new actor holds a Scene Streaming component and a 3D Text label that shows the target Scene&#39;s name. The label appears only in the editor.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Target Scene</td><td>The Scene to stream. Pick a Scene asset.</td></tr><tr><td>Transform</td><td>Position, rotation and scale of the streamed Scene&#39;s origin, relative to the actor.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>World scenes only.</li><li>Nothing loads by itself. Use <a href="./../scripting/class/load-scene-async">Load Scene Async</a> or <a href="./../scripting/class/load-scene-blocking">Load Scene Blocking</a> with the streaming actor as the target, and the matching unload nodes to remove it.</li><li>The streamed Scene must use the same Physics World (3D or 2D) as the Scene that loads it.</li><li>The editor never shows the streamed Scene&#39;s actors. They appear only in Play.</li><li>Renaming the target Scene updates the label.</li><li>Scripts can read and set <strong>Target Scene</strong>. A load that already started keeps its Scene; the next Load Scene node streams the new one.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../scenes/streaming">Scene streaming</a></li><li><a href="./../scripting/class/is-scene-loaded">Is Scene Loaded</a></li><li><a href="./../scripting/class/get-scene-state">Get Scene State</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/scene-streaming.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const sceneStreaming = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  sceneStreaming as default
};
