import test from "node:test";
import assert from "node:assert/strict";
import { createNeteaseClient, NETEASE_ERROR } from "./netease-client.js";

test("song_url_v1 uses standard level and caller cookie", async () => {
  let params;
  const client = createNeteaseClient({ api: { song_url_v1: async (p) => { params = p; return { body: { code: 200, data: [{ id: 42, url: "https://music.126.net/a", code: 200 }] } }; } } });
  const result = await client.getSongPlaybackUrl({ songId: "42", cookie: "MUSIC_U=A", level: "exhigh" });
  assert.equal(params.level, "standard");
  assert.equal(params.cookie, "MUSIC_U=A");
  assert.equal(result.url, "https://music.126.net/a");
});

test("playback URL rejects empty URL, ID mismatch and trial only", async () => {
  for (const data of [[{ id: 43, url: "x", code: 200 }], [{ id: 42, url: "", code: 200 }], [{ id: 42, url: "x", code: 200, freeTrialInfo: {} }]]) {
    const client = createNeteaseClient({ api: { song_url_v1: async () => ({ body: { code: 200, data } }) } });
    await assert.rejects(() => client.getSongPlaybackUrl({ songId: "42", cookie: "MUSIC_U=secret" }), (e) => !String(e.message).includes("secret"));
  }
});

test("playback maps login invalid and rate limited", async () => {
  const invalid = createNeteaseClient({ api: { song_url_v1: async () => ({ body: { code: 200, data: [{ id: 1, code: 401 }] } }) } });
  await assert.rejects(() => invalid.getSongPlaybackUrl({ songId: "1", cookie: "c" }), { code: NETEASE_ERROR.PLAYBACK_SESSION_INVALID });
  const limited = createNeteaseClient({ api: { song_url_v1: async () => { const e = new Error("x"); e.status = 429; throw e; } } });
  await assert.rejects(() => limited.getSongPlaybackUrl({ songId: "1", cookie: "c" }), { code: NETEASE_ERROR.RATE_LIMITED });
});
