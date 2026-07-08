import crypto from "node:crypto";

export const GUEST_COOKIE_NAME = "novaspeak_guest";
const GUEST_SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

function getGuestSecret() {
  const secret = process.env.GUEST_SESSION_SECRET;

  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("GUEST_SESSION_SECRET is missing or too short");
  }

  return secret;
}

function base64urlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64urlJson(value) {
  return base64urlEncode(JSON.stringify(value));
}

function signPayload(encodedPayload) {
  return crypto
    .createHmac("sha256", getGuestSecret())
    .update(encodedPayload)
    .digest("base64url");
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return (
    left.length === right.length &&
    crypto.timingSafeEqual(left, right)
  );
}

function isSecureRequest(req) {
  return req.secure === true;
}

export function getGuestCookieOptions(req) {
  return {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    path: "/",
  };
}

export function toPublicGuest(payload) {
  if (!payload) return null;

  return {
    id: payload.id,
    nickname: payload.nickname,
    displayName: payload.nickname,
    role: "guest",
    isAdmin: false,
    isCaptain: false,
    isGuest: true,
    positions: [],
    positionNames: [],
    avatarUrl: null,
    position: "guest",
    positionName: "访客",
  };
}

export function createGuestSession(nickname, req, res) {
  const now = Date.now();
  const payload = {
    id: `guest:${crypto.randomUUID()}`,
    nickname,
    role: "guest",
    exp: now + GUEST_SESSION_DURATION_MS,
    iat: now,
  };

  const encodedPayload = base64urlJson(payload);
  const signature = signPayload(encodedPayload);

  res.cookie(
    GUEST_COOKIE_NAME,
    `${encodedPayload}.${signature}`,
    {
      ...getGuestCookieOptions(req),
      maxAge: GUEST_SESSION_DURATION_MS,
    }
  );

  return toPublicGuest(payload);
}

export function getGuestUser(req) {
  try {
    const cookieValue = req.cookies?.[GUEST_COOKIE_NAME];

    if (typeof cookieValue !== "string" || !cookieValue.includes(".")) {
      return null;
    }

    const [encodedPayload, signature, ...extra] = cookieValue.split(".");

    if (!encodedPayload || !signature || extra.length > 0) {
      return null;
    }

    const expectedSignature = signPayload(encodedPayload);

    if (!timingSafeEqualText(signature, expectedSignature)) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );

    if (
      typeof payload?.id !== "string" ||
      !payload.id.startsWith("guest:") ||
      typeof payload.nickname !== "string" ||
      payload.role !== "guest" ||
      typeof payload.exp !== "number" ||
      payload.exp <= Date.now()
    ) {
      return null;
    }

    return toPublicGuest(payload);
  } catch (error) {
    return null;
  }
}

export function destroyGuestSession(req, res) {
  res.clearCookie(
    GUEST_COOKIE_NAME,
    getGuestCookieOptions(req)
  );
}
