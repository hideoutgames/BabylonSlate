import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Save Game","description":"","frontmatter":{},"headers":[],"relativePath":"components/save-game.md","filePath":"components/save-game.md"}');
const _sfc_main = { name: "components/save-game.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="save-game" tabindex="-1">Save Game <a class="header-anchor" href="#save-game" aria-label="Permalink to &quot;Save Game&quot;">​</a></h1><p>Chooses which parts of an actor a Save Game checkpoint stores and restores.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; General &gt; Save Game</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Save Transform</td><td>Saves and restores the actor&#39;s position, rotation and scale. Default on.</td></tr><tr><td>Persist Destruction</td><td>Keeps the actor destroyed when a later checkpoint loads. Default on.</td></tr><tr><td>Save (variable)</td><td>One checkbox for each script variable on the actor&#39;s Class, including inherited variables. Default off.</td></tr><tr><td>Save (component) (variable)</td><td>One checkbox for each script variable on the actor&#39;s other components. Default off.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>World scenes only.</li><li>Nothing is saved until a script saves the game. Each save records the selection as it is at that moment.</li><li>Actors you spawn in a script are saved only after you register them with <a href="./../scripting/class/register-save-actor">Register Save Actor</a>.</li><li>Actors in streamed scenes and in Scene Layers are not saved. Store progress that spans scenes in the <a href="./../assets/save-game">Save Game</a> asset&#39;s fields.</li><li>A save can only be loaded into the scene it was made in.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../scripting/save-games">Save games</a></li><li><a href="./../scripting/class/save-game">Save Game</a></li><li><a href="./../scripting/class/load-game">Load Game</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/save-game.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const saveGame = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  saveGame as default
};
