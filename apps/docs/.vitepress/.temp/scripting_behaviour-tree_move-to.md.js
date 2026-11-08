import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Move To","description":"","frontmatter":{"node":"bt.task.moveTo"},"headers":[],"relativePath":"scripting/behaviour-tree/move-to.md","filePath":"scripting/behaviour-tree/move-to.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/move-to.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="move-to" tabindex="-1">Move To <a class="header-anchor" href="#move-to" aria-label="Permalink to &quot;Move To&quot;">​</a></h1><p>Moves the actor to a world position along the navigation mesh.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Default</th><th>Description</th></tr></thead><tbody><tr><td>Destination</td><td></td><td>The world position to move to.</td></tr><tr><td>Accept Radius</td><td>0.5</td><td>How close to the destination, in metres, the actor must get to count as arrived. The default is 0.5.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>The task stays running until the actor is within <strong>Accept Radius</strong> of the destination, then succeeds.</li><li>It needs a baked NavMesh in the scene and a <strong>Nav Agent</strong> component on the actor, otherwise it fails. The <strong>Output Log</strong> warns once for each actor and reason during a Play session.</li><li>If the tree aborts the task, the actor stops.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/move-to.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const moveTo = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  moveTo as default
};
