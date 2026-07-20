const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PROD_APP_URL,
  classifyMainWindowNavigation,
} = require("./main-window-policy");

test("生产桌面壳固定加载 NovaSpeak HTTPS 地址", () => {
  assert.equal(PROD_APP_URL, "https://voice.novagaming.top");
});

test("同源路径、查询与 hash 导航允许留在主窗口", () => {
  assert.equal(
    classifyMainWindowNavigation(
      "https://voice.novagaming.top/channels?id=1#voice",
      PROD_APP_URL
    ),
    "allow"
  );
});

test("开发模式只允许 localhost Vite 同源导航", () => {
  assert.equal(
    classifyMainWindowNavigation(
      "http://localhost:5173/login",
      "http://localhost:5173"
    ),
    "allow"
  );
});

test("第三方 HTTP(S) 地址交给系统浏览器", () => {
  assert.equal(
    classifyMainWindowNavigation("https://music.163.com/", PROD_APP_URL),
    "external"
  );
  assert.equal(
    classifyMainWindowNavigation("http://example.com/", PROD_APP_URL),
    "external"
  );
});

test("危险协议、带凭据 URL 与畸形 URL 被拒绝", () => {
  for (const url of [
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "data:text/html,test",
    "https://user:pass@voice.novagaming.top/",
    "not a url",
  ]) {
    assert.equal(classifyMainWindowNavigation(url, PROD_APP_URL), "deny");
  }
});
