import test from "node:test";
import assert from "node:assert/strict";
import {
  AVATAR_MAX_FILE_BYTES,
  deleteMyAvatar,
  extractAvatarApiError,
  fileToBase64Payload,
  stripDataUrlBase64,
  uploadMyAvatar,
  validateAvatarFile,
} from "./avatar-api.js";

const PNG_FILE = { type: "image/png", size: 1024, name: "avatar.png" };

function makeReaderFactory({ result, fail = false } = {}) {
  return () => ({
    onload: null,
    onerror: null,
    result: null,
    readAsDataURL(file) {
      queueMicrotask(() => {
        if (fail) {
          this.onerror?.(new Error("read failed"));
          return;
        }
        this.result =
          result ?? `data:${file.type};base64,QUJDREVGRw==`;
        this.onload?.();
      });
    },
  });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json; charset=utf-8" },
    json: async () => body,
  };
}

test("jpg / png / webp 文件类型通过校验", () => {
  for (const type of ["image/jpeg", "image/png", "image/webp"]) {
    assert.equal(validateAvatarFile({ type, size: 100 }).ok, true);
  }
});

test("gif / svg / pdf 等类型被拒绝并给出中文错误", () => {
  for (const type of ["image/gif", "image/svg+xml", "application/pdf", "", undefined]) {
    const result = validateAvatarFile({ type, size: 100 });
    assert.equal(result.error, "请选择 JPG、PNG 或 WebP 图片");
  }
  assert.equal(validateAvatarFile(null).error, "请选择要上传的头像图片");
});

test("超过 2MB 被拒绝", () => {
  const result = validateAvatarFile({
    type: "image/png",
    size: AVATAR_MAX_FILE_BYTES + 1,
  });
  assert.equal(result.error, "头像文件不能超过 2MB");
  assert.equal(
    validateAvatarFile({ type: "image/png", size: AVATAR_MAX_FILE_BYTES }).ok,
    true
  );
  assert.equal(validateAvatarFile({ type: "image/png", size: 0 }).error, "头像文件不能为空");
});

test("data URL 前缀能正确剥离", () => {
  assert.equal(stripDataUrlBase64("data:image/png;base64,QUJD"), "QUJD");
  assert.equal(stripDataUrlBase64("data:image/webp;base64,eHl6"), "eHl6");
  assert.equal(stripDataUrlBase64("QUJD"), "");
  assert.equal(stripDataUrlBase64("data:image/png,plain"), "");
  assert.equal(stripDataUrlBase64(null), "");
});

test("fileToBase64Payload 返回 imageBase64 与 mimeType", async () => {
  const payload = await fileToBase64Payload(PNG_FILE, {
    readerFactory: makeReaderFactory(),
  });
  assert.equal(payload.imageBase64, "QUJDREVGRw==");
  assert.equal(payload.mimeType, "image/png");
});

test("FileReader 失败返回中文错误", async () => {
  await assert.rejects(
    fileToBase64Payload(PNG_FILE, { readerFactory: makeReaderFactory({ fail: true }) }),
    /读取头像文件失败/
  );
  await assert.rejects(
    fileToBase64Payload(PNG_FILE, {
      readerFactory: makeReaderFactory({ result: "not-a-data-url" }),
    }),
    /读取头像文件失败/
  );
});

test("uploadMyAvatar 发送正确 JSON 且成功返回 user", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, {
      success: true,
      user: { displayName: "ADMIN01", avatarUrl: "/uploads/avatars/new.png" },
    });
  };
  const user = await uploadMyAvatar("", PNG_FILE, {
    fetchImpl,
    readerFactory: makeReaderFactory(),
  });
  assert.equal(user.avatarUrl, "/uploads/avatars/new.png");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/me/avatar");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, { imageBase64: "QUJDREVGRw==", mimeType: "image/png" });
});

test("deleteMyAvatar 发送 DELETE 并返回 user", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, { success: true, user: { avatarUrl: null } });
  };
  const user = await deleteMyAvatar("https://voice.example", { fetchImpl });
  assert.equal(user.avatarUrl, null);
  assert.equal(calls[0].url, "https://voice.example/api/me/avatar");
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[0].options.credentials, "include");
});

test("401 / 403 / 413 错误能提取中文提示", async () => {
  assert.equal(
    await extractAvatarApiError(jsonResponse(403, { error: "该功能仅限正式战队成员" })),
    "该功能仅限正式战队成员"
  );
  assert.equal(
    await extractAvatarApiError(jsonResponse(413, { error: "头像文件不能超过 2MB" })),
    "头像文件不能超过 2MB"
  );
  // 后端没给 JSON error 时按状态码兜底
  const plain = (status) => ({
    ok: false,
    status,
    headers: { get: () => "text/plain" },
    json: async () => { throw new Error("not json"); },
  });
  assert.equal(await extractAvatarApiError(plain(401)), "登录状态已失效，请重新登录");
  assert.equal(await extractAvatarApiError(plain(403)), "当前账号不能上传头像");
  assert.equal(await extractAvatarApiError(plain(413)), "头像文件不能超过 2MB");
  assert.equal(await extractAvatarApiError(plain(500)), "头像上传失败，请稍后重试");
});

test("上传失败会抛出后端中文错误", async () => {
  const fetchImpl = async () => jsonResponse(403, { error: "该功能仅限正式战队成员" });
  await assert.rejects(
    uploadMyAvatar("", PNG_FILE, { fetchImpl, readerFactory: makeReaderFactory() }),
    /该功能仅限正式战队成员/
  );
});

test("网络错误返回中文提示", async () => {
  const fetchImpl = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(
    uploadMyAvatar("", PNG_FILE, { fetchImpl, readerFactory: makeReaderFactory() }),
    /网络连接失败/
  );
  await assert.rejects(deleteMyAvatar("", { fetchImpl }), /网络连接失败/);
});

test("响应缺少 user 时报数据异常", async () => {
  const fetchImpl = async () => jsonResponse(200, { success: true });
  await assert.rejects(
    uploadMyAvatar("", PNG_FILE, { fetchImpl, readerFactory: makeReaderFactory() }),
    /头像接口返回数据异常/
  );
});

test("上传流程不把 base64 写入 localStorage", async () => {
  const writes = [];
  const originalLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    setItem: (...args) => writes.push(args),
    getItem: () => null,
    removeItem: () => {},
  };
  try {
    const fetchImpl = async () =>
      jsonResponse(200, { success: true, user: { avatarUrl: "/uploads/avatars/x.png" } });
    await uploadMyAvatar("", PNG_FILE, {
      fetchImpl,
      readerFactory: makeReaderFactory(),
    });
    assert.equal(writes.length, 0);
  } finally {
    if (originalLocalStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = originalLocalStorage;
    }
  }
});
