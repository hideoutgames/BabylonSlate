import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Move To Blackboard Key","description":"","frontmatter":{"node":"bt.task.moveToBlackboardKey"},"headers":[],"relativePath":"scripting/behaviour-tree/move-to-blackboard-key.md","filePath":"scripting/behaviour-tree/move-to-blackboard-key.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/move-to-blackboard-key.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="move-to-blackboard-key" tabindex="-1">Move To Blackboard Key <a class="header-anchor" href="#move-to-blackboard-key" aria-label="Permalink to &quot;Move To Blackboard Key&quot;">​</a></h1><p>Moves the actor to the position stored in a Blackboard key.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Default</th><th>Description</th></tr></thead><tbody><tr><td>Blackboard Key</td><td></td><td>The key that holds the target. The list shows only Vector 2, Vector 3, Object Reference and Actor Reference keys.</td></tr><tr><td>Accept Radius</td><td>0.5</td><td>How close to the target, in metres, the actor must get to count as arrived. The default is 0.5.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>The key can hold a Vector 2, Vector 3, Object Reference or Actor Reference.</li><li>The key is read on every update, so the route follows a moving target, and the task fails if the key is empty or the target is gone.</li><li>It needs a baked NavMesh and a <strong>Nav Agent</strong> component, like <a href="./move-to"><strong>Move To</strong></a>.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/move-to-blackboard-key.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const moveToBlackboardKey = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  moveToBlackboardKey as default
};
