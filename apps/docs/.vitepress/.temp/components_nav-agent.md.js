import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Nav Agent","description":"","frontmatter":{},"headers":[],"relativePath":"components/nav-agent.md","filePath":"components/nav-agent.md"}');
const _sfc_main = { name: "components/nav-agent.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="nav-agent" tabindex="-1">Nav Agent <a class="header-anchor" href="#nav-agent" aria-label="Permalink to &quot;Nav Agent&quot;">​</a></h1><p>Lets an actor find and follow paths across the baked NavMesh.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; AI &gt; Nav Agent</strong>. The scene needs a baked <a href="./nav-mesh">NavMesh</a>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Radius</td><td>Agent radius in world units. Minimum 0.05. Default 0.5.</td></tr><tr><td>Height</td><td>Agent height in world units. Minimum 0.1. Default 2.</td></tr><tr><td>Max Speed</td><td>Top walking speed, in units per second. Default 3.5.</td></tr><tr><td>Max Acceleration</td><td>How quickly it reaches that speed. Default 8.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Works in world scenes and in Scene Layers.</li><li>Give it a destination with <a href="./../scripting/class/move-to">Move To</a> and stop it with <a href="./../scripting/class/stop-movement">Stop Movement</a>. A <a href="./behaviour-tree">Behaviour Tree</a> can do the same with its Move To tasks.</li><li>The agent faces the direction it moves.</li><li>A scene supports up to 128 agents at once.</li><li>An actor with a Dynamic <a href="./rigid-body">Rigid Body</a> in a 3D scene stays under physics. Navigation steers it along the ground and gravity still applies.</li><li>Do not combine it with <a href="./movement">Movement</a> on one actor.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../ai/navigation">Navigation</a></li><li><a href="./../scripting/class/find-path-to">Find Path To</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/nav-agent.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const navAgent = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  navAgent as default
};
