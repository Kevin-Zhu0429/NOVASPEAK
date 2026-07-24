import assert from "node:assert/strict";
import test from "node:test";
import {
  createRegistrationLimiter,
  isRegistrationEnabled,
  normalizeRegistrationInput,
} from "./registration.js";

test("registration is enabled by default and supports a kill switch", () => {
  assert.equal(isRegistrationEnabled({}), true);
  assert.equal(isRegistrationEnabled({ REGISTRATION_ENABLED: "true" }), true);
  assert.equal(isRegistrationEnabled({ REGISTRATION_ENABLED: "0" }), false);
  assert.equal(isRegistrationEnabled({ REGISTRATION_ENABLED: "off" }), false);
});

test("registration normalizes usernames and validates passwords", () => {
  assert.deepEqual(
    normalizeRegistrationInput({ username: "  Ｎova  ", password: "password8" }),
    {
      username: "Nova",
      usernameKey: "nova",
      password: "password8",
    }
  );
  assert.match(
    normalizeRegistrationInput({ username: "x", password: "password8" }).error,
    /2—24/
  );
  assert.match(
    normalizeRegistrationInput({ username: "Nova", password: "short" }).error,
    /8—128/
  );
});

test("registration limiter rejects excess attempts and resets by window", () => {
  let currentTime = 1_000;
  const limiter = createRegistrationLimiter({
    windowMs: 10_000,
    maxAttempts: 2,
    now: () => currentTime,
  });
  assert.equal(limiter.check("ip").allowed, true);
  assert.equal(limiter.check("ip").allowed, true);
  assert.deepEqual(limiter.check("ip"), {
    allowed: false,
    retryAfterSeconds: 10,
  });
  currentTime += 10_000;
  assert.equal(limiter.check("ip").allowed, true);
});
