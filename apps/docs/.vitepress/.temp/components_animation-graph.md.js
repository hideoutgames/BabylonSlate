import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Animation Graph","description":"","frontmatter":{},"headers":[],"relativePath":"components/animation-graph.md","filePath":"components/animation-graph.md"}');
const _sfc_main = { name: "components/animation-graph.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="animation-graph" tabindex="-1">Animation Graph <a class="header-anchor" href="#animation-graph" aria-label="Permalink to &quot;Animation Graph&quot;">​</a></h1><p>Plays an Animation Graph on an actor: a state machine that drives Model animations and Sprite Animations.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; Animation &gt; Animation Graph</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Animation Graph</td><td>The <a href="./../assets/animation-graph">Animation Graph</a> to run.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Works in world scenes and in Scene Layers.</li><li>The actor needs something to animate: a <a href="./mesh">Mesh</a> that uses a Model with animation clips, or a <a href="./sprite">Sprite</a> for Sprite Animations.</li><li>An actor can have several Animation Graph components. If two play at once, the last one in the component list wins.</li><li>Scripts reach a graph through the component. <a href="./../scripting/class/set-anim-graph-variable">Set Anim Graph Variable</a>, <a href="./../scripting/class/get-anim-graph-variable">Get Anim Graph Variable</a>, <a href="./../scripting/class/get-current-state">Get Current State</a> and <a href="./../scripting/class/jump-to-state">Jump To State</a> take this component as their target. An unconnected target does nothing.</li><li>A jump takes effect on the next animation update.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/models">Models</a></li><li><a href="./../2d/sprites">Sprites</a></li><li><a href="./../assets/animation-graph">Animation Graph</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/animation-graph.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const animationGraph = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  animationGraph as default
};
