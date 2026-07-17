const DEFAULT_INITIAL_DELAY_MS = 15_000;
const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const UPDATE_FEED_URL = "https://app.novagaming.top/desktop-updates/";

function isPortableEnvironment(env = process.env) {
  return Boolean(env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR);
}

function shouldEnableAutoUpdates({ isPackaged, platform = process.platform, env = process.env } = {}) {
  return Boolean(isPackaged) && platform === "win32" && !isPortableEnvironment(env);
}

function safeUpdateVersion(info) {
  const version = typeof info?.version === "string" ? info.version.trim() : "";
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version) ? version : "新版本";
}

function safeUpdateError(error) {
  return {
    name: typeof error?.name === "string" ? error.name.slice(0, 80) : "Error",
    code: typeof error?.code === "string" ? error.code.slice(0, 80) : "UPDATE_FAILED",
  };
}

function showUpdateDialog(dialog, getMainWindow, options) {
  const parent = getMainWindow?.();
  if (parent && !parent.isDestroyed?.()) return dialog.showMessageBox(parent, options);
  return dialog.showMessageBox(options);
}

function startAutoUpdates({
  app,
  dialog,
  getMainWindow,
  updaterFactory = () => require("electron-updater").autoUpdater,
  logger = console,
  env = process.env,
  platform = process.platform,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  timers = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  },
} = {}) {
  if (!shouldEnableAutoUpdates({ isPackaged: app?.isPackaged, platform, env })) {
    return { enabled: false, stop() {} };
  }

  let updater;
  try {
    updater = updaterFactory();
    if (typeof updater?.setFeedURL !== "function") {
      const error = new Error("Updater provider unavailable");
      error.code = "UPDATE_PROVIDER_UNAVAILABLE";
      throw error;
    }
    updater.setFeedURL({ provider: "generic", url: UPDATE_FEED_URL });
  } catch (error) {
    logger.error?.("[NovaSpeak updater] unavailable", safeUpdateError(error));
    return { enabled: false, stop() {} };
  }

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.allowDowngrade = false;

  let stopped = false;
  let checking = false;
  let downloadPromptOpen = false;
  let downloadedPromptOpen = false;
  let downloading = false;

  const setProgress = (value) => {
    const win = getMainWindow?.();
    if (win && !win.isDestroyed?.()) win.setProgressBar?.(value);
  };

  const logFailure = (phase, error) => {
    logger.error?.(`[NovaSpeak updater] ${phase}`, safeUpdateError(error));
  };

  const check = async () => {
    if (stopped || checking || downloading) return;
    checking = true;
    try {
      await updater.checkForUpdates();
    } catch (error) {
      logFailure("check-failed", error);
    } finally {
      checking = false;
    }
  };

  const onUpdateAvailable = async (info) => {
    if (stopped || downloadPromptOpen || downloading) return;
    downloadPromptOpen = true;
    try {
      const result = await showUpdateDialog(dialog, getMainWindow, {
        type: "info",
        title: "NovaSpeak 更新",
        message: `发现 NovaSpeak ${safeUpdateVersion(info)}`,
        detail: "是否现在下载更新？下载期间可以继续使用语音功能。",
        buttons: ["下载更新", "稍后"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (stopped || result?.response !== 0) return;
      downloading = true;
      await updater.downloadUpdate();
    } catch (error) {
      downloading = false;
      setProgress(-1);
      logFailure("download-failed", error);
    } finally {
      downloadPromptOpen = false;
    }
  };

  const onDownloadProgress = (progress) => {
    if (stopped) return;
    const percent = Number(progress?.percent);
    setProgress(Number.isFinite(percent) ? Math.max(0, Math.min(1, percent / 100)) : 2);
  };

  const onUpdateDownloaded = async (info) => {
    if (stopped || downloadedPromptOpen) return;
    downloading = false;
    downloadedPromptOpen = true;
    setProgress(-1);
    try {
      const result = await showUpdateDialog(dialog, getMainWindow, {
        type: "info",
        title: "NovaSpeak 更新已就绪",
        message: `NovaSpeak ${safeUpdateVersion(info)} 已下载完成`,
        detail: "立即重启会退出当前语音频道并安装更新；也可以等关闭 NovaSpeak 时自动安装。",
        buttons: ["立即重启并更新", "退出时安装"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (!stopped && result?.response === 0) updater.quitAndInstall(false, true);
    } catch (error) {
      logFailure("install-prompt-failed", error);
    } finally {
      downloadedPromptOpen = false;
    }
  };

  const onError = (error) => {
    downloading = false;
    setProgress(-1);
    logFailure("update-error", error);
  };

  updater.on("update-available", onUpdateAvailable);
  updater.on("download-progress", onDownloadProgress);
  updater.on("update-downloaded", onUpdateDownloaded);
  updater.on("error", onError);

  const initialTimer = timers.setTimeout(check, initialDelayMs);
  initialTimer?.unref?.();
  const intervalTimer = timers.setInterval(check, checkIntervalMs);
  intervalTimer?.unref?.();

  return {
    enabled: true,
    check,
    stop() {
      if (stopped) return;
      stopped = true;
      timers.clearTimeout(initialTimer);
      timers.clearInterval(intervalTimer);
      setProgress(-1);
      updater.off("update-available", onUpdateAvailable);
      updater.off("download-progress", onDownloadProgress);
      updater.off("update-downloaded", onUpdateDownloaded);
      updater.off("error", onError);
    },
  };
}

module.exports = {
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
  UPDATE_FEED_URL,
  isPortableEnvironment,
  safeUpdateError,
  safeUpdateVersion,
  shouldEnableAutoUpdates,
  startAutoUpdates,
};
