/**
 * Build the self-contained JavaScript snippet injected into the Electron renderer.
 * It keeps all styling inside a dedicated <style> tag + wallpaper backdrop layer
 * and uses data-agy-* attributes so resetting restores the original UI cleanly.
 * @param {{
 *   wallpaperDataUri: string;
 *   backgroundColor: string;
 *   backgroundSize: string;
 *   backgroundPosition: string;
 *   framePadding: string;
 *   overlayColor: string;
 *   backdropBlur: string;
 *   glassSurfaceColor: string;
 *   glassBorderColor: string;
 *   forceLightText: boolean;
 * }} options
 */
export function buildInjectScript(options) {
  const safeOptions = JSON.stringify(options);

  return `(() => {
  const CONFIG = ${safeOptions};
  const STYLE_ID = "agy-theme-style";
  const LAYER_ID = "agy-theme-wallpaper-layer";
  const GLOBAL_KEY = "__agyThemeInjector";

  if (window[GLOBAL_KEY] && typeof window[GLOBAL_KEY].cleanup === "function") {
    window[GLOBAL_KEY].cleanup();
  }

  function buildStylesheet() {
    const lightTextCss = CONFIG.forceLightText
      ? \`
    [data-agy-text="light"] {
      color: #f3f6fc !important;
      text-shadow: 0 1px 6px rgba(0, 0, 0, 0.55);
    }
    [data-agy-text="muted"] {
      color: rgba(226, 232, 245, 0.78) !important;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
    }
    [data-agy-surface="glass"] textarea,
    [data-agy-surface="glass"] input,
    [data-agy-surface="glass"] [contenteditable="true"] {
      color: #f3f6fc !important;
      caret-color: #f3f6fc !important;
      background: transparent !important;
    }
    [data-agy-surface="glass"] textarea::placeholder,
    [data-agy-surface="glass"] input::placeholder {
      color: rgba(220, 228, 242, 0.62) !important;
    }
\`
      : "";

    return \`
    html,
    body {
      background: transparent !important;
      background-color: transparent !important;
    }
    body {
      position: relative;
      z-index: 0;
    }
    #\${LAYER_ID} {
      position: fixed;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      box-sizing: border-box;
      padding: \${CONFIG.framePadding};
      background-color: \${CONFIG.backgroundColor};
      background-image: url("\${CONFIG.wallpaperDataUri}");
      background-origin: content-box;
      background-size: \${CONFIG.backgroundSize};
      background-position: \${CONFIG.backgroundPosition};
      background-repeat: no-repeat;
    }
    #\${LAYER_ID}::after {
      content: "";
      position: fixed;
      inset: 0;
      background: \${CONFIG.overlayColor};
      pointer-events: none;
    }
    [data-agy-surface="canvas"] {
      background: transparent !important;
      background-color: transparent !important;
    }
    [data-agy-surface="glass"] {
      background: \${CONFIG.glassSurfaceColor} !important;
      background-color: \${CONFIG.glassSurfaceColor} !important;
      backdrop-filter: blur(\${CONFIG.backdropBlur}) saturate(130%) !important;
      -webkit-backdrop-filter: blur(\${CONFIG.backdropBlur}) saturate(130%) !important;
      border-color: \${CONFIG.glassBorderColor} !important;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.28) !important;
    }
    \${lightTextCss}
\`;
  }

  function parseRgba(value) {
    if (!value || value === "transparent") return null;
    const match = value.match(/rgba?\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)(?:\\s*,\\s*([\\d.]+))?\\s*\\)/i);
    if (!match) return null;
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] === undefined ? 1 : Number(match[4]),
    };
  }

  function relativeLuminance(rgba) {
    const channel = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(rgba.r) + 0.7152 * channel(rgba.g) + 0.0722 * channel(rgba.b);
  }

  function isProtectedElement(el) {
    const tag = el.tagName;
    if (
      tag === "IMG" ||
      tag === "SVG" ||
      tag === "PATH" ||
      tag === "CANVAS" ||
      tag === "VIDEO" ||
      tag === "IFRAME" ||
      tag === "PRE" ||
      tag === "CODE" ||
      tag === "SCRIPT" ||
      tag === "STYLE" ||
      tag === "BUTTON" ||
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT"
    ) {
      return true;
    }
    const role = el.getAttribute("role");
    if (
      role === "dialog" ||
      role === "alertdialog" ||
      role === "menu" ||
      role === "listbox" ||
      role === "tooltip" ||
      el.getAttribute("aria-modal") === "true"
    ) {
      return true;
    }
    return false;
  }

  function classifySurface(el, style, vw, vh) {
    if (el === document.documentElement || el === document.body) {
      return "canvas";
    }
    if (isProtectedElement(el)) return null;
    if (el.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [aria-modal="true"]')) {
      return null;
    }

    const bg = parseRgba(style.backgroundColor);
    const hasBgImage = style.backgroundImage && style.backgroundImage !== "none";
    const isOpaque = (bg && bg.a >= 0.75) || hasBgImage;
    if (!isOpaque) return null;

    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 28) return null;

    const zIndex = Number(style.zIndex);
    if ((style.position === "fixed" || style.position === "absolute") && Number.isFinite(zIndex) && zIndex >= 40) {
      if (rect.width < vw * 0.85 && rect.height < vh * 0.85) {
        return null;
      }
    }

    const coversMajority = rect.width >= vw * 0.55 && rect.height >= vh * 0.55;
    if (coversMajority) {
      return "canvas";
    }

    const isLeftSidebar = rect.left <= 20 && rect.height >= vh * 0.55 && rect.width >= 150 && rect.width <= vw * 0.42;
    if (isLeftSidebar) {
      return "glass";
    }

    const isTopBar = rect.top <= 12 && rect.width >= vw * 0.5 && rect.height <= 88;
    if (isTopBar) {
      return "glass";
    }

    const isComposerCard =
      rect.height <= vh * 0.48 &&
      rect.width >= 260 &&
      el.querySelector('textarea, [contenteditable="true"], input[type="text"]');
    if (isComposerCard) {
      return "glass";
    }

    if (rect.width >= vw * 0.42 && rect.height >= vh * 0.42) {
      return "canvas";
    }

    return null;
  }

  function hasDirectText(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent && node.textContent.trim().length > 0) {
        return true;
      }
    }
    return false;
  }

  function hasDirectIcon(el) {
    for (const child of el.children) {
      if (child.tagName === "SVG") return true;
    }
    return false;
  }

  function sitsOnThemedSurface(el) {
    let cursor = el;
    while (cursor && cursor !== document.documentElement) {
      if (cursor.hasAttribute("data-agy-surface")) {
        return true;
      }
      const bg = parseRgba(getComputedStyle(cursor).backgroundColor);
      if (bg && bg.a >= 0.75) {
        return false;
      }
      cursor = cursor.parentElement;
    }
    return true;
  }

  function applyTheme() {
    const head = document.head || document.documentElement;
    if (!head || !document.body) return;

    let styleEl = document.getElementById(STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
      head.appendChild(styleEl);
    }
    const nextCss = buildStylesheet();
    if (styleEl.textContent !== nextCss) {
      styleEl.textContent = nextCss;
    }

    let layerEl = document.getElementById(LAYER_ID);
    if (!layerEl) {
      layerEl = document.createElement("div");
      layerEl.id = LAYER_ID;
      document.body.prepend(layerEl);
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const elements = document.body.querySelectorAll("*");

    for (const el of elements) {
      if (el.id === LAYER_ID || el.id === STYLE_ID) continue;
      if (el.hasAttribute("data-agy-surface")) continue;

      const style = getComputedStyle(el);
      const surface = classifySurface(el, style, vw, vh);
      if (surface) {
        el.setAttribute("data-agy-surface", surface);
      }
    }

    if (CONFIG.forceLightText) {
      for (const el of elements) {
        if (el.id === LAYER_ID || el.id === STYLE_ID) continue;
        if (el.hasAttribute("data-agy-text")) continue;
        if (isProtectedElement(el)) continue;
        if (el.closest('button, a, pre, code, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"]')) {
          continue;
        }
        if (!hasDirectText(el) && !hasDirectIcon(el)) continue;

        const style = getComputedStyle(el);
        const fg = parseRgba(style.color);
        if (!fg || fg.a < 0.2) continue;

        const lum = relativeLuminance(fg);
        if (lum < 0.42 && sitsOnThemedSurface(el)) {
          el.setAttribute("data-agy-text", lum < 0.12 ? "light" : "muted");
        }
      }
    }
  }

  let rafPending = false;
  function scheduleApply() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      applyTheme();
    });
  }

  let observer = null;
  function start() {
    applyTheme();
    if (!document.body) return;
    observer = new MutationObserver(scheduleApply);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    window.addEventListener("resize", scheduleApply);
  }

  window[GLOBAL_KEY] = {
    cleanup() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      window.removeEventListener("resize", scheduleApply);
      document.getElementById(STYLE_ID)?.remove();
      document.getElementById(LAYER_ID)?.remove();
      document.querySelectorAll("[data-agy-surface]").forEach((el) => el.removeAttribute("data-agy-surface"));
      document.querySelectorAll("[data-agy-text]").forEach((el) => el.removeAttribute("data-agy-text"));
      delete window[GLOBAL_KEY];
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  return {
    applied: true,
    surfaceCount: document.querySelectorAll("[data-agy-surface]").length,
  };
})();`;
}

/**
 * Build the JavaScript snippet that removes the injected theme and restores default styling.
 */
export function buildResetScript() {
  return `(() => {
  const GLOBAL_KEY = "__agyThemeInjector";
  if (window[GLOBAL_KEY] && typeof window[GLOBAL_KEY].cleanup === "function") {
    window[GLOBAL_KEY].cleanup();
    return { reset: true };
  }
  document.getElementById("agy-theme-style")?.remove();
  document.getElementById("agy-theme-wallpaper-layer")?.remove();
  document.querySelectorAll("[data-agy-surface]").forEach((el) => el.removeAttribute("data-agy-surface"));
  document.querySelectorAll("[data-agy-text]").forEach((el) => el.removeAttribute("data-agy-text"));
  return { reset: true };
})();`;
}
