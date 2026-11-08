import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Water Removal Volume","description":"","frontmatter":{},"headers":[],"relativePath":"components/water-removal-volume.md","filePath":"components/water-removal-volume.md"}');
const _sfc_main = { name: "components/water-removal-volume.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="water-removal-volume" tabindex="-1">Water Removal Volume <a class="header-anchor" href="#water-removal-volume" aria-label="Permalink to &quot;Water Removal Volume&quot;">​</a></h1><p>Removes water inside a box, sphere, cylinder or capsule, such as the inside of a boat hull.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; Water &gt; Water Removal Volume</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Water &gt; Water Removal Volume</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Enabled</td><td>Removes water. Default on.</td></tr><tr><td>Shape</td><td><strong>Box</strong>, <strong>Sphere</strong>, <strong>Cylinder</strong> or <strong>Capsule</strong>. Default Box.</td></tr><tr><td>Width</td><td>Size along local X for a box. Named <strong>Diameter</strong> for the round shapes. Default 4.</td></tr><tr><td>Height</td><td>Size along local Y. Hidden for a sphere. For a cylinder or capsule it is the total height, including a capsule&#39;s rounded ends. Default 4.</td></tr><tr><td>Length</td><td>Size along local Z. Box only. Default 4.</td></tr></tbody></table><p>Each size is 0.01 to 10,000.</p><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>World scenes only.</li><li>Water inside the shape is removed from every water body. It affects drawing, water queries and buoyancy.</li><li>Disabling it brings the water back.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/water">Water</a></li><li><a href="./../scripting/class/sample-water-surface">Sample Water Surface</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/water-removal-volume.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const waterRemovalVolume = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  waterRemovalVolume as default
};
