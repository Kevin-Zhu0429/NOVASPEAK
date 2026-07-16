// 网易云账号绑定的数据访问层。
// 身份隔离原则：principal_key 只能来自服务端认证中间件得到的 req.authUser.id，
// 绝不接受前端传入的 userId，也不使用 LiveKit participant identity。

// 访客会话最长 8 小时（与 guest-auth.js 一致），凭据随之过期
const GUEST_CREDENTIAL_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * 由服务端认证用户得到网易云凭据归属键。
 * 正式成员使用数据库用户 id，访客使用 guest:UUID，天然互不冲突。
 */
export function getMusicPrincipal(authUser) {
  if (!authUser || typeof authUser.id !== "string" || !authUser.id.trim()) {
    return null;
  }
  return {
    key: authUser.id,
    isGuest: authUser.isGuest === true || authUser.id.startsWith("guest:"),
  };
}

/**
 * 访客凭据的过期时间；正式成员凭据长期有效（返回 null）。
 */
export function getCredentialExpiry(principal, now = Date.now()) {
  if (!principal?.isGuest) return null;
  return new Date(now + GUEST_CREDENTIAL_TTL_MS).toISOString();
}

/**
 * 清理已过期的凭据（主要是访客）。可在任何服务入口安全重复调用。
 */
export function cleanupExpiredNeteaseAccounts(db, now = Date.now()) {
  return db
    .prepare(`
      DELETE FROM netease_accounts
      WHERE credential_expires_at IS NOT NULL
        AND credential_expires_at <= ?
    `)
    .run(new Date(now).toISOString()).changes;
}

/**
 * 数据库行转换为可以返回给前端的安全账号信息。
 * 绝不包含密文、IV、auth tag 或任何 Cookie 内容。
 */
export function toPublicNeteaseAccount(row) {
  if (!row) return null;
  return {
    neteaseUserId: row.netease_user_id || null,
    nickname: row.nickname || null,
    avatarUrl: row.avatar_url || null,
  };
}

export function getNeteaseAccountRow(db, principalKey, now = Date.now()) {
  cleanupExpiredNeteaseAccounts(db, now);
  return (
    db
      .prepare(`
        SELECT
          principal_key,
          encrypted_cookie,
          cookie_iv,
          cookie_auth_tag,
          netease_user_id,
          nickname,
          avatar_url,
          credential_expires_at
        FROM netease_accounts
        WHERE principal_key = ?
      `)
      .get(principalKey) || null
  );
}

/**
 * 保存（或覆盖）当前用户的网易云绑定。encrypted 为
 * credential-store 输出的 { ciphertext, iv, authTag } 三元组。
 */
export function saveNeteaseBinding(
  db,
  { principalKey, encrypted, profile, credentialExpiresAt = null },
  now = Date.now()
) {
  const nowIso = new Date(now).toISOString();
  db.prepare(`
    INSERT INTO netease_accounts (
      principal_key,
      encrypted_cookie,
      cookie_iv,
      cookie_auth_tag,
      netease_user_id,
      nickname,
      avatar_url,
      credential_expires_at,
      created_at,
      updated_at
    )
    VALUES (
      @principalKey,
      @encryptedCookie,
      @cookieIv,
      @cookieAuthTag,
      @neteaseUserId,
      @nickname,
      @avatarUrl,
      @credentialExpiresAt,
      @nowIso,
      @nowIso
    )
    ON CONFLICT(principal_key) DO UPDATE SET
      encrypted_cookie = excluded.encrypted_cookie,
      cookie_iv = excluded.cookie_iv,
      cookie_auth_tag = excluded.cookie_auth_tag,
      netease_user_id = excluded.netease_user_id,
      nickname = excluded.nickname,
      avatar_url = excluded.avatar_url,
      credential_expires_at = excluded.credential_expires_at,
      updated_at = excluded.updated_at
  `).run({
    principalKey,
    encryptedCookie: encrypted.ciphertext,
    cookieIv: encrypted.iv,
    cookieAuthTag: encrypted.authTag,
    neteaseUserId: profile?.neteaseUserId ?? null,
    nickname: profile?.nickname ?? null,
    avatarUrl: profile?.avatarUrl ?? null,
    credentialExpiresAt,
    nowIso,
  });
}

/**
 * 只删除指定 principal 自己的绑定，返回是否确实删除了记录。
 */
export function deleteNeteaseBinding(db, principalKey) {
  return (
    db
      .prepare("DELETE FROM netease_accounts WHERE principal_key = ?")
      .run(principalKey).changes > 0
  );
}
