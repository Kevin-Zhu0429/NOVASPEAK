import test from "node:test";
import assert from "node:assert/strict";
import { ReadableStream } from "node:stream/web";
import { validateNeteaseMediaUrl, openNeteaseMediaStream } from "./playback-source.js";

test("Netease media URL validation allows official host boundaries", () => {
  assert.equal(validateNeteaseMediaUrl("https://music.126.net/song.mp3"), "https://music.126.net/song.mp3");
  assert.equal(validateNeteaseMediaUrl("https://a.music.163.com/song.mp3"), "https://a.music.163.com/song.mp3");
});

test("Netease media URL validation rejects unsafe hosts and protocols", () => {
  for (const url of ["file:///x", "data:text/plain,x", "http://localhost/a", "http://127.0.0.1/a", "https://music.126.net.evil.com/a", "https://u:p@music.126.net/a"]) {
    assert.throws(() => validateNeteaseMediaUrl(url), /媒体地址/);
  }
});

test("media fetch follows checked redirects and streams without arrayBuffer", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "https://m10.music.126.net/a" } });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1,2,3])); c.close(); } }), { status: 200, headers: { "content-length": "3" } });
  };
  const result = await openNeteaseMediaStream({ url: "https://music.126.net/start", fetchImpl });
  const chunks = [];
  for await (const chunk of result.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1,2,3]));
  assert.equal(calls.length, 2);
});

test("media fetch rejects oversized content length", async () => {
  const fetchImpl = async () => new Response(new ReadableStream(), { status: 200, headers: { "content-length": "99" } });
  await assert.rejects(() => openNeteaseMediaStream({ url: "https://music.126.net/a", fetchImpl, maxBytes: 5 }), /媒体文件过大/);
});
