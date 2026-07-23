import test from "node:test";
import assert from "node:assert/strict";
import {
  findAvatarUrlByDisplayName,
  getAvatarInitial,
  getAvatarUploadUiModel,
  normalizeAvatarUrl,
  resolveParticipantAvatarUrl,
  shouldShowAvatarImage,
} from "./avatar.js";

test("中文名取第一个汉字", () => {
  assert.equal(getAvatarInitial("陈小明"), "陈");
  assert.equal(getAvatarInitial("　陈小明"), "陈");
});

test("英文名取大写首字母", () => {
  assert.equal(getAvatarInitial("chillily"), "C");
  assert.equal(getAvatarInitial("  player01"), "P");
  assert.equal(getAvatarInitial("X"), "X");
});

test("空名称与非字符串返回 ?", () => {
  assert.equal(getAvatarInitial(""), "?");
  assert.equal(getAvatarInitial("   "), "?");
  assert.equal(getAvatarInitial(null), "?");
  assert.equal(getAvatarInitial(undefined), "?");
  assert.equal(getAvatarInitial(123), "?");
});

test("emoji 等代理对字符取完整第一个字符", () => {
  assert.equal(getAvatarInitial("🐯战队"), "🐯");
});

test("avatarUrl 为空或非字符串时 fallback 到首字母", () => {
  assert.equal(normalizeAvatarUrl(null), null);
  assert.equal(normalizeAvatarUrl(undefined), null);
  assert.equal(normalizeAvatarUrl(""), null);
  assert.equal(normalizeAvatarUrl(42), null);
  assert.equal(normalizeAvatarUrl({}), null);
  assert.equal(shouldShowAvatarImage(null), false);
  assert.equal(shouldShowAvatarImage(""), false);
});

test("normalizeAvatarUrl 保留 /uploads/avatars/ 相对路径", () => {
  assert.equal(
    normalizeAvatarUrl("/uploads/avatars/abc123.png"),
    "/uploads/avatars/abc123.png"
  );
  assert.equal(
    normalizeAvatarUrl("  /uploads/avatars/abc123.webp  "),
    "/uploads/avatars/abc123.webp"
  );
  assert.equal(shouldShowAvatarImage("/uploads/avatars/abc123.jpg"), true);
});

test("normalizeAvatarUrl 拒绝危险路径", () => {
  assert.equal(normalizeAvatarUrl("javascript:alert(1)"), null);
  assert.equal(normalizeAvatarUrl("data:image/png;base64,AAAA"), null);
  assert.equal(normalizeAvatarUrl("//evil.example/x.png"), null);
  assert.equal(normalizeAvatarUrl("http://evil.example/x.png"), null);
  assert.equal(normalizeAvatarUrl("/uploads/av atars/x.png"), null);
  assert.equal(normalizeAvatarUrl("/uploads\\avatars\\x.png"), null);
});

test("图片加载失败后可标记 fallback（同一 URL 不再当作可展示）", () => {
  const url = normalizeAvatarUrl("/uploads/avatars/broken.png");
  let failedUrl = "";
  const showImage = () => Boolean(url) && url !== failedUrl;
  assert.equal(showImage(), true);
  failedUrl = url; // 模拟 onError 记录失败地址
  assert.equal(showImage(), false);
  const newUrl = normalizeAvatarUrl("/uploads/avatars/new.png");
  assert.equal(Boolean(newUrl) && newUrl !== failedUrl, true);
});

test("Presence 在线成员按昵称匹配头像", () => {
  const members = [
    { nickname: "ADMIN01", avatarUrl: "/uploads/avatars/a.png" },
    { nickname: "PLAYER01", avatarUrl: null },
  ];
  assert.equal(
    findAvatarUrlByDisplayName(members, "ADMIN01"),
    "/uploads/avatars/a.png"
  );
  assert.equal(findAvatarUrlByDisplayName(members, "PLAYER01"), null);
  assert.equal(findAvatarUrlByDisplayName(members, "NOBODY"), null);
  assert.equal(findAvatarUrlByDisplayName(members, ""), null);
  assert.equal(findAvatarUrlByDisplayName(null, "ADMIN01"), null);
});

test("频道成员卡片：本人用 currentUser，其余用在线成员数据", () => {
  const onlineMembers = [
    { nickname: "PLAYER01", avatarUrl: "/uploads/avatars/p.webp" },
  ];
  assert.equal(
    resolveParticipantAvatarUrl({
      isLocal: true,
      displayName: "ADMIN01",
      currentUser: { avatarUrl: "/uploads/avatars/me.png" },
      onlineMembers,
    }),
    "/uploads/avatars/me.png"
  );
  assert.equal(
    resolveParticipantAvatarUrl({
      isLocal: false,
      displayName: "PLAYER01",
      currentUser: { avatarUrl: "/uploads/avatars/me.png" },
      onlineMembers,
    }),
    "/uploads/avatars/p.webp"
  );
  assert.equal(
    resolveParticipantAvatarUrl({
      isLocal: false,
      displayName: "GHOST",
      onlineMembers,
    }),
    null
  );
  assert.equal(resolveParticipantAvatarUrl(), null);
});

test("正式账号可上传，Guest 不显示上传入口", () => {
  assert.equal(getAvatarUploadUiModel({ role: "admin" }).showUploadEntry, true);
  assert.equal(getAvatarUploadUiModel({ role: "member" }).showUploadEntry, true);
  assert.equal(getAvatarUploadUiModel({ role: "user" }).showUploadEntry, true);
  assert.equal(getAvatarUploadUiModel({ role: "guest" }).showUploadEntry, false);
  assert.equal(getAvatarUploadUiModel({ role: "guest" }).canUpload, false);
  assert.equal(getAvatarUploadUiModel({}).showUploadEntry, false);
});

test("删除按钮仅在已有头像时显示", () => {
  assert.equal(
    getAvatarUploadUiModel({ role: "member", avatarUrl: "/uploads/avatars/x.png" }).showDeleteEntry,
    true
  );
  assert.equal(
    getAvatarUploadUiModel({ role: "member", avatarUrl: null }).showDeleteEntry,
    false
  );
  assert.equal(
    getAvatarUploadUiModel({ role: "guest", avatarUrl: "/uploads/avatars/x.png" }).showDeleteEntry,
    false
  );
});

test("上传中禁用按钮", () => {
  assert.equal(
    getAvatarUploadUiModel({ role: "member", uploading: true }).actionsDisabled,
    true
  );
  assert.equal(
    getAvatarUploadUiModel({ role: "member", uploading: false }).actionsDisabled,
    false
  );
});

test("无头像时展示首字母模型", () => {
  const model = getAvatarUploadUiModel({ role: "member", avatarUrl: null });
  assert.equal(model.hasAvatar, false);
  assert.equal(shouldShowAvatarImage(null), false);
  assert.equal(getAvatarInitial("小明"), "小");
});
