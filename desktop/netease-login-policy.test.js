const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NETEASE_LOGIN_URL,
  NETEASE_COOKIE_WHITELIST,
  filterNeteaseCookies,
  hasMusicU,
  isAllowedTopLevelNavigation,
  isNeteaseCookieDomain,
} = require("./netease-login-policy");

// 测试中一律使用假 Cookie 值，绝不出现真实凭据

test("登录 URL 是网易云官方 HTTPS 登录入口", () => {
  assert.ok(NETEASE_LOGIN_URL.startsWith("https://music.163.com/"));
  assert.ok(isAllowedTopLevelNavigation(NETEASE_LOGIN_URL));
});

test("music.163.com 及其合法子域的 HTTPS 顶层导航允许", () => {
  for (const url of [
    "https://music.163.com/",
    "https://music.163.com/#/login",
    "https://y.music.163.com/m/login",
    "https://st.music.163.com/some/page",
  ]) {
    assert.equal(isAllowedTopLevelNavigation(url), true, url);
  }
});

test("evil-music.163.com 之类的后缀欺骗被拒绝", () => {
  for (const url of [
    "https://evil-music.163.com/",
    "https://notmusic.163.com/",
    "https://music.163.com.evil.com/",
    "https://xmusic.163.com/",
  ]) {
    assert.equal(isAllowedTopLevelNavigation(url), false, url);
  }
});

test("非 HTTPS 顶层导航被拒绝", () => {
  for (const url of [
    "http://music.163.com/",
    "ftp://music.163.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ]) {
    assert.equal(isAllowedTopLevelNavigation(url), false, url);
  }
});

test("非网易云域和畸形 URL 被拒绝", () => {
  for (const url of [
    "https://example.com/",
    "https://163.com.evil.net/",
    "not-a-url",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isAllowedTopLevelNavigation(url), false, String(url));
  }
});

test("大小写与尾部点变体不能绕过导航校验", () => {
  assert.equal(
    isAllowedTopLevelNavigation("https://MUSIC.163.COM/#/login"),
    true
  );
  assert.equal(
    isAllowedTopLevelNavigation("https://evil-MUSIC.163.com/"),
    false
  );
});

test("Cookie domain 校验：正确处理前导点", () => {
  for (const domain of [
    "music.163.com",
    ".music.163.com",
    ".163.com",
    "163.com",
    "interface.music.163.com",
  ]) {
    assert.equal(isNeteaseCookieDomain(domain), true, domain);
  }
  for (const domain of [
    "evil163.com",
    ".163.com.evil.net",
    "example.com",
    "",
    null,
  ]) {
    assert.equal(isNeteaseCookieDomain(domain), false, String(domain));
  }
});

test("Cookie 过滤：只保留白名单且只输出 name/value", () => {
  const filtered = filterNeteaseCookies([
    { name: "MUSIC_U", value: "fake-music-u", domain: ".music.163.com", path: "/", expirationDate: 123 },
    { name: "__csrf", value: "fake-csrf", domain: ".music.163.com" },
    { name: "NMTID", value: "fake-nmtid", domain: ".163.com" },
    { name: "os", value: "pc", domain: "music.163.com" },
    // 白名单外的 Cookie 被丢弃
    { name: "JSESSIONID-WYYY", value: "dropme", domain: ".music.163.com" },
    { name: "_iuqxldmzr_", value: "dropme", domain: ".music.163.com" },
  ]);

  assert.deepEqual(
    filtered.map((cookie) => cookie.name).sort(),
    ["MUSIC_U", "NMTID", "__csrf", "os"]
  );
  for (const cookie of filtered) {
    assert.deepEqual(Object.keys(cookie).sort(), ["name", "value"]);
  }
});

test("非网易云 domain 的白名单 Cookie 也被丢弃", () => {
  const filtered = filterNeteaseCookies([
    { name: "MUSIC_U", value: "stolen", domain: "evil.example.com" },
    { name: "os", value: "pc", domain: "evil163.com" },
  ]);
  assert.deepEqual(filtered, []);
});

test("空值与畸形 Cookie 条目被丢弃", () => {
  const filtered = filterNeteaseCookies([
    { name: "MUSIC_U", value: "", domain: ".music.163.com" },
    { name: "os", domain: ".music.163.com" },
    { value: "x", domain: ".music.163.com" },
    null,
    "string-entry",
    { name: 42, value: "x", domain: ".music.163.com" },
  ]);
  assert.deepEqual(filtered, []);
  assert.deepEqual(filterNeteaseCookies(null), []);
  assert.deepEqual(filterNeteaseCookies("not-array"), []);
});

test("重复 Cookie 保留最后一次出现的值", () => {
  const filtered = filterNeteaseCookies([
    { name: "MUSIC_U", value: "old-value", domain: ".music.163.com" },
    { name: "MUSIC_U", value: "new-value", domain: "music.163.com" },
  ]);
  assert.deepEqual(filtered, [{ name: "MUSIC_U", value: "new-value" }]);
});

test("缺少 MUSIC_U 不算登录成功", () => {
  const withoutMusicU = filterNeteaseCookies([
    { name: "__csrf", value: "fake-csrf", domain: ".music.163.com" },
    { name: "os", value: "pc", domain: ".music.163.com" },
  ]);
  assert.equal(hasMusicU(withoutMusicU), false);

  const withMusicU = filterNeteaseCookies([
    { name: "MUSIC_U", value: "fake-music-u", domain: ".music.163.com" },
  ]);
  assert.equal(hasMusicU(withMusicU), true);

  assert.equal(hasMusicU([]), false);
  assert.equal(hasMusicU(null), false);
  assert.equal(hasMusicU([{ name: "MUSIC_U", value: "" }]), false);
});

test("白名单包含最小必要 Cookie 集合", () => {
  for (const name of ["MUSIC_U", "__csrf", "NMTID", "MUSIC_A", "os", "appver", "channel"]) {
    assert.ok(NETEASE_COOKIE_WHITELIST.includes(name), name);
  }
});
