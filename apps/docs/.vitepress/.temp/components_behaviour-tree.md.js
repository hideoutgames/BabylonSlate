import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Behaviour Tree","description":"","frontmatter":{},"headers":[],"relativePath":"components/behaviour-tree.md","filePath":"components/behaviour-tree.md"}');
const _sfc_main = { name: "components/behaviour-tree.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="behaviour-tree" tabindex="-1">Behaviour Tree <a class="header-anchor" href="#behaviour-tree" aria-label="Permalink to &quot;Behaviour Tree&quot;">​</a></h1><p>Runs a Behaviour Tree on an actor to drive its AI.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; AI &gt; Behaviour Tree</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Behaviour Tree</td><td>The <a href="./../assets/behaviour-tree">Behaviour Tree</a> to run.</td></tr><tr><td>Blackboard</td><td>Optional. A <a href="./../assets/blackboard">Blackboard</a> to use instead of the one linked to the tree. Empty uses the tree&#39;s own.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Works in world scenes and in Scene Layers.</li><li>The tree starts when Play begins.</li><li>If you change the tree or the Blackboard during Play, the running tasks are aborted and the new tree starts from its root with fresh Blackboard defaults.</li><li>Tasks that move the actor, such as <a href="./../scripting/behaviour-tree/move-to">Move To</a>, need a <a href="./nav-agent">Nav Agent</a> on the actor and a baked <a href="./nav-mesh">NavMesh</a>.</li><li>Custom tasks, decorators and services read and write Blackboard values with <a href="./../scripting/class/get-blackboard">Get Blackboard</a> and <a href="./../scripting/class/set-blackboard">Set Blackboard</a>.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../ai/behaviour-trees">Behaviour trees</a></li><li><a href="./../scripting/behaviour-tree/">Behaviour Tree nodes</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/behaviour-tree.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const behaviourTree = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  behaviourTree as default
};
