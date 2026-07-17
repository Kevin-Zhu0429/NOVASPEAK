const fs = require("node:fs/promises");
const path = require("node:path");

const desktopDirectory = path.resolve(__dirname, "..");
const sourceDirectory = path.join(desktopDirectory, "dist");
const targetDirectory = process.env.DESKTOP_UPDATE_DIR?.trim()
  ? path.resolve(process.env.DESKTOP_UPDATE_DIR.trim())
  : path.resolve(desktopDirectory, "..", "server", "data", "desktop-updates");

function isUpdateAsset(name) {
  return name === "latest.yml"
    || /-Setup\.exe$/i.test(name)
    || /-Setup\.exe\.blockmap$/i.test(name);
}

function getPublishOrder(assets) {
  return [
    ...assets.filter((name) => name !== "latest.yml"),
    "latest.yml",
  ];
}

async function main() {
  const names = await fs.readdir(sourceDirectory);
  const assets = names.filter(isUpdateAsset);
  if (!assets.includes("latest.yml")) {
    throw new Error("desktop/dist/latest.yml 不存在，请先运行 npm run dist:win");
  }
  if (!assets.some((name) => /-Setup\.exe$/i.test(name))) {
    throw new Error("desktop/dist 中没有安装版 EXE，请先运行 npm run dist:win");
  }

  await fs.mkdir(targetDirectory, { recursive: true });
  const publishOrder = getPublishOrder(assets);
  for (const name of publishOrder) {
    await fs.copyFile(path.join(sourceDirectory, name), path.join(targetDirectory, name));
  }
  console.log(`已发布 ${assets.length} 个自动更新文件到 ${targetDirectory}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || "发布自动更新文件失败");
    process.exitCode = 1;
  });
}

module.exports = { getPublishOrder, isUpdateAsset };
