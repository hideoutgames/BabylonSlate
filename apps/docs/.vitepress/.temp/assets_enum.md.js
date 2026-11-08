import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Enum","description":"","frontmatter":{},"headers":[],"relativePath":"assets/enum.md","filePath":"assets/enum.md"}');
const _sfc_main = { name: "assets/enum.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="enum" tabindex="-1">Enum <a class="header-anchor" href="#enum" aria-label="Permalink to &quot;Enum&quot;">​</a></h1><p>A fixed list of named options, each with a value from 0 to 255, used by pins and variables.</p><h2 id="create" tabindex="-1">Create <a class="header-anchor" href="#create" aria-label="Permalink to &quot;Create&quot;">​</a></h2><p>In the <strong>Content Browser</strong>, choose <strong>New Asset &gt; Scripting &gt; Enum</strong>.</p><h2 id="editor" tabindex="-1">Editor <a class="header-anchor" href="#editor" aria-label="Permalink to &quot;Editor&quot;">​</a></h2><p>Double-tap an Enum to open it.</p><ul><li><strong>Members</strong>: one row per option, with its name and value. Tap a row to select it; double-tap its name (or press F2) to rename it. Values are whole numbers from 0 to 255; a decimal rounds to the nearest one and a value outside the range moves to the nearest end. Tap <strong>Add member</strong> (<strong>+</strong>) to add one, and the remove button to delete the selected one. The arrows move a member up or down.</li><li><strong>Inspector</strong>: the selected member&#39;s settings.</li></ul><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Name</td><td>The member&#39;s name.</td></tr><tr><td>Value</td><td>The member&#39;s whole number, from 0 to 255. Older values outside this range load as 0 or 255.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>Choose <strong>Enum</strong> as a variable or pin type, then pick the Enum under <strong>Enum Type</strong>.</li><li>For each Enum, <strong>Add Node</strong> lists nodes named after it. For an Enum called Weapon: <strong>Make Weapon</strong>, <strong>Equal Weapon</strong>, <strong>Not Equal Weapon</strong>, <strong>Weapon to String</strong> and <strong>Switch on Weapon</strong>, plus <strong>Select</strong>.</li><li>When you remove a member, Switch and Select nodes lose that member&#39;s pin and its wires.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../scripting/structures-and-enums">Structures and Enums</a></li><li><a href="./../scripting/class/make-enum">Make Enum</a></li><li><a href="./../scripting/class/switch-on-enum">Switch on Enum</a></li><li><a href="./structure">Structure</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("assets/enum.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const _enum = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  _enum as default
};
