// 头像上传 / 删除 API 工具：不依赖 npm 包，可注入 fetch / FileReader 便于测试。
// 注意：不把图片 base64 写入 localStorage，也不打印到 console。

export const AVATAR_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

export const AVATAR_MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * 前端基础校验：类型必须是 JPG/PNG/WebP，大小不超过 2MB。
 */
export function validateAvatarFile(file) {
  if (!file || typeof file !== "object") {
    return { error: "请选择要上传的头像图片" };
  }
  if (!AVATAR_ALLOWED_MIME_TYPES.includes(file.type)) {
    return { error: "请选择 JPG、PNG 或 WebP 图片" };
  }
  if (typeof file.size !== "number" || Number.isNaN(file.size)) {
    return { error: "无法读取头像文件大小" };
  }
  if (file.size <= 0) {
    return { error: "头像文件不能为空" };
  }
  if (file.size > AVATAR_MAX_FILE_BYTES) {
    return { error: "头像文件不能超过 2MB" };
  }
  return { ok: true };
}

/**
 * 从 FileReader 的 data URL 结果中取出纯 base64；异常输入返回空字符串。
 */
export function stripDataUrlBase64(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return "";
  const marker = ";base64,";
  const markerIndex = dataUrl.indexOf(marker);
  if (markerIndex < 0) return "";
  const base64 = dataUrl.slice(markerIndex + marker.length);
  return base64 || "";
}

/**
 * 读取文件为 { imageBase64, mimeType }。校验失败或读取失败时 reject 中文错误。
 * readerFactory 用于测试注入假 FileReader。
 */
export function fileToBase64Payload(file, { readerFactory } = {}) {
  const validation = validateAvatarFile(file);
  if (validation.error) {
    return Promise.reject(new Error(validation.error));
  }
  return new Promise((resolve, reject) => {
    let reader;
    try {
      reader = readerFactory ? readerFactory() : new FileReader();
    } catch {
      reject(new Error("当前浏览器不支持读取图片"));
      return;
    }
    reader.onload = () => {
      const imageBase64 = stripDataUrlBase64(reader.result);
      if (!imageBase64) {
        reject(new Error("读取头像文件失败，请重新选择图片"));
        return;
      }
      resolve({ imageBase64, mimeType: file.type });
    };
    reader.onerror = () => {
      reject(new Error("读取头像文件失败，请重新选择图片"));
    };
    try {
      reader.readAsDataURL(file);
    } catch {
      reject(new Error("读取头像文件失败，请重新选择图片"));
    }
  });
}

/**
 * 从失败响应中提取中文错误：优先后端 JSON error，否则按状态码兜底。
 */
export async function extractAvatarApiError(response, fallback = "头像上传失败，请稍后重试") {
  let message = "";
  try {
    const contentType = response?.headers?.get?.("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      if (typeof data?.error === "string" && data.error.trim()) {
        message = data.error.trim();
      }
    }
  } catch {
    message = "";
  }
  if (message) return message;
  const status = response?.status;
  if (status === 401) return "登录状态已失效，请重新登录";
  if (status === 403) return "当前账号不能上传头像";
  if (status === 413) return "头像文件不能超过 2MB";
  if (status === 400) return "头像文件无效，请重新选择";
  return fallback;
}

async function requestAvatarApi(apiBase, options, { fetchImpl, fallbackError }) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  let response;
  try {
    response = await doFetch(`${apiBase}/api/me/avatar`, {
      credentials: "include",
      ...options,
    });
  } catch {
    throw new Error("网络连接失败，请稍后重试");
  }
  if (!response.ok) {
    throw new Error(await extractAvatarApiError(response, fallbackError));
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object" || !data.user || typeof data.user !== "object") {
    throw new Error("头像接口返回数据异常");
  }
  return data.user;
}

/**
 * 上传当前用户头像，成功返回后端的公开 user 对象（含 avatarUrl）。
 */
export async function uploadMyAvatar(apiBase, file, { fetchImpl, readerFactory } = {}) {
  const payload = await fileToBase64Payload(file, { readerFactory });
  return requestAvatarApi(apiBase, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, {
    fetchImpl,
    fallbackError: "头像上传失败，请稍后重试",
  });
}

/**
 * 删除当前用户头像，成功返回后端的公开 user 对象（avatarUrl 为 null）。
 */
export async function deleteMyAvatar(apiBase, { fetchImpl } = {}) {
  return requestAvatarApi(apiBase, {
    method: "DELETE",
  }, {
    fetchImpl,
    fallbackError: "头像删除失败，请稍后重试",
  });
}
