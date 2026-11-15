import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs, loadThemeConfig, loadWallpaperDataUri } from "./src/config.mjs";
import { fetchDebugTargets, executeThemeScript } from "./src/cdpClient.mjs";
import { buildInjectScript, buildResetScript } from "./src/clientPayload.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE_PATH = path.join(__dirname, ".cdp-state.json");

function printHelp() {
  console.log(`
Antigravity Theme Injector (Non-invasive CDP Runtime Injector)

Cách dùng:
  node inject.js [tùy chọn]

Tùy chọn:
  -p, --port <số>       Cổng CDP của ứng dụng (mặc định: 9000)
      --host <địa chỉ>  Host CDP (mặc định: 127.0.0.1)
  -c, --config <file>   Đường dẫn file theme.config.json tùy chỉnh
  -i, --image <file>    Đường dẫn ảnh nền thay thế
  -t, --title <chuỗi>   Lọc cửa sổ theo tiêu đề/URL
  -w, --watch           Theo dõi thay đổi config/ảnh và tự động cập nhật nóng
      --reset           Gỡ bỏ theme đã tiêm và khôi phục giao diện gốc
      --dry-run         Kiểm tra cấu hình và tạo payload mà không kết nối CDP
  -h, --help            Hiển thị hướng dẫn này
`);
}

function readScriptState(stateFilePath = STATE_FILE_PATH) {
  if (!fs.existsSync(stateFilePath)) {
    return new Map();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function writeScriptState(scriptIdsByTarget, stateFilePath = STATE_FILE_PATH) {
  if (scriptIdsByTarget.size === 0) {
    if (fs.existsSync(stateFilePath)) {
      fs.unlinkSync(stateFilePath);
    }
    return;
  }
  fs.writeFileSync(
    stateFilePath,
    JSON.stringify(Object.fromEntries(scriptIdsByTarget.entries()), null, 2),
    "utf8"
  );
}

export function buildPayloadFromDisk(cliArgs, projectRoot = __dirname) {
  const { configPath, resolvedWallpaperPath, config } = loadThemeConfig(projectRoot, cliArgs);

  if (cliArgs.reset) {
    return {
      configPath,
      resolvedWallpaperPath,
      config,
      scriptSource: buildResetScript(),
      persistent: false,
    };
  }

  const wallpaperDataUri = loadWallpaperDataUri(resolvedWallpaperPath);
  const scriptSource = buildInjectScript({
    wallpaperDataUri,
    backgroundColor: config.backgroundColor,
    backgroundSize: config.backgroundSize,
    backgroundPosition: config.backgroundPosition,
    framePadding: config.framePadding,
    overlayColor: config.overlayColor,
    backdropBlur: config.backdropBlur,
    glassSurfaceColor: config.glassSurfaceColor,
    glassBorderColor: config.glassBorderColor,
    forceLightText: Boolean(config.forceLightText),
  });

  return {
    configPath,
    resolvedWallpaperPath,
    config,
    scriptSource,
    persistent: true,
  };
}

export async function applyOnce(
  cliArgs,
  scriptIdsByTarget = readScriptState(),
  options = {}
) {
  const projectRoot = options.projectRoot || __dirname;
  const persistStateFile = options.persistStateFile !== false;
  const stateFilePath = options.stateFilePath || STATE_FILE_PATH;

  const { configPath, config, scriptSource, persistent, resolvedWallpaperPath } =
    buildPayloadFromDisk(cliArgs, projectRoot);

  if (cliArgs.dryRun) {
    console.log("[dry-run] Cấu hình hợp lệ.");
    console.log(`[dry-run] CDP target: http://${config.host}:${config.port}/json/list`);
    console.log(`[dry-run] Ảnh nền: ${resolvedWallpaperPath}`);
    console.log(`[dry-run] Kích thước payload: ${Buffer.byteLength(scriptSource, "utf8")} bytes`);
    return { configPath, config, resolvedWallpaperPath, injectedCount: 0 };
  }

  const targets = await fetchDebugTargets({
    host: config.host,
    port: config.port,
    titleFilter: config.targetTitleFilter,
  });

  if (targets.length === 0) {
    throw new Error(
      `Không tìm thấy cửa sổ page nào tại http://${config.host}:${config.port}/json/list` +
        (config.targetTitleFilter ? ` khớp với "${config.targetTitleFilter}".` : ".")
    );
  }

  for (const target of targets) {
    const previousScriptId = scriptIdsByTarget.get(target.id);
    const outcome = await executeThemeScript(target, scriptSource, {
      persistent,
      previousScriptId,
    });

    if (outcome.registeredScriptId) {
      scriptIdsByTarget.set(target.id, outcome.registeredScriptId);
    } else if (!persistent) {
      scriptIdsByTarget.delete(target.id);
    }

    const actionLabel = cliArgs.reset ? "Đã gỡ theme" : "Đã tiêm theme";
    console.log(`[OK] ${actionLabel} -> "${outcome.title}"`);
  }

  if (persistStateFile) {
    writeScriptState(scriptIdsByTarget, stateFilePath);
  }

  return { configPath, config, resolvedWallpaperPath, injectedCount: targets.length };
}

function startWatchLoop(cliArgs) {
  const scriptIdsByTarget = readScriptState();
  let debounceTimer = null;
  let watchers = [];

  const closeWatchers = () => {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore close errors.
      }
    }
    watchers = [];
  };

  const attachWatchers = (configPath, wallpaperPath) => {
    closeWatchers();
    for (const filePath of new Set([configPath, wallpaperPath])) {
      if (!fs.existsSync(filePath)) continue;
      const watcher = fs.watch(filePath, () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {
            const state = await applyOnce(cliArgs, scriptIdsByTarget);
            attachWatchers(state.configPath, state.resolvedWallpaperPath);
          } catch (error) {
            console.error(`[watch] Lỗi cập nhật: ${error.message}`);
          }
        }, 180);
      });
      watchers.push(watcher);
    }
  };

  return applyOnce(cliArgs, scriptIdsByTarget).then((state) => {
    attachWatchers(state.configPath, state.resolvedWallpaperPath);
    console.log("[watch] Đang theo dõi thay đổi config và ảnh nền. Nhấn Ctrl+C để dừng.");
  });
}

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  if (cliArgs.help) {
    printHelp();
    return;
  }

  if (cliArgs.watch && !cliArgs.dryRun && !cliArgs.reset) {
    await startWatchLoop(cliArgs);
    return;
  }

  await applyOnce(cliArgs);
}

const isCliEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isCliEntrypoint) {
  main().catch((error) => {
    console.error(`[LỖI] ${error.message}`);
    process.exitCode = 1;
  });
}
