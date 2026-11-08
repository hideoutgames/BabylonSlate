import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Align Angle","description":"","frontmatter":{"node":"update.alignAngle"},"headers":[],"relativePath":"scripting/particle/align-angle.md","filePath":"scripting/particle/align-angle.md"}');
const _sfc_main = { name: "scripting/particle/align-angle.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="align-angle" tabindex="-1">Align Angle <a class="header-anchor" href="#align-angle" aria-label="Permalink to &quot;Align Angle&quot;">​</a></h1><p>Rotates each particle so its up direction follows its direction of travel on screen.</p><h2 id="inputs" tabindex="-1">Inputs <a class="header-anchor" href="#inputs" aria-label="Permalink to &quot;Inputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th></tr></thead><tbody><tr><td>Particle</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-particle)" })}"></span></span>Particle</td></tr></tbody></table><h2 id="outputs" tabindex="-1">Outputs <a class="header-anchor" href="#outputs" aria-label="Permalink to &quot;Outputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th></tr></thead><tbody><tr><td>Particle</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-particle)" })}"></span></span>Particle</td></tr></tbody></table><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Alignment</td><td>Offset in radians added to the facing angle. The default of 1.5708 (pi divided by 2) points the particle&#39;s up direction along its travel.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>It uses the view of the active camera, so it has no effect when the scene has no active camera.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/particle/align-angle.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const alignAngle = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  alignAngle as default
};
