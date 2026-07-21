#!/usr/bin/env bash
# NovaSpeak 前端原子发布脚本（Ubuntu ECS）。
#
# 解决的问题：直接在 Nginx 正在读取的 client/dist 里执行 vite build，
# 会先删旧哈希资源再写新文件——期间客户端拿到旧 index.html 却加载不到
# 旧 JS，表现为网页/Electron 长时间黑屏。
#
# 流程：
#   1. 在系统临时目录完整构建；
#   2. 校验 index.html 与其引用的全部 /assets/ 哈希文件都存在；
#   3. 移动到 releases/<时间戳>；
#   4. 原子切换 current 符号链接（mv -T，同一文件系统内瞬时完成）；
#   5. 可选健康检查，失败自动回滚到上一版；
#   6. 保留最近 N 个版本用于秒级回滚。
#
# 首次使用需要一次性把 Nginx 的前端 root 从
#   /opt/novaspeak-current/client/dist
# 改为
#   ${RELEASES_DIR}/current
# 并按 scripts/nginx-frontend-cache.conf.example 配置缓存头，
# 修改后必须 sudo nginx -t && sudo systemctl reload nginx。
#
# 本脚本不触碰 Nginx 配置、不重启后端、不删除正在服务的版本。

set -euo pipefail

APP_CLIENT_DIR="${NOVASPEAK_CLIENT_DIR:-/opt/novaspeak-current/client}"
RELEASES_DIR="${NOVASPEAK_WEB_RELEASES:-/opt/novaspeak-web/releases}"
CURRENT_LINK="$RELEASES_DIR/current"
KEEP_RELEASES="${NOVASPEAK_KEEP_RELEASES:-3}"
HEALTHCHECK_URL="${NOVASPEAK_HEALTHCHECK_URL:-}"

log() { printf '[deploy-frontend] %s\n' "$*"; }
fail() { printf '[deploy-frontend] 错误：%s\n' "$*" >&2; exit 1; }

[ -d "$APP_CLIENT_DIR" ] || fail "client 目录不存在：$APP_CLIENT_DIR"
[ -f "$APP_CLIENT_DIR/package.json" ] || fail "缺少 package.json：$APP_CLIENT_DIR"

mkdir -p "$RELEASES_DIR"

# 1. 临时目录构建（绝不写入正在被 Nginx 服务的目录）
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/novaspeak-web-build.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT
log "开始构建到临时目录：$BUILD_DIR"
(cd "$APP_CLIENT_DIR" && npm run build -- --outDir "$BUILD_DIR" --emptyOutDir)

# 2. 校验构建产物完整：index.html 引用的每个 /assets/ 文件都必须存在
[ -f "$BUILD_DIR/index.html" ] || fail "构建产物缺少 index.html"
missing=0
while IFS= read -r asset; do
  [ -n "$asset" ] || continue
  if [ ! -f "$BUILD_DIR$asset" ]; then
    printf '[deploy-frontend] 缺少构建资源：%s\n' "$asset" >&2
    missing=1
  fi
done < <(grep -oE '/assets/[A-Za-z0-9._@-]+' "$BUILD_DIR/index.html" | sort -u)
[ "$missing" -eq 0 ] || fail "index.html 引用了不存在的资源，取消发布"

# 3. 进入 releases（与 current 同一文件系统，保证 mv -T 原子）
STAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE_DIR="$RELEASES_DIR/$STAMP"
[ ! -e "$RELEASE_DIR" ] || fail "版本目录已存在：$RELEASE_DIR"
cp -a "$BUILD_DIR" "$RELEASE_DIR"

PREVIOUS_TARGET=""
if [ -L "$CURRENT_LINK" ]; then
  PREVIOUS_TARGET="$(readlink -f "$CURRENT_LINK" || true)"
fi

# 4. 原子切换 current 符号链接
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK.staging"
mv -T "$CURRENT_LINK.staging" "$CURRENT_LINK"
log "current -> $RELEASE_DIR"

# 5. 可选健康检查；失败回滚到上一版，本次产物保留供排查
if [ -n "$HEALTHCHECK_URL" ]; then
  log "健康检查：$HEALTHCHECK_URL"
  if ! curl -fsS --max-time 10 "$HEALTHCHECK_URL" >/dev/null; then
    if [ -n "$PREVIOUS_TARGET" ] && [ -d "$PREVIOUS_TARGET" ]; then
      ln -sfn "$PREVIOUS_TARGET" "$CURRENT_LINK.staging"
      mv -T "$CURRENT_LINK.staging" "$CURRENT_LINK"
      fail "健康检查失败，已回滚到 $PREVIOUS_TARGET（新版本保留在 $RELEASE_DIR）"
    fi
    fail "健康检查失败，且没有可回滚的上一版"
  fi
fi

# 6. 清理旧版本：保留最近 KEEP_RELEASES 个；current 指向的版本永不删除
CURRENT_TARGET="$(readlink -f "$CURRENT_LINK" || true)"
count=0
for dir in $(ls -1d "$RELEASES_DIR"/[0-9]* 2>/dev/null | sort -r); do
  count=$((count + 1))
  if [ "$count" -le "$KEEP_RELEASES" ]; then continue; fi
  if [ "$(readlink -f "$dir")" = "$CURRENT_TARGET" ]; then continue; fi
  rm -rf "$dir"
  log "已清理旧版本：$dir"
done

log "发布完成。回滚方法：ln -sfn <旧版本目录> $CURRENT_LINK.staging && mv -T $CURRENT_LINK.staging $CURRENT_LINK"
