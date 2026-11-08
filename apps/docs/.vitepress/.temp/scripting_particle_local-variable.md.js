import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Local Variable","description":"","frontmatter":{"node":"utility.localVariable"},"headers":[],"relativePath":"scripting/particle/local-variable.md","filePath":"scripting/particle/local-variable.md"}');
const _sfc_main = { name: "scripting/particle/local-variable.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="local-variable" tabindex="-1">Local Variable <a class="header-anchor" href="#local-variable" aria-label="Permalink to &quot;Local Variable&quot;">​</a></h1><p>Keeps the first value it reads and returns it again, so a random or computed value is read once and reused.</p><h2 id="inputs" tabindex="-1">Inputs <a class="header-anchor" href="#inputs" aria-label="Permalink to &quot;Inputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th><th>Default</th></tr></thead><tbody><tr><td>Value</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-wildcard)" })}"></span></span>Any</td><td>0</td></tr></tbody></table><h2 id="outputs" tabindex="-1">Outputs <a class="header-anchor" href="#outputs" aria-label="Permalink to &quot;Outputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th></tr></thead><tbody><tr><td>Value</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rounded-full" data-pin-shape="circle" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-wildcard)" })}"></span></span>Any</td></tr></tbody></table><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Scope</td><td><strong>Particle</strong> (default): each particle keeps the value from its first read for its whole life, so an Update node reads the same value every frame. <strong>Loop</strong>: one value per frame, shared by every particle.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li><strong>Value</strong> can be a Float, Vector 2, Vector 3 or Color, and <strong>Value</strong> out has the same type.</li><li>Wire a <a href="./random">Random</a> with <strong>Every Read</strong> into it to give each particle a fixed random value in Update nodes.</li><li>Read where there is no particle, such as <strong>Emit Rate</strong>, <strong>Particle</strong> scope behaves like <strong>Loop</strong>.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/particle/local-variable.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const localVariable = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  localVariable as default
};
