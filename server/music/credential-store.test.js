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
