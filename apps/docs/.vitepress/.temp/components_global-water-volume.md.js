import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Global Water Volume","description":"","frontmatter":{},"headers":[],"relativePath":"components/global-water-volume.md","filePath":"components/global-water-volume.md"}');
const _sfc_main = { name: "components/global-water-volume.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="global-water-volume" tabindex="-1">Global Water Volume <a class="header-anchor" href="#global-water-volume" aria-label="Permalink to &quot;Global Water Volume&quot;">​</a></h1><p>Water that reaches the horizon, with detail that follows the camera.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; Water &gt; Global Water Volume</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Water &gt; Global Water Volume</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Water</td><td>The <a href="./../assets/water">Water</a> asset that sets the look and waves. Empty uses the Realistic defaults.</td></tr><tr><td>Enabled</td><td>Draws the water and includes it in water queries and buoyancy. Default on.</td></tr><tr><td>Depth</td><td>Depth of the water below the surface, 0.01 to 10,000. Default 1000.</td></tr><tr><td>Wave Scale</td><td>Multiplies the asset&#39;s waves, 0 to 10. Default 1.</td></tr><tr><td>Flow Speed</td><td>Speed of the current, -100 to 100. Default 0.</td></tr><tr><td>Flow Direction</td><td>Direction of the current, in degrees. Default 0.</td></tr><tr><td>Surface Resolution</td><td>Mesh detail, 8 to 128. Default 96.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>World scenes only.</li><li>It has no Width or Length. The surface extends to the horizon and the mesh detail follows the camera.</li><li>The water surface sits at the actor&#39;s position, with Depth running below it. Select the actor to show a handle that you drag to change Depth.</li><li>To cut a hole in it, such as inside a boat hull, use a <a href="./water-removal-volume">Water Removal Volume</a>.</li><li>Use <a href="./water-ocean">Water Ocean</a> when you want a bounded rectangle.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/water">Water</a></li><li><a href="./water-buoyancy">Water Buoyancy</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/global-water-volume.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const globalWaterVolume = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  globalWaterVolume as default
};
