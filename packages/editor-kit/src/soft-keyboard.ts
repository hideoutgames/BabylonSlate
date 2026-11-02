import { isCoarsePointerEnvironment } from "./prevent-document-overscroll";

/** How long `primeSoftKeyboard`'s stand-in field waits for the real field. */
const SOFT_KEYBOARD_PRIME_MS = 2000;

/**
 * iOS raises the on-screen keyboard only for a focus made while handling a
 * tap. Call this in the tap's handler when a text field will focus later (an
 * inline rename that opens after an async write): a hidden stand-in field
 * takes focus and the keyboard now, and hands both to the real field when it
 * focuses. The stand-in leaves on blur, or blurs itself after a timeout. No-op
 * without a coarse pointer.
 */
export function primeSoftKeyboard(timeoutMs = SOFT_KEYBOARD_PRIME_MS): void {
  if (typeof document === "undefined" || !isCoarsePointerEnvironment()) return;
  const proxy = document.createElement("input");
  proxy.type = "text";
  proxy.tabIndex = -1;
  proxy.autocomplete = "off";
  proxy.setAttribute("aria-hidden", "true");
  proxy.dataset.softKeyboardPrime = "";
  // 16px text keeps iOS from zooming to the field; it is invisible and inert.
  proxy.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;pointer-events:none;";
  let timer = 0;
  const remove = () => {
    window.clearTimeout(timer);
    proxy.remove();
  };
  proxy.addEventListener("blur", remove, { once: true });
  timer = window.setTimeout(() => {
    if (document.activeElement === proxy) proxy.blur();
    remove();
  }, timeoutMs);
  document.body.append(proxy);
  proxy.focus({ preventScroll: true });
}
