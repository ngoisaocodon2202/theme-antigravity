import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parseCliArgs, loadThemeConfig, loadWallpaperDataUri } from "../src/config.mjs";
import { buildInjectScript, buildResetScript } from "../src/clientPayload.mjs";
import { applyOnce } from "../inject.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

function createMockWebSocketFrame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function decodeClientWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let payloadLen = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;

    if (payloadLen === 126) {
      if (cursor + 2 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLen === 127) {
      if (cursor + 8 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    const maskLen = masked ? 4 : 0;
    if (cursor + maskLen + payloadLen > buffer.length) break;

    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += maskLen;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + payloadLen));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= mask[i % 4];
      }
    }

    if (opcode === 0x01) {
      messages.push(payload.toString("utf8"));
    }
    offset = cursor + payloadLen;
  }

  return { messages, remaining: buffer.subarray(offset) };
}

async function startMockCdpServer(options = {}) {
  const { listReturns404 = false } = options;
  const recordedCommands = [];
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    const serveTargets = () => {
      const address = server.address();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          {
            id: "devtools-ignored",
            type: "page",
            title: "DevTools",
            url: "devtools://devtools/bundled/inspector.html",
            webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/devtools-ignored`,
          },
          {
            id: "target-main",
            type: "page",
            title: "Antigravity Mock Window",
            url: "app://antigravity/index.html",
            webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/target-main`,
          },
        ])
      );
    };

    if (req.url === "/json/list" && !listReturns404) {
      serveTargets();
      return;
    }
    if (req.url === "/json") {
      serveTargets();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n")
    );

    sockets.add(socket);
    let pendingBuf = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      pendingBuf = Buffer.concat([pendingBuf, chunk]);
      const decoded = decodeClientWebSocketFrames(pendingBuf);
      pendingBuf = decoded.remaining;

      for (const rawMsg of decoded.messages) {
        const msg = JSON.parse(rawMsg);
        recordedCommands.push({ method: msg.method, params: msg.params });

        let result = {};
        if (msg.method === "Page.addScriptToEvaluateOnNewDocument") {
          result = { identifier: "mock-script-1" };
        } else if (msg.method === "Runtime.evaluate") {
          result = { result: { type: "object", value: { ok: true } } };
        }
        socket.write(createMockWebSocketFrame(JSON.stringify({ id: msg.id, result })));
      }
    });

    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    port,
    recordedCommands,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("parseCliArgs parses flags and validates port", () => {
  const parsed = parseCliArgs(["--port", "9333", "--image", "./custom.png", "--watch"]);
  assert.equal(parsed.port, 9333);
  assert.equal(parsed.wallpaperPath, "./custom.png");
  assert.equal(parsed.watch, true);

  assert.throws(() => parseCliArgs(["--port", "abc"]), /không hợp lệ/i);
  assert.throws(() => parseCliArgs(["--unknown"]), /không hợp lệ/i);
});

test("loads default config and encodes wallpaper-4k.jpg as valid JPEG data URI", () => {
  const loaded = loadThemeConfig(PROJECT_ROOT, {});
  assert.equal(loaded.config.port, 9000);
  const dataUri = loadWallpaperDataUri(loaded.resolvedWallpaperPath);
  assert.ok(dataUri.startsWith("data:image/jpeg;base64,"));
  assert.ok(dataUri.length > 1000);
});

test("generated inject and reset scripts compile and execute cleanly in DOM", () => {
  const injectCode = buildInjectScript({
    wallpaperDataUri: "data:image/jpeg;base64,AAAA",
    backgroundColor: "#03080C",
    backgroundSize: "contain",
    backgroundPosition: "center center",
    framePadding: "48px 12px 12px 12px",
    overlayColor: "rgba(3, 8, 12, 0.22)",
    backdropBlur: "14px",
    glassSurfaceColor: "rgba(12, 16, 24, 0.48)",
    glassBorderColor: "rgba(255, 255, 255, 0.14)",
    forceLightText: true,
  });
  const resetCode = buildResetScript();

  assert.doesNotThrow(() => new vm.Script(injectCode));
  assert.doesNotThrow(() => new vm.Script(resetCode));

  const createdNodes = new Map();
  const makeNode = (tagName, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const children = [];
    const node = {
      tagName: tagName.toUpperCase(),
      id: opts.id || "",
      textContent: opts.textContent || "",
      children,
      childNodes: opts.textContent ? [{ nodeType: 3, textContent: opts.textContent }] : [],
      setAttribute(k, v) {
        attrs.set(k, v);
      },
      getAttribute(k) {
        return attrs.get(k) ?? null;
      },
      hasAttribute(k) {
        return attrs.has(k);
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      appendChild(child) {
        child.parentElement = node;
        children.push(child);
        if (child.id) createdNodes.set(child.id, child);
      },
      prepend(child) {
        child.parentElement = node;
        children.unshift(child);
        if (child.id) createdNodes.set(child.id, child);
      },
      remove() {
        if (this.id) createdNodes.delete(this.id);
      },
      closest(selector) {
        if (opts.insideMenu && selector.includes('[role="menu"]')) return { tagName: "DIV" };
        return null;
      },
      querySelector(selector) {
        if (opts.hasTextarea && selector.includes("textarea")) return { tagName: "TEXTAREA" };
        return null;
      },
      querySelectorAll(selector) {
        if (selector === "*") {
          const all = [];
          const walk = (parent) => {
            for (const c of parent.children) {
              all.push(c);
              walk(c);
            }
          };
          walk(node);
          return all;
        }
        return [];
      },
      getBoundingClientRect() {
        return opts.rect || { width: 1200, height: 800, left: 0, top: 0 };
      },
    };
    return node;
  };

  const head = makeNode("head");
  const body = makeNode("body");
  const mainPanel = makeNode("div", {
    rect: { width: 1000, height: 760, left: 260, top: 40 },
    textContent: "Welcome back",
  });
  const sidebar = makeNode("aside", {
    rect: { width: 240, height: 760, left: 0, top: 40 },
  });
  const composer = makeNode("div", {
    rect: { width: 640, height: 120, left: 320, top: 620 },
    hasTextarea: true,
  });
  const popupMenu = makeNode("div", {
    attrs: { role: "menu" },
    rect: { width: 220, height: 240, left: 400, top: 200 },
    insideMenu: true,
  });

  body.appendChild(sidebar);
  body.appendChild(mainPanel);
  body.appendChild(composer);
  body.appendChild(popupMenu);

  const sandbox = {
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {},
    },
    document: {
      readyState: "complete",
      head,
      body,
      documentElement: makeNode("html"),
      createElement: (tag) => makeNode(tag),
      getElementById: (id) => createdNodes.get(id) || null,
      querySelectorAll: (selector) => {
        const all = [sidebar, mainPanel, composer, popupMenu];
        if (selector === "*") return all;
        if (selector === "[data-agy-surface]") {
          return all.filter((el) => el.hasAttribute("data-agy-surface"));
        }
        if (selector === "[data-agy-text]") {
          return all.filter((el) => el.hasAttribute("data-agy-text"));
        }
        return [];
      },
      addEventListener() {},
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    Node: { TEXT_NODE: 3 },
    getComputedStyle: () => ({
      backgroundColor: "rgb(255, 255, 255)",
      backgroundImage: "none",
      color: "rgb(17, 24, 39)",
      position: "static",
      zIndex: "auto",
    }),
    requestAnimationFrame: (fn) => fn(),
  };
  sandbox.window.document = sandbox.document;

  const injectResult = vm.runInNewContext(injectCode, sandbox);
  assert.equal(injectResult.applied, true);
  assert.ok(createdNodes.has("agy-theme-style"));
  assert.ok(createdNodes.has("agy-theme-wallpaper-layer"));
  assert.match(createdNodes.get("agy-theme-style").textContent, /background-size:\s*contain/);
  assert.match(createdNodes.get("agy-theme-style").textContent, /padding:\s*48px 12px 12px 12px/);
  assert.equal(mainPanel.getAttribute("data-agy-surface"), "canvas");
  assert.equal(sidebar.getAttribute("data-agy-surface"), "glass");
  assert.equal(composer.getAttribute("data-agy-surface"), "glass");
  assert.equal(popupMenu.hasAttribute("data-agy-surface"), false);
  assert.equal(mainPanel.getAttribute("data-agy-text"), "light");

  const resetResult = vm.runInNewContext(resetCode, sandbox);
  assert.equal(resetResult.reset, true);
  assert.equal(createdNodes.has("agy-theme-style"), false);
  assert.equal(createdNodes.has("agy-theme-wallpaper-layer"), false);
  assert.equal(mainPanel.hasAttribute("data-agy-surface"), false);
  assert.equal(sidebar.hasAttribute("data-agy-surface"), false);
  assert.equal(mainPanel.hasAttribute("data-agy-text"), false);
});

test("applyOnce injects and resets cleanly against a mock CDP WebSocket server", async () => {
  const mockServer = await startMockCdpServer();
  const tempStatePath = path.join(PROJECT_ROOT, ".test-cdp-state.json");

  try {
    const injectRes = await applyOnce(
      { port: mockServer.port, reset: false, dryRun: false },
      new Map(),
      { projectRoot: PROJECT_ROOT, stateFilePath: tempStatePath }
    );
    assert.equal(injectRes.injectedCount, 1);
    assert.ok(fs.existsSync(tempStatePath));

    const methodNames = mockServer.recordedCommands.map((c) => c.method);
    assert.ok(methodNames.includes("Page.addScriptToEvaluateOnNewDocument"));
    assert.ok(methodNames.includes("Runtime.evaluate"));

    mockServer.recordedCommands.length = 0;

    const savedState = new Map(Object.entries(JSON.parse(fs.readFileSync(tempStatePath, "utf8"))));
    const resetRes = await applyOnce(
      { port: mockServer.port, reset: true, dryRun: false },
      savedState,
      { projectRoot: PROJECT_ROOT, stateFilePath: tempStatePath }
    );
    assert.equal(resetRes.injectedCount, 1);
    assert.equal(fs.existsSync(tempStatePath), false);

    const resetMethods = mockServer.recordedCommands.map((c) => c.method);
    assert.ok(resetMethods.includes("Page.removeScriptToEvaluateOnNewDocument"));
    assert.ok(resetMethods.includes("Runtime.evaluate"));
  } finally {
    if (fs.existsSync(tempStatePath)) fs.unlinkSync(tempStatePath);
    await mockServer.close();
  }
});

test("falls back to /json when /json/list returns HTTP 404", async () => {
  const mockServer = await startMockCdpServer({ listReturns404: true });

  try {
    const res = await applyOnce(
      { port: mockServer.port, reset: false, dryRun: false },
      new Map(),
      { projectRoot: PROJECT_ROOT, persistStateFile: false }
    );
    assert.equal(res.injectedCount, 1);
  } finally {
    await mockServer.close();
  }
});
