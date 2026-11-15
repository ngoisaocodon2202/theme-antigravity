import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 9000,
  wallpaperPath: "./assets/wallpaper-4k.jpg",
  backgroundColor: "#03080C",
  backgroundSize: "contain",
  backgroundPosition: "center center",
  framePadding: "48px 12px 12px 12px",
  overlayColor: "rgba(3, 8, 12, 0.22)",
  backdropBlur: "14px",
  glassSurfaceColor: "rgba(12, 16, 24, 0.48)",
  glassBorderColor: "rgba(255, 255, 255, 0.14)",
  forceLightText: true,
  targetTitleFilter: "",
};

const MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

/**
 * Parse command-line flags for the theme injector CLI.
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  const options = {
    watch: false,
    reset: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const nextValue = () => {
      if (i + 1 >= argv.length) {
        throw new Error(`Thiếu giá trị cho tham số "${arg}".`);
      }
      i += 1;
      return argv[i];
    };

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--watch":
      case "-w":
        options.watch = true;
        break;
      case "--reset":
        options.reset = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--port":
      case "-p": {
        const raw = nextValue();
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`Cổng CDP không hợp lệ: "${raw}". Cần số nguyên từ 1 đến 65535.`);
        }
        options.port = port;
        break;
      }
      case "--host":
        options.host = nextValue();
        break;
      case "--config":
      case "-c":
        options.configPath = nextValue();
        break;
      case "--image":
      case "-i":
        options.wallpaperPath = nextValue();
        break;
      case "--title":
      case "-t":
        options.targetTitleFilter = nextValue();
        break;
      default:
        throw new Error(`Tham số không hợp lệ: "${arg}". Dùng --help để xem hướng dẫn.`);
    }
  }

  return options;
}

/**
 * Load theme configuration from JSON and merge CLI overrides.
 * @param {string} projectRoot
 * @param {ReturnType<typeof parseCliArgs>} cliArgs
 */
export function loadThemeConfig(projectRoot, cliArgs = {}) {
  const resolvedConfigPath = cliArgs.configPath
    ? path.resolve(projectRoot, cliArgs.configPath)
    : path.join(projectRoot, "theme.config.json");

  let fileConfig = {};
  if (fs.existsSync(resolvedConfigPath)) {
    const rawText = fs.readFileSync(resolvedConfigPath, "utf8");
    fileConfig = JSON.parse(rawText);
  } else if (cliArgs.configPath) {
    throw new Error(`Không tìm thấy file cấu hình: ${resolvedConfigPath}`);
  }

  const merged = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
  };

  if (cliArgs.host !== undefined) merged.host = cliArgs.host;
  if (cliArgs.port !== undefined) merged.port = cliArgs.port;
  if (cliArgs.wallpaperPath !== undefined) merged.wallpaperPath = cliArgs.wallpaperPath;
  if (cliArgs.targetTitleFilter !== undefined) merged.targetTitleFilter = cliArgs.targetTitleFilter;

  const configBaseDir = path.dirname(resolvedConfigPath);
  const resolvedWallpaperPath = cliArgs.wallpaperPath
    ? path.resolve(process.cwd(), cliArgs.wallpaperPath)
    : path.resolve(configBaseDir, merged.wallpaperPath);

  return {
    configPath: resolvedConfigPath,
    resolvedWallpaperPath,
    config: merged,
  };
}

/**
 * Read a local image file and encode it as a Base64 data URI.
 * Using a data URI avoids file:// origin restrictions inside Electron renderers.
 * @param {string} imagePath
 */
export function loadWallpaperDataUri(imagePath) {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Không tìm thấy ảnh nền tại: ${imagePath}`);
  }

  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = MIME_TYPES[ext];
  if (!mimeType) {
    throw new Error(
      `Định dạng ảnh "${ext || "(không có đuôi)"}" chưa được hỗ trợ. Hãy dùng jpg, png, webp, gif, avif hoặc svg.`
    );
  }

  const buffer = fs.readFileSync(imagePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}
