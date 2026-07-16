import test from "node:test";
import assert from "node:assert/strict";
import {
  NETEASE_COOKIE_ERROR,
  normalizeNeteaseCookie,
} from "./netease-cookie.js";

test("Cookie 字符串可规范化为标准请求头", () => {
  const result = normalizeNeteaseCookie(
    "MUSIC_U=abc123; os=pc; appver=8.9.75"
  );
  assert.equal(result.ok, true);
  assert.equal(result.cookieHeader, "MUSIC_U=abc123; os=pc; appver=8.9.75");
});

test("Electron cookies.get() 对象数组可规范化", () => {
  const result = normalizeNeteaseCookie([
    { name: "MUSIC_U", value: "token-value" },
    { name: "__csrf", value: "csrf-value" },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.cookieHeader, "MUSIC_U=token-value; __csrf=csrf-value");
});

test("Electron 数组中的额外字段（domain/path 等）被忽略", () => {
  const result = normalizeNeteaseCookie([
    {
      name: "MUSIC_U",
      value: "v1",
      domain: ".music.163.com",
      path: "/",
      httpOnly: true,
    },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.cookieHeader, "MUSIC_U=v1");
});

test("缺少 MUSIC_U 时拒绝并返回稳定错误码", () => {
  const fromString = normalizeNeteaseCookie("os=pc; appver=8.9.75");
  assert.equal(fromString.ok, false);
  assert.equal(fromString.code, NETEASE_COOKIE_ERROR.MUSIC_U_MISSING);

  const fromArray = normalizeNeteaseCookie([{ name: "os", value: "pc" }]);
  assert.equal(fromArray.ok, false);
  assert.equal(fromArray.code, NETEASE_COOKIE_ERROR.MUSIC_U_MISSING);
});

test("MUSIC_U 为空值时同样拒绝", () => {
  const result = normalizeNeteaseCookie("MUSIC_U=; os=pc");
  assert.equal(result.ok, false);
  assert.equal(result.code, NETEASE_COOKIE_ERROR.MUSIC_U_MISSING);
});

test("重复 Cookie 保留最后一次出现的值", () => {
  const result = normalizeNeteaseCookie(
    "MUSIC_U=old-token; os=pc; MUSIC_U=new-token"
  );
  assert.equal(result.ok, true);
  // 同名 Cookie 值取最后一次出现，位置保持首次出现的顺序
  assert.equal(result.cookieHeader, "MUSIC_U=new-token; os=pc");
  assert.ok(!result.cookieHeader.includes("old-token"));
});

test("非法 Cookie 名和值被过滤", () => {
  const result = normalizeNeteaseCookie([
    { name: "MUSIC_U", value: "good-token" },
    { name: "bad name", value: "x" },
    { name: "bad;semi", value: "x" },
    { name: "ok", value: "has space" },
    { name: "ctrl", value: "line\nbreak" },
    { name: "", value: "x" },
    { name: "notstring", value: 123 },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.cookieHeader, "MUSIC_U=good-token");
});

test("空输入与非法类型输入被拒绝", () => {
  for (const input of ["", "   ", null, undefined, 42, {}, []]) {
    const result = normalizeNeteaseCookie(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, NETEASE_COOKIE_ERROR.INVALID_INPUT);
  }
});

test("双引号包裹的 Cookie 值会被去引号", () => {
  const result = normalizeNeteaseCookie('MUSIC_U="quoted-token"');
  assert.equal(result.ok, true);
  assert.equal(result.cookieHeader, "MUSIC_U=quoted-token");
});

test("超长 Cookie 值被过滤", () => {
  const result = normalizeNeteaseCookie([
    { name: "MUSIC_U", value: "a".repeat(5000) },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, NETEASE_COOKIE_ERROR.INVALID_INPUT);
});
