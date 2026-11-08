import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"NavMesh Blocker","description":"","frontmatter":{},"headers":[],"relativePath":"components/nav-mesh-blocker.md","filePath":"components/nav-mesh-blocker.md"}');
const _sfc_main = { name: "components/nav-mesh-blocker.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="navmesh-blocker" tabindex="-1">NavMesh Blocker <a class="header-anchor" href="#navmesh-blocker" aria-label="Permalink to &quot;NavMesh Blocker&quot;">​</a></h1><p>A box or cylinder that blocks navigation or makes it more costly. It is not a physical collider.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Choose <strong>Place Actors &gt; Navigation &gt; NavMesh Blocker</strong>. It is not in the <strong>Add Component</strong> menu. The Inspector lists it as Nav Mesh Blocker Component.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Dynamic</td><td>Applies the blocker at runtime, so it can move or be destroyed in Play. Default off.</td></tr><tr><td>Kind</td><td><strong>Box</strong> or <strong>Cylinder</strong>. Default Box.</td></tr><tr><td>Area</td><td><strong>Unwalkable</strong> removes the area from navigation. <strong>Cost</strong> keeps it walkable but makes crossing it more expensive. Default Unwalkable.</td></tr><tr><td>Cost</td><td>How much more expensive the area is to cross. Shown when Area is Cost. Above 1. Default 10.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Works in world scenes and in Scene Layers.</li><li>The actor&#39;s scale sets the size of the volume. A cylinder&#39;s X and Z scale are its diameters.</li><li>A static Unwalkable blocker is baked into the <a href="./nav-mesh">NavMesh</a>, so bake again after you change it.</li><li>A Dynamic Unwalkable blocker cuts the mesh in Play. It needs a NavMesh baked with <strong>Support Dynamic Obstacles</strong>.</li><li>A Cost blocker applies in Play. Agents choose cheaper routes around it when they can.</li><li>Scripts can read <strong>Dynamic</strong> and read or set <strong>Kind</strong>, <strong>Area</strong> and <strong>Cost</strong>. A change applies in Play to a Dynamic blocker; a static one keeps what was baked.</li><li>The editor draws it as an amber dotted volume.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../ai/navigation">Navigation</a></li><li><a href="./blocking-volume">Blocking Volume</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/nav-mesh-blocker.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const navMeshBlocker = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  navMeshBlocker as default
};
