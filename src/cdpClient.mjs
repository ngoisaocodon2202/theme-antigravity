/**
 * Fetch inspectable Electron/Chromium page targets exposed by a CDP port.
 * Tries /json/list first and falls back to /json when needed.
 * @param {{ host: string; port: number; titleFilter?: string; timeoutMs?: number }} options
 */
export async function fetchDebugTargets({ host, port, titleFilter = "", timeoutMs = 4000 }) {
  const candidates = [`http://${host}:${port}/json/list`, `http://${host}:${port}/json`];
  let response = null;
  let usedEndpoint = candidates[0];

  for (const endpoint of candidates) {
    usedEndpoint = endpoint;
    try {
      response = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(
        `Không kết nối được cổng CDP ${host}:${port} (${error.message}). ` +
          `Hãy thoát hẳn Antigravity rồi mở lại kèm cờ --remote-debugging-port=${port} --remote-allow-origins=*.`
      );
    }

    if (response.ok) {
      break;
    }
    if (response.status !== 404) {
      break;
    }
  }

  if (!response || !response.ok) {
    const status = response ? response.status : "unknown";
    const collisionHint =
      port === 9222
        ? " Cổng 9222 thường bị trình duyệt nội bộ của Antigravity giữ sẵn; hãy đổi sang cổng 9000 (--port 9000)."
        : " Có thể cổng này đang bị tiến trình khác chiếm hoặc Electron chặn cờ --remote-debugging-port.";
    throw new Error(`CDP endpoint trả về HTTP ${status} tại ${usedEndpoint}.${collisionHint}`);
  }

  const targets = await response.json();
  const normalizedFilter = titleFilter.trim().toLowerCase();

  return targets.filter((target) => {
    if (target.type !== "page" || !target.webSocketDebuggerUrl) {
      return false;
    }
    if (typeof target.url === "string" && target.url.startsWith("devtools://")) {
      return false;
    }
    if (!normalizedFilter) {
      return true;
    }
    const haystack = `${target.title || ""} ${target.url || ""}`.toLowerCase();
    return haystack.includes(normalizedFilter);
  });
}

/**
 * Minimal Chrome DevTools Protocol (CDP) WebSocket session using Node's native WebSocket.
 */
export class CdpSession {
  #ws;
  #nextId = 1;
  #pending = new Map();

  constructor(ws) {
    this.#ws = ws;
  }

  /**
   * Open a WebSocket connection to a CDP debugger URL.
   * @param {string} webSocketUrl
   * @param {number} timeoutMs
   */
  static connect(webSocketUrl, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(webSocketUrl);
      const session = new CdpSession(ws);

      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // Ignore close error on timeout.
        }
        reject(new Error(`Quá thời gian kết nối WebSocket tới ${webSocketUrl}`));
      }, timeoutMs);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(session);
      });

      ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        const msg = event?.message || "WebSocket connection failed";
        session.#rejectAllPending(new Error(msg));
        reject(new Error(msg));
      });

      ws.addEventListener("close", () => {
        session.#rejectAllPending(new Error("Kết nối CDP WebSocket đã đóng."));
      });

      ws.addEventListener("message", (event) => {
        session.#handleMessage(event.data);
      });
    });
  }

  #handleMessage(rawData) {
    let payload;
    try {
      payload = JSON.parse(typeof rawData === "string" ? rawData : String(rawData));
    } catch {
      return;
    }

    if (payload.id === undefined || !this.#pending.has(payload.id)) {
      return;
    }

    const { resolve, reject, timer } = this.#pending.get(payload.id);
    this.#pending.delete(payload.id);
    clearTimeout(timer);

    if (payload.error) {
      reject(new Error(`CDP error (${payload.error.code}): ${payload.error.message}`));
    } else {
      resolve(payload.result ?? {});
    }
  }

  #rejectAllPending(error) {
    for (const [id, entry] of this.#pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.#pending.delete(id);
    }
  }

  /**
   * Send a CDP JSON-RPC command and wait for its result.
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {number} timeoutMs
   */
  send(method, params = {}, timeoutMs = 5000) {
    if (this.#ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`WebSocket chưa sẵn sàng cho lệnh ${method}.`));
    }

    const id = this.#nextId;
    this.#nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Lệnh CDP ${method} quá thời gian chờ (${timeoutMs}ms).`));
      }, timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Close the CDP WebSocket connection.
   */
  close() {
    this.#rejectAllPending(new Error("Phiên CDP đã đóng."));
    try {
      this.#ws.close();
    } catch {
      // Ignore already-closed WebSocket.
    }
  }
}

/**
 * Evaluate a script inside a target page and optionally persist it across reloads.
 * @param {object} target
 * @param {string} scriptSource
 * @param {{ persistent?: boolean; previousScriptId?: string }} options
 */
export async function executeThemeScript(target, scriptSource, options = {}) {
  const { persistent = true, previousScriptId } = options;
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);

  try {
    try {
      await session.send("Page.enable");
    } catch {
      // Some lightweight WebViews only expose Runtime without Page.enable.
    }

    if (previousScriptId) {
      try {
        await session.send("Page.removeScriptToEvaluateOnNewDocument", {
          identifier: previousScriptId,
        });
      } catch {
        // Ignore stale script identifier removal failures.
      }
    }

    let registeredScriptId = null;
    if (persistent) {
      try {
        const added = await session.send("Page.addScriptToEvaluateOnNewDocument", {
          source: scriptSource,
        });
        registeredScriptId = added.identifier || null;
      } catch {
        // Fallback cleanly to immediate Runtime.evaluate if Page domain is restricted.
      }
    }

    const evalResult = await session.send("Runtime.evaluate", {
      expression: scriptSource,
      returnByValue: true,
      awaitPromise: false,
    });

    if (evalResult.exceptionDetails) {
      const text = evalResult.exceptionDetails.text || "Runtime evaluation failed";
      throw new Error(text);
    }

    return {
      title: target.title || target.url || target.id,
      registeredScriptId,
      result: evalResult.result?.value ?? null,
    };
  } finally {
    session.close();
  }
}
