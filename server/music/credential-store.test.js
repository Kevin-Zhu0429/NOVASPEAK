import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  decryptMusicCredential,
  encryptMusicCredential,
  isMusicCredentialConfigured,
  MUSIC_NOT_CONFIGURED,
  MusicConfigError,
  readMusicCredentialKey,
} from "./credential-store.js";

function makeEnv() {
  return {
    MUSIC_CREDENTIAL_KEY: crypto.randomBytes(32).toString("base64"),
  };
}

test("合法 32 字节 base64 密钥可以被读取", () => {
  const env = makeEnv();
  const key = readMusicCredentialKey(env);
  assert.ok(Buffer.isBuffer(key));
  assert.equal(key.length, 32);
  assert.equal(isMusicCredentialConfigured(env), true);
});

test("错误长度或非法密钥被拒绝", () => {
  const badEnvs = [
    {},
    { MUSIC_CREDENTIAL_KEY: "" },
    { MUSIC_CREDENTIAL_KEY: "   " },
    { MUSIC_CREDENTIAL_KEY: crypto.randomBytes(16).toString("base64") },
    { MUSIC_CREDENTIAL_KEY: crypto.randomBytes(31).toString("base64") },
    { MUSIC_CREDENTIAL_KEY: crypto.randomBytes(33).toString("base64") },
    { MUSIC_CREDENTIAL_KEY: "not-base64-at-all!!!" },
  ];
  for (const env of badEnvs) {
    assert.equal(readMusicCredentialKey(env), null);
    assert.equal(isMusicCredentialConfigured(env), false);
  }
});

test("严格 base64 校验：外层空白允许，其余非规范输入全部拒绝", () => {
  const validKey = crypto.randomBytes(32).toString("base64");
  assert.equal(validKey.length, 44);

  // 正确密钥通过，最外层空白先 trim
  assert.ok(readMusicCredentialKey({ MUSIC_CREDENTIAL_KEY: validKey }));
  assert.ok(
    readMusicCredentialKey({ MUSIC_CREDENTIAL_KEY: `  ${validKey}\n` })
  );

  const rejected = [
    // 有效密钥后追加垃圾字符
    `${validKey}!`,
    `${validKey}garbage`,
    `${validKey}AA==`,
    // 中间插入空格 / 换行 / 制表符
    `${validKey.slice(0, 20)} ${validKey.slice(20)}`,
    `${validKey.slice(0, 20)}\n${validKey.slice(20)}`,
    `${validKey.slice(0, 20)}\t${validKey.slice(20)}`,
    // 非法 padding：去掉、加倍或前移 =
    validKey.slice(0, 43),
    `${validKey.slice(0, 43)}==`,
    // 44 字符但 == 结尾：解码只有 31 字节，同样拒绝
    `${validKey.slice(0, 42)}==`,
    `=${validKey.slice(0, 43)}`,
  ];
  for (const bad of rejected) {
    assert.equal(
      readMusicCredentialKey({ MUSIC_CREDENTIAL_KEY: bad }),
      null,
      `应拒绝：${JSON.stringify(bad.slice(0, 12))}...`
    );
  }
});

test("URL-safe base64 变体不被意外接受", () => {
  // 0xfb 重复的 32 字节，标准 base64 一定包含 + 和 /
  const buffer = Buffer.alloc(32, 0xfb);
  const standard = buffer.toString("base64");
  assert.ok(standard.includes("+"));
  assert.ok(standard.includes("/"));
  assert.ok(readMusicCredentialKey({ MUSIC_CREDENTIAL_KEY: standard }));

  const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_");
  assert.equal(
    readMusicCredentialKey({ MUSIC_CREDENTIAL_KEY: urlSafe }),
    null
  );
});

test("非规范 base64（多余尾部 bit）被拒绝", () => {
  // 43 个 A + '='：全零密钥的规范形式；把第 43 位换成 'B' 后
  // 解码仍是 32 字节，但 re-encode 不等于输入，必须拒绝
  const canonical = Buffer.alloc(32, 0).toString("base64");
  assert.equal(canonical, `${"A".repeat(43)}=`);
  assert.ok(readMusicCredentialKey({ MUSIC_CREDENTIAL_KEY: canonical }));

  const nonCanonical = `${"A".repeat(42)}B=`;
  assert.equal(Buffer.from(nonCanonical, "base64").length, 32);
  assert.equal(
    readMusicCredentialKey({ MUSIC_CREDENTIAL_KEY: nonCanonical }),
    null
  );
});

test("AES-256-GCM 加密解密往返一致", () => {
  const env = makeEnv();
  const plaintext = "MUSIC_U=secret-token; os=pc";
  const record = encryptMusicCredential(plaintext, env);

  assert.equal(typeof record.ciphertext, "string");
  assert.equal(typeof record.iv, "string");
  assert.equal(typeof record.authTag, "string");
  assert.ok(!record.ciphertext.includes("secret-token"));

  assert.equal(decryptMusicCredential(record, env), plaintext);
});

test("同一明文多次加密产生不同密文和 IV", () => {
  const env = makeEnv();
  const plaintext = "MUSIC_U=same-plaintext";
  const first = encryptMusicCredential(plaintext, env);
  const second = encryptMusicCredential(plaintext, env);

  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(decryptMusicCredential(first, env), plaintext);
  assert.equal(decryptMusicCredential(second, env), plaintext);
});

test("未配置密钥时加密和解密抛出 MUSIC_NOT_CONFIGURED", () => {
  const env = {};
  assert.throws(
    () => encryptMusicCredential("MUSIC_U=x", env),
    (error) =>
      error instanceof MusicConfigError &&
      error.code === MUSIC_NOT_CONFIGURED
  );
  assert.throws(
    () =>
      decryptMusicCredential(
        { ciphertext: "AA==", iv: "AA==", authTag: "AA==" },
        env
      ),
    (error) => error.code === MUSIC_NOT_CONFIGURED
  );
});

test("篡改密文、IV 或 auth tag 会导致解密失败", () => {
  const env = makeEnv();
  const record = encryptMusicCredential("MUSIC_U=tamper-check", env);

  const flipBase64 = (value) => {
    const buffer = Buffer.from(value, "base64");
    buffer[0] ^= 0xff;
    return buffer.toString("base64");
  };

  assert.throws(() =>
    decryptMusicCredential(
      { ...record, ciphertext: flipBase64(record.ciphertext) },
      env
    )
  );
  assert.throws(() =>
    decryptMusicCredential({ ...record, iv: flipBase64(record.iv) }, env)
  );
  assert.throws(() =>
    decryptMusicCredential(
      { ...record, authTag: flipBase64(record.authTag) },
      env
    )
  );
});

test("使用错误密钥解密失败", () => {
  const envA = makeEnv();
  const envB = makeEnv();
  const record = encryptMusicCredential("MUSIC_U=cross-key", envA);
  assert.throws(() => decryptMusicCredential(record, envB));
});

test("非字符串明文与非法记录被拒绝", () => {
  const env = makeEnv();
  assert.throws(() => encryptMusicCredential("", env), TypeError);
  assert.throws(() => encryptMusicCredential(null, env), TypeError);
  assert.throws(() => decryptMusicCredential(null, env), TypeError);
  assert.throws(() => decryptMusicCredential({}, env), TypeError);
});
