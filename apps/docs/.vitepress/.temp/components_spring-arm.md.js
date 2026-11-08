import { _ as _export_sfc, s as serverRenderer_cjs_prodExports, v as vueExports } from "./plugin-vue_export-helper.DIxrRcst.js";
import "node:stream";
const __pageData = JSON.parse('{"title":"Spring Arm","description":"","frontmatter":{},"headers":[],"relativePath":"components/spring-arm.md","filePath":"components/spring-arm.md"}');
const _sfc_main = { name: "components/spring-arm.md" };
function _sfc_ssrRender(_ctx, _push, _parent, _attrs, $props, $setup, $data, $options) {
  _push(`<div${serverRenderer_cjs_prodExports.ssrRenderAttrs(_attrs)}><h1 id="spring-arm" tabindex="-1">Spring Arm <a class="header-anchor" href="#spring-arm" aria-label="Permalink to &quot;Spring Arm&quot;">​</a></h1><p>Holds its child components at the end of an arm, with optional lag, so a camera can follow an actor smoothly.</p><h2 id="add-it" tabindex="-1">Add it <a class="header-anchor" href="#add-it" aria-label="Permalink to &quot;Add it&quot;">​</a></h2><p>Open the actor&#39;s Class or Prefab. In <strong>Components</strong>, choose <strong>Add Component &gt; Camera &gt; Spring Arm</strong>, then add a <a href="./camera">Camera</a> as its child. Rotate the Spring Arm to set the viewing angle.</p><h2 id="settings" tabindex="-1">Settings <a class="header-anchor" href="#settings" aria-label="Permalink to &quot;Settings&quot;">​</a></h2><table tabindex="0"><thead><tr><th>Setting</th><th>Description</th></tr></thead><tbody><tr><td>Arm Length</td><td>Distance behind the arm&#39;s origin, along its local -Z axis, where children attach. 0 to 1000. Default 4.</td></tr><tr><td>Enable Location Lag</td><td>In Play, the arm trails behind its target position. Default off.</td></tr><tr><td>Location Lag Speed</td><td>How fast the arm catches up, 0.1 to 100. Default 10.</td></tr><tr><td>Max Location Lag Distance</td><td>Furthest the arm may trail. 0 means unlimited. Default 0.</td></tr><tr><td>Enable Rotation Lag</td><td>In Play, the arm eases toward its target rotation. Default off.</td></tr><tr><td>Rotation Lag Speed</td><td>How fast the rotation catches up, 0.1 to 100. Default 10.</td></tr><tr><td>Draw Debug Lag</td><td>In Play, draws the target arm (yellow), the lagged arm (green) and the lag offset (red). Default off.</td></tr></tbody></table><h2 id="notes" tabindex="-1">Notes <a class="header-anchor" href="#notes" aria-label="Permalink to &quot;Notes&quot;">​</a></h2><ul><li>World scenes only.</li><li>Only child components follow the arm. Child actors do not.</li><li>The lag does not depend on the frame rate.</li><li>The arm does not push the camera in front of walls.</li></ul><h2 id="related" tabindex="-1">Related <a class="header-anchor" href="#related" aria-label="Permalink to &quot;Related&quot;">​</a></h2><ul><li><a href="./../graphics/cameras">Cameras</a></li></ul></div>`);
}
const _sfc_setup = _sfc_main.setup;
_sfc_main.setup = (props, ctx) => {
  const ssrContext = vueExports.useSSRContext();
  (ssrContext.modules || (ssrContext.modules = /* @__PURE__ */ new Set())).add("components/spring-arm.md");
  return _sfc_setup ? _sfc_setup(props, ctx) : void 0;
};
const springArm = /* @__PURE__ */ _export_sfc(_sfc_main, [["ssrRender", _sfc_ssrRender]]);
export {
  __pageData,
  springArm as default
};
