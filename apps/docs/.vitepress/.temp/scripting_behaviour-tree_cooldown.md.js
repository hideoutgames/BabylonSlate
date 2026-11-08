import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Cooldown","description":"","frontmatter":{"node":"bt.decorator.cooldown"},"headers":[],"relativePath":"scripting/behaviour-tree/cooldown.md","filePath":"scripting/behaviour-tree/cooldown.md"}');
const _sfc_main = { name: "scripting/behaviour-tree/cooldown.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="cooldown" tabindex="-1">Cooldown <a class="header-anchor" href="#cooldown" aria-label="Permalink to &quot;Cooldown&quot;">​</a></h1><p>Stops a node from running again for a set time after it finishes.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Default</th><th>Description</th></tr></thead><tbody><tr><td>Duration MS</td><td>1000</td><td>How long the node is blocked, in milliseconds.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>While the cooldown runs, the node fails straight away, so a Selector moves on to its next child.</li><li>The cooldown starts when the node finishes or is aborted.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/behaviour-tree/cooldown.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const cooldown = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  cooldown as default
};
