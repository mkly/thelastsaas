import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";

import { Hono } from "hono";

import type { AppEnvironment } from "../env";
import { getExternalOrigin } from "../html";

const BINARY_ARTIFACTS = {
  "linux-x64": { artifact: "saas-linux-x64", download: "saas" },
  "linux-arm64": { artifact: "saas-linux-arm64", download: "saas" },
  "darwin-x64": { artifact: "saas-darwin-x64", download: "saas" },
  "darwin-arm64": { artifact: "saas-darwin-arm64", download: "saas" },
  "windows-x64": { artifact: "saas-windows-x64.exe", download: "saas.exe" },
} as const;

type BinaryPlatform = keyof typeof BINARY_ARTIFACTS;
type BinaryFile = (typeof BINARY_ARTIFACTS)[BinaryPlatform]["artifact"];
type EmbeddedBinaryModule = { default: string };

const BUN_FS_PREFIX = "/$bunfs/";
const MODULE_DIR = String(Reflect.get(import.meta, "dir") ?? process.cwd());
const IS_STANDALONE_BUILD = MODULE_DIR.startsWith(BUN_FS_PREFIX);
const SOURCE_DIST_DIR = resolve(MODULE_DIR, "../../../../dist");

// Bun embeds these file imports in the standalone server binary. In source
// mode, requests fall back to the matching files in the repository dist dir.
const embeddedBinaryImporters: Record<
  BinaryFile,
  () => Promise<EmbeddedBinaryModule>
> = {
  "saas-linux-x64": () =>
    import("../../../../dist/saas-linux-x64", { with: { type: "file" } }),
  "saas-linux-arm64": () =>
    import("../../../../dist/saas-linux-arm64", { with: { type: "file" } }),
  "saas-darwin-x64": () =>
    import("../../../../dist/saas-darwin-x64", { with: { type: "file" } }),
  "saas-darwin-arm64": () =>
    import("../../../../dist/saas-darwin-arm64", { with: { type: "file" } }),
  "saas-windows-x64.exe": () =>
    import("../../../../dist/saas-windows-x64.exe", {
      with: { type: "file" },
    }),
};

const embeddedBinaryPaths = new Map<BinaryFile, string>();

export const downloadsRouter = new Hono<AppEnvironment>();

function isBinaryPlatform(platform: string): platform is BinaryPlatform {
  return Object.hasOwn(BINARY_ARTIFACTS, platform);
}

function getHostPlatform(): BinaryPlatform | null {
  let arch: "x64" | "arm64";
  switch (process.arch) {
    case "x64":
      arch = "x64";
      break;
    case "arm64":
      arch = "arm64";
      break;
    default:
      return null;
  }

  switch (process.platform) {
    case "linux":
      return `linux-${arch}`;
    case "darwin":
      return `darwin-${arch}`;
    case "win32":
      return arch === "x64" ? "windows-x64" : null;
    default:
      return null;
  }
}

async function getEmbeddedBinaryPath(file: BinaryFile): Promise<string | null> {
  const cached = embeddedBinaryPaths.get(file);
  if (cached) return cached;

  try {
    const module = await embeddedBinaryImporters[file]();
    embeddedBinaryPaths.set(file, module.default);
    return module.default;
  } catch {
    return null;
  }
}

function createDownloadResponse(
  downloadName: string,
  stream: ReadableStream,
  size: number,
): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${downloadName}"`,
    },
  });
}

async function serveEmbeddedBinary(
  file: BinaryFile,
  downloadName: string,
): Promise<Response | null> {
  if (!IS_STANDALONE_BUILD) return null;

  const assetPath = await getEmbeddedBinaryPath(file);
  if (!assetPath) return null;

  const asset = Bun.file(assetPath);
  return createDownloadResponse(downloadName, asset.stream(), asset.size);
}

function serveDiskBinary(
  platform: BinaryPlatform,
  file: BinaryFile,
  downloadName: string,
): Response | null {
  const path = resolve(SOURCE_DIST_DIR, file);
  if (existsSync(path)) {
    const size = statSync(path).size;
    const stream = Readable.toWeb(
      createReadStream(path),
    ) as unknown as ReadableStream;
    return createDownloadResponse(downloadName, stream, size);
  }

  if (getHostPlatform() !== platform) return null;

  const genericPath = resolve(SOURCE_DIST_DIR, "saas");
  if (!existsSync(genericPath)) return null;

  const size = statSync(genericPath).size;
  const stream = Readable.toWeb(
    createReadStream(genericPath),
  ) as unknown as ReadableStream;
  return createDownloadResponse(downloadName, stream, size);
}

downloadsRouter.get("/dl/:platform/:download", async (context) => {
  const platform = context.req.param("platform");
  if (!isBinaryPlatform(platform)) {
    return context.json({ status: "error", error: "NotFound" }, 404);
  }
  const { artifact, download } = BINARY_ARTIFACTS[platform];
  if (context.req.param("download") !== download) {
    return context.json({ status: "error", error: "NotFound" }, 404);
  }

  const embeddedResponse = await serveEmbeddedBinary(artifact, download);
  if (embeddedResponse) return embeddedResponse;

  const diskResponse = serveDiskBinary(platform, artifact, download);
  if (diskResponse) return diskResponse;

  return context.json({ status: "error", error: "NotFound" }, 404);
});

downloadsRouter.get("/install.sh", (context) => {
  const server = getExternalOrigin(
    context.req.raw,
    context.get("config")?.betterAuthUrl,
  );
  const script = `#!/bin/sh
set -e

SERVER="\${LASTSAAS_SERVER:-${server}}"
INSTALL_DIR="\${LASTSAAS_INSTALL_DIR:-}"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

case "$OS" in
  linux|darwin) PLATFORM="$OS-$ARCH" ;;
  *) echo "Unsupported OS: $OS (use $SERVER/dl/windows-x64/saas.exe on Windows)" >&2; exit 1 ;;
esac

if [ -z "$INSTALL_DIR" ]; then
  if [ -z "\${HOME:-}" ]; then
    echo "HOME is not set. Set LASTSAAS_INSTALL_DIR to a writable directory." >&2
    exit 1
  fi
  INSTALL_DIR="$HOME/.local/bin"
  echo "Installing to \$HOME/.local/bin by default. To choose another directory, set LASTSAAS_INSTALL_DIR." >&2
fi

if ! mkdir -p "$INSTALL_DIR"; then
  echo "Failed to create install directory: $INSTALL_DIR" >&2
  exit 1
fi

if [ ! -w "$INSTALL_DIR" ]; then
  echo "Install directory is not writable: $INSTALL_DIR" >&2
  echo "Set LASTSAAS_INSTALL_DIR to a writable directory." >&2
  exit 1
fi

URL="$SERVER/dl/$PLATFORM/saas"
DEST="$INSTALL_DIR/saas"
TMP="$DEST.tmp"

echo "Downloading $URL"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" "$URL"
else
  echo "curl or wget required" >&2
  exit 1
fi

chmod +x "$TMP"
mv "$TMP" "$DEST"
echo "Installed saas to $DEST"

if ! printf '%s\n' "$PATH" | tr ':' '\n' | grep -Fx "$INSTALL_DIR" >/dev/null 2>&1; then
  echo "Note: $INSTALL_DIR is not currently on your PATH."
  echo "Add it to your shell profile to run 'saas' without a full path."
fi

CONFIG_DIR="$HOME/.lastsaas"
CONFIG_FILE="$CONFIG_DIR/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  cat > "$CONFIG_FILE" <<JSON
{
  "server": "$SERVER",
  "session_token": "",
  "expires_at": ""
}
JSON
  chmod 600 "$CONFIG_FILE"
  echo "Pre-configured server: $SERVER"
  echo "Run: saas login"
else
  echo "Existing config at $CONFIG_FILE left untouched."
  echo "Run: saas login --server $SERVER  (to switch servers)"
fi
`;

  return new Response(script, {
    headers: { "Content-Type": "text/x-shellscript; charset=utf-8" },
  });
});
