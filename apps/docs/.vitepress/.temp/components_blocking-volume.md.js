import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Blocking Volume","description":"","frontmatter":{},"headers":[],"relativePath":"components/blocking-volume.md","filePath":"components/blocking-volume.md"}');
const _sfc_main = { name: "components/blocking-volume.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="blocking-volume" tabindex="-1">Blocking Volume <a class="header-anchor" href="#blocking-volume" aria-label="Permalink to &quot;Blocking Volume&quot;">​</a></h1><p>An invisible solid box that stops physics bodies, shaped by the actor&#39;s transform.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Choose <strong>Place Actors &gt; Physics &gt; Blocking Volume</strong>. It is not in the <strong>Add Component</strong> menu.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><p>A Blocking Volume has no settings of its own. Move, rotate and scale the actor to shape the box.</p><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Works in world scenes and in Scene Layers.</li><li>In the editor it appears as a blue dotted box. It is hidden in Play and exports.</li><li>It is solid without a Rigid Body or Collider, and it never moves. A <a href="./collider">Collider</a> on the same actor adds its shape to the volume&#39;s static body, for example an <strong>Is Trigger</strong> Collider that raises overlaps while the volume still blocks.</li><li>Navigation ignores it. To block paths, use a <a href="./nav-mesh-blocker">NavMesh Blocker</a>.</li><li>The Inspector lists it as Blocking Volume Component.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../physics/collision">Collision</a></li><li><a href="./collider">Collider</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/blocking-volume.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const blockingVolume = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  blockingVolume as default
};
