import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Sprite","description":"","frontmatter":{},"headers":[],"relativePath":"components/sprite.md","filePath":"components/sprite.md"}');
const _sfc_main = { name: "components/sprite.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="sprite" tabindex="-1">Sprite <a class="header-anchor" href="#sprite" aria-label="Permalink to &quot;Sprite&quot;">​</a></h1><p>Draws a 2D image from a Sprite asset on a flat quad.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor, then choose <strong>Add Component &gt; Rendering &gt; Sprite</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Rendering &gt; Sprite</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Asset</td><td>The <a href="./../assets/sprite">Sprite</a> to draw.</td></tr><tr><td>Sorting Layer</td><td>The layer the sprite draws on. Default <strong>Default</strong>.</td></tr><tr><td>Order In Layer</td><td>Order within the layer. Higher values draw in front. Default 0.</td></tr><tr><td>Shading Mode</td><td><strong>2D</strong>: lit by the scene&#39;s <a href="./light-2d">2D Lights</a>, and unlit while the scene has none. <strong>3D</strong>: lit by 3D lights and environment lighting, like a Material surface. <strong>Unlit</strong>: always drawn as it is. Default <strong>2D</strong>.</td></tr><tr><td>Cast Shadows</td><td>Whether it casts a shadow in a lit world scene. Default off, because it is unlit.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Use <strong>3D</strong> to light a 2D element in a 3D game. With <strong>3D</strong>, 2D Lights do not light it; with <strong>2D</strong>, 3D lights do not.</li><li>Works in world scenes and in Scene Layers.</li><li>Sorting Layers are listed back to front in <strong>Project Settings &gt; Game &gt; Sorting Layers</strong>. Layers further down the list draw in front.</li><li>Sprites use cut-out transparency, so semi-transparent pixels do not blend.</li><li>To animate a sprite, add an <a href="./animation-graph">Animation Graph</a> that plays a <a href="./../assets/sprite-animation">Sprite Animation</a>.</li><li>To make it solid, add a <a href="./collider">Collider</a> and a <a href="./rigid-body">Rigid Body</a>.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../2d/sprites">Sprites</a></li><li><a href="./../2d/">2D</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/sprite.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const sprite = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  sprite as default
};
