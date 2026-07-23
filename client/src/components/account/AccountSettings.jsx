import { useEffect, useRef, useState } from "react";
import { getPositionText } from "../../utils/user-display";
import { getAvatarUploadUiModel } from "../../utils/avatar";
import {
  AVATAR_ALLOWED_MIME_TYPES,
  deleteMyAvatar,
  uploadMyAvatar,
} from "../../utils/avatar-api";
import UserAvatar from "../common/UserAvatar";

const API_BASE = import.meta.env.VITE_API_BASE || "";

const POSITION_OPTIONS = [
  ["captain", "队长"],
  ["commander", "指挥"],
  ["entry", "突破手"],
  ["sniper", "狙击手"],
  ["support", "辅助"],
  ["rifler", "步枪手"],
  ["freeman", "自由人"],
  ["backup", "替补"],
  ["member", "队员"],
];

async function requestJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
  });
  const contentType =
    response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    const responseText = await response.text();
    console.error("账号接口返回了非 JSON 内容：", responseText);
    throw new Error("账号接口未正确连接到后端");
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "账号操作失败");
  }

  return data;
}

export default function AccountSettings({
  currentUser,
  onClose,
  onUserUpdated,
}) {
  const [accountUser, setAccountUser] = useState(currentUser);
  const [loading, setLoading] = useState(true);
  const [nicknameForm, setNicknameForm] = useState({
    nickname: currentUser?.displayName || "",
    currentPassword: "",
  });
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [selectedPositions, setSelectedPositions] = useState(
    currentUser?.positions || []
  );
  const [nicknameStatus, setNicknameStatus] = useState({
    submitting: false,
    error: "",
    success: "",
  });
  const [passwordStatus, setPasswordStatus] = useState({
    submitting: false,
    error: "",
    success: "",
  });
  const [positionStatus, setPositionStatus] = useState({
    submitting: false,
    error: "",
    success: "",
  });
  const [loadError, setLoadError] = useState("");
  const [avatarStatus, setAvatarStatus] = useState({
    submitting: false,
    error: "",
    success: "",
  });
  const [confirmingAvatarDelete, setConfirmingAvatarDelete] = useState(false);
  const avatarInputRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function loadAccount() {
      try {
        const data = await requestJson("/api/account/me");

        if (!cancelled) {
          setAccountUser(data.user);
          setNicknameForm((form) => ({
            ...form,
            nickname: data.user.displayName || "",
          }));
          setSelectedPositions(data.user.positions || []);
        }
      } catch (error) {
        console.error("Load account error:", error);
        if (!cancelled) {
          setLoadError(error.message || "获取账号信息失败");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadAccount();
    return () => {
      cancelled = true;
    };
  }, []);

  function applyUpdatedUser(user) {
    setAccountUser(user);
    setSelectedPositions(user.positions || []);
    onUserUpdated(user);
  }

  async function handleAvatarFileChange(event) {
    const file = event.target.files?.[0];
    // 允许重新选择同一个文件
    event.target.value = "";
    if (!file) return;

    setConfirmingAvatarDelete(false);
    setAvatarStatus({ submitting: true, error: "", success: "" });
    try {
      const user = await uploadMyAvatar(API_BASE, file);
      applyUpdatedUser(user);
      setAvatarStatus({ submitting: false, error: "", success: "头像上传成功" });
    } catch (error) {
      console.error("Upload avatar error:", error?.message);
      setAvatarStatus({
        submitting: false,
        error: error.message || "头像上传失败，请稍后重试",
        success: "",
      });
    }
  }

  async function handleAvatarDelete() {
    setAvatarStatus({ submitting: true, error: "", success: "" });
    try {
      const user = await deleteMyAvatar(API_BASE);
      applyUpdatedUser(user);
      setConfirmingAvatarDelete(false);
      setAvatarStatus({ submitting: false, error: "", success: "头像已删除" });
    } catch (error) {
      console.error("Delete avatar error:", error?.message);
      setAvatarStatus({
        submitting: false,
        error: error.message || "头像删除失败，请稍后重试",
        success: "",
      });
    }
  }

  async function updateNickname(event) {
    event.preventDefault();
    const nickname =
      typeof nicknameForm.nickname === "string"
        ? nicknameForm.nickname.normalize("NFKC").trim()
        : "";

    try {
      setNicknameStatus({
        submitting: true,
        error: "",
        success: "",
      });
      const data = await requestJson("/api/account/me", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          nickname,
          currentPassword: nicknameForm.currentPassword,
        }),
      });

      applyUpdatedUser(data.user);
      setNicknameForm({
        nickname: data.user.displayName || "",
        currentPassword: "",
      });
      setNicknameStatus({
        submitting: false,
        error: "",
        success: "昵称修改成功",
      });
    } catch (error) {
      console.error("Update nickname error:", error);
      setNicknameStatus({
        submitting: false,
        error: error.message || "修改昵称失败",
        success: "",
      });
    }
  }

  async function updatePassword(event) {
    event.preventDefault();

    try {
      setPasswordStatus({
        submitting: true,
        error: "",
        success: "",
      });
      const data = await requestJson("/api/account/me/password", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(passwordForm),
      });

      setPasswordForm({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
      setPasswordStatus({
        submitting: false,
        error: "",
        success: data.message || "密码修改成功",
      });
    } catch (error) {
      console.error("Update password error:", error);
      setPasswordStatus({
        submitting: false,
        error: error.message || "修改密码失败",
        success: "",
      });
    }
  }

  function togglePosition(position) {
    setSelectedPositions((positions) =>
      positions.includes(position)
        ? positions.filter((item) => item !== position)
        : [...positions, position]
    );
  }

  async function updatePositions() {
    try {
      setPositionStatus({
        submitting: true,
        error: "",
        success: "",
      });
      const data = await requestJson("/api/account/me/positions", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          positions: selectedPositions,
        }),
      });

      applyUpdatedUser(data.user);
      setPositionStatus({
        submitting: false,
        error: "",
        success: "职位修改成功",
      });
    } catch (error) {
      console.error("Update positions error:", error);
      setPositionStatus({
        submitting: false,
        error: error.message || "修改职位失败",
        success: "",
      });
    }
  }

  const roleName =
    accountUser?.role === "admin"
      ? "管理员"
      : accountUser?.role === "member"
        ? "战队成员"
        : "普通语音用户";
  const positionSummary = getPositionText(accountUser);
  const avatarUi = getAvatarUploadUiModel({
    role: accountUser?.role,
    avatarUrl: accountUser?.avatarUrl,
    uploading: avatarStatus.submitting,
  });

  return (
    <div className="account-settings-overlay" role="dialog" aria-modal="true">
      <div className="account-settings-modal">
        <header className="account-settings-header">
          <div>
            <div className="management-label">NOVA GAMING</div>
            <h2>我的账号</h2>
            <p>管理你的正式账号信息</p>
          </div>
          <button
            type="button"
            className="management-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        {loading ? (
          <div className="account-settings-loading">正在加载账号信息...</div>
        ) : loadError ? (
          <div className="account-message error">{loadError}</div>
        ) : (
          <div className="account-settings-content">
            <section className="account-profile-card">
              <UserAvatar
                avatarUrl={accountUser?.avatarUrl}
                displayName={accountUser?.displayName}
                size="lg"
              />
              <div className="account-profile-main">
                <strong>{accountUser?.displayName}</strong>
                <span>{roleName}</span>
                <p>{positionSummary}</p>
                {avatarUi.showUploadEntry && (
                  <div className="account-avatar-actions">
                    <input
                      ref={avatarInputRef}
                      className="avatar-upload-input"
                      type="file"
                      accept={AVATAR_ALLOWED_MIME_TYPES.join(",")}
                      onChange={handleAvatarFileChange}
                      disabled={avatarUi.actionsDisabled}
                    />
                    <button
                      type="button"
                      className="avatar-action-button"
                      onClick={() => avatarInputRef.current?.click()}
                      disabled={avatarUi.actionsDisabled}
                    >
                      {avatarStatus.submitting ? "正在处理..." : "更换头像"}
                    </button>
                    {avatarUi.showDeleteEntry && !confirmingAvatarDelete && (
                      <button
                        type="button"
                        className="avatar-action-button danger"
                        onClick={() => setConfirmingAvatarDelete(true)}
                        disabled={avatarUi.actionsDisabled}
                      >
                        删除头像
                      </button>
                    )}
                    {avatarUi.showDeleteEntry && confirmingAvatarDelete && (
                      <span className="avatar-delete-confirm">
                        确定删除头像？
                        <button
                          type="button"
                          className="avatar-action-button danger"
                          onClick={handleAvatarDelete}
                          disabled={avatarUi.actionsDisabled}
                        >
                          确认删除
                        </button>
                        <button
                          type="button"
                          className="avatar-action-button"
                          onClick={() => setConfirmingAvatarDelete(false)}
                          disabled={avatarUi.actionsDisabled}
                        >
                          取消
                        </button>
                      </span>
                    )}
                  </div>
                )}
                <div className="account-avatar-message">
                  <AccountMessage status={avatarStatus} />
                </div>
              </div>
            </section>

            <div className="account-settings-grid">
              <form className="account-form-card" onSubmit={updateNickname}>
                <h3>修改昵称</h3>
                <label>
                  <span>新昵称</span>
                  <input
                    value={nicknameForm.nickname}
                    onChange={(event) =>
                      setNicknameForm((form) => ({
                        ...form,
                        nickname: event.target.value,
                      }))
                    }
                    minLength={2}
                    maxLength={24}
                    disabled={nicknameStatus.submitting}
                  />
                </label>
                <label>
                  <span>当前密码</span>
                  <input
                    type="password"
                    value={nicknameForm.currentPassword}
                    onChange={(event) =>
                      setNicknameForm((form) => ({
                        ...form,
                        currentPassword: event.target.value,
                      }))
                    }
                    autoComplete="current-password"
                    maxLength={128}
                    disabled={nicknameStatus.submitting}
                  />
                </label>
                <AccountMessage status={nicknameStatus} />
                <button type="submit" disabled={nicknameStatus.submitting}>
                  {nicknameStatus.submitting ? "正在保存..." : "保存昵称"}
                </button>
              </form>

              <form className="account-form-card" onSubmit={updatePassword}>
                <h3>修改密码</h3>
                {[
                  ["currentPassword", "当前密码", "current-password"],
                  ["newPassword", "新密码", "new-password"],
                  ["confirmPassword", "确认新密码", "new-password"],
                ].map(([field, label, autoComplete]) => (
                  <label key={field}>
                    <span>{label}</span>
                    <input
                      type="password"
                      value={passwordForm[field]}
                      onChange={(event) =>
                        setPasswordForm((form) => ({
                          ...form,
                          [field]: event.target.value,
                        }))
                      }
                      autoComplete={autoComplete}
                      maxLength={128}
                      disabled={passwordStatus.submitting}
                    />
                  </label>
                ))}
                <AccountMessage status={passwordStatus} />
                <button type="submit" disabled={passwordStatus.submitting}>
                  {passwordStatus.submitting ? "正在保存..." : "保存密码"}
                </button>
              </form>
            </div>

            {accountUser?.role === "admin" && (
              <section className="account-form-card position-settings-card">
                <h3>职位设置</h3>
                <p>职位用于展示；管理权限始终由账号角色决定。</p>
                <div className="position-options">
                  {POSITION_OPTIONS.map(([position, label]) => {
                    const selected = selectedPositions.includes(position);
                    return (
                      <button
                        type="button"
                        key={position}
                        className={selected ? "position-option selected" : "position-option"}
                        onClick={() => togglePosition(position)}
                        aria-pressed={selected}
                        disabled={positionStatus.submitting}
                      >
                        {selected ? "✓ " : ""}{label}
                      </button>
                    );
                  })}
                </div>
                <AccountMessage status={positionStatus} />
                <button
                  type="button"
                  onClick={updatePositions}
                  disabled={positionStatus.submitting}
                >
                  {positionStatus.submitting ? "正在保存..." : "保存职位"}
                </button>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AccountMessage({ status }) {
  if (status.error) {
    return <div className="account-message error">{status.error}</div>;
  }

  if (status.success) {
    return <div className="account-message success">{status.success}</div>;
  }

  return null;
}
