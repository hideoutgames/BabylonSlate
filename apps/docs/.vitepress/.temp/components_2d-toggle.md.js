import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"2D Toggle","description":"","frontmatter":{},"headers":[],"relativePath":"components/2d-toggle.md","filePath":"components/2d-toggle.md"}');
const _sfc_main = { name: "components/2d-toggle.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="2d-toggle" tabindex="-1">2D Toggle <a class="header-anchor" href="#2d-toggle" aria-label="Permalink to &quot;2D Toggle&quot;">​</a></h1><p>A switch with a sliding knob that turns a setting on or off.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Select an actor in a Scene Layer, then choose <strong>Add Component &gt; Overlay &gt; 2D Toggle</strong>. You can also place a ready-made actor from <strong>Place Actors &gt; Overlay &gt; 2D Toggle</strong>.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Enabled</td><td>Turns input on or off. Default on.</td></tr><tr><td>Width, Height</td><td>Size of the switch in layer units. Default 1.2 by 0.6.</td></tr><tr><td>Checked</td><td>Whether the switch is on. Default off.</td></tr><tr><td>Opacity</td><td>Fades the whole control, from 0 to 1. Default 1.</td></tr><tr><td>Tint</td><td>Colour and alpha multiplied into every part. Default white.</td></tr><tr><td>Background, Track, Fill and Thumb Material</td><td>Replace the default look of the body, the rail, the rail while on, and the knob. A Material or Material Instance.</td></tr><tr><td>Background, Track, Fill and Thumb Texture</td><td>The same, using a Texture. A Material wins when both are set.</td></tr><tr><td>Focus Enabled, Initial Focus, Focus Up, Focus Down, Focus Left, Focus Right</td><td>Keyboard and gamepad focus. See <a href="./../scenes/scene-layers">Scene Layers</a>.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Scene Layers only.</li><li>The knob sits at the left when off and slides to the right when on. The Fill covers the Track while the switch is on.</li><li>With focus, <kbd>Space</kbd> or <kbd>Enter</kbd> flips it.</li><li>Read and write the state from a graph with the <strong>Checked</strong> variable and <strong>Set Checked</strong>.</li><li><a href="./../scripting/class/event-on-checked-changed">Event On Checked Changed</a> runs when the state changes.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../scenes/scene-layers">Scene Layers</a></li><li><a href="./2d-checkbox">2D Checkbox</a></li><li><a href="./2d-radio-button">2D Radio Button</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/2d-toggle.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const _2dToggle = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  _2dToggle as default
};
