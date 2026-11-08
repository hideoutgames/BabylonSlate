import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Event Initialize Animation","description":"","frontmatter":{"node":"anim.event.initialize"},"headers":[],"relativePath":"scripting/animation/event-initialize-animation.md","filePath":"scripting/animation/event-initialize-animation.md"}');
const _sfc_main = { name: "scripting/animation/event-initialize-animation.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="event-initialize-animation" tabindex="-1">Event Initialize Animation <a class="header-anchor" href="#event-initialize-animation" aria-label="Permalink to &quot;Event Initialize Animation&quot;">​</a></h1><p>Runs once when an Animation Graph component first starts running this graph.</p><h2 id="outputs" tabindex="-1">Outputs <a class="header-anchor" href="#outputs" aria-label="Permalink to &quot;Outputs&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Pin</th><th>Type</th></tr></thead><tbody><tr><td>Out</td><td><span class="haptic-graph haptic-pin-type" aria-hidden="true"><span class="block rotate-45 rounded-sm" data-pin-shape="diamond" data-pin-connected="true" aria-hidden="true" style="${serverRenderer_cjs_prodExports.ssrRenderStyle({ "width": "1em", "height": "1em", "background": "var(--pin-exec)" })}"></span></span>Exec</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Only available in the Animation Object graph of an Animation Graph asset (the <strong>Animation Object</strong> view).</li><li>Use it to set up Animation Graph variables before the first update.</li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("scripting/animation/event-initialize-animation.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const eventInitializeAnimation = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  eventInitializeAnimation as default
};
