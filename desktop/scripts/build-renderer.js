#!/usr/bin/env node
/**
 * 桌面渲染层打包脚本：
 * 1. 读取 desktop/app-config.json 里的 backendOrigin（后端地址唯一切换点）；
 * 2. 以 VITE_API_BASE=<backendOrigin> + --base=./ 运行 client 的 vite build，
 *    产出可被 file:// 加载的相对路径静态包；
 * 3. 把 client/dist 复制到 desktop/renderer/ 供 electron-builder 打进安装包；
 * 4. 做产物自检：资源引用必须是相对路径、bundle 里必须真的带上了后端地址。
 *
 * 备案后迁移 ECS：只改 app-config.json 的 backendOrigin
 * （如 https://voice.novagaming.top），重新 npm run dist 即可，无需改任何代码。
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopDir = path.join(__dirname, "..");
const repoRoot = path.join(desktopDir, "..");
const clientDir = path.join(repoRoot, "client");
const distDir = path.join(clientDir, "dist");
const rendererDir = path.join(desktopDir, "renderer");
const configPath = path.join(desktopDir, "app-config.json");

function fail(message) {
  console.error(`\n[NovaSpeak 打包] 失败：${message}\n`);
  process.exit(1);
}

function loadBackendOrigin() {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    fail(`读不到 ${configPath}，请先创建 app-config.json（含 backendOrigin 字段）`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("app-config.json 不是合法 JSON");
  }
  const value = parsed?.backendOrigin;
  if (typeof value !== "string" || !value.trim()) {
    fail("app-config.json 缺少 backendOrigin 字符串字段");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    fail(`backendOrigin 不是合法 URL：${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail(`backendOrigin 只支持 http(s)，当前为：${url.protocol}`);
  }
  if (url.protocol === "http:") {
    console.warn(
      "[NovaSpeak 打包] 警告：backendOrigin 是 http。打包版登录依赖 SameSite=None + Secure Cookie，" +
        "非 https 后端在正式环境无法保持登录，仅限本机调试。"
    );
  }
  return url.origin;
}

function runViteBuild(backendOrigin) {
  const viteBin = path.join(clientDir, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteBin)) {
    fail("client/node_modules 里找不到 vite，请先在 client 目录运行 npm install");
  }
  console.log(`[NovaSpeak 打包] 后端地址（唯一切换点 desktop/app-config.json）：${backendOrigin}`);
  console.log("[NovaSpeak 打包] 运行 vite build（VITE_API_BASE 注入 + --base=./ 相对路径）…");
  const result = spawnSync(process.execPath, [viteBin, "build", "--base", "./"], {
    cwd: clientDir,
    stdio: "inherit",
    env: { ...process.env, VITE_API_BASE: backendOrigin },
  });
  if (result.status !== 0) {
    fail(`vite build 退出码 ${result.status ?? "未知"}`);
  }
}

function verifyDist(backendOrigin) {
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    fail("vite build 没有产出 client/dist/index.html");
  }
  const indexHtml = fs.readFileSync(indexPath, "utf8");
  if (/(?:src|href)="\/(?!\/)/.test(indexHtml)) {
    fail("dist/index.html 仍包含以 / 开头的绝对资源路径，file:// 下会加载失败（--base=./ 未生效？）");
  }

  const assetsDir = path.join(distDir, "assets");
  const jsFiles = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((name) => name.endsWith(".js"))
    : [];
  if (jsFiles.length === 0) {
    fail("dist/assets 里没有 JS 产物");
  }
  const originFound = jsFiles.some((name) =>
    fs.readFileSync(path.join(assetsDir, name), "utf8").includes(backendOrigin)
  );
  if (!originFound) {
    fail(`bundle 里找不到 ${backendOrigin}，VITE_API_BASE 可能没有注入成功`);
  }
  console.log(`[NovaSpeak 打包] 产物自检通过：相对路径资源 + bundle 已包含 ${backendOrigin}`);
}

function stageRenderer() {
  fs.rmSync(rendererDir, { recursive: true, force: true });
  fs.cpSync(distDir, rendererDir, { recursive: true });
  console.log(`[NovaSpeak 打包] 已复制 client/dist -> ${rendererDir}`);
}

const backendOrigin = loadBackendOrigin();
runViteBuild(backendOrigin);
verifyDist(backendOrigin);
stageRenderer();
console.log("[NovaSpeak 打包] 渲染层就绪，可继续 electron-builder 出安装包。");
