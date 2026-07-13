import { memo, useState } from "react";
import { getAvatarInitial, resolveAvatarImageSrc } from "../../utils/avatar";

// 与全站 fetch 相同的后端基址约定：Web 部署为空串（同源），桌面打包指向线上后端。
const API_BASE = import.meta.env.VITE_API_BASE || "";

/**
 * 通用头像：有 avatarUrl 显示图片，加载失败或为空时回退到昵称首字母。
 * 只负责展示，不发任何请求。
 */
function UserAvatar({
  avatarUrl,
  displayName,
  size = "md",
  status = "",
  className = "",
}) {
  const safeUrl = resolveAvatarImageSrc(avatarUrl, API_BASE);
  const [failedUrl, setFailedUrl] = useState("");
  const showImage = Boolean(safeUrl) && safeUrl !== failedUrl;
  const classes = [
    "user-avatar",
    `user-avatar-${size}`,
    status ? `user-avatar-${status}` : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes}>
      {showImage ? (
        <img
          src={safeUrl}
          alt={`${(displayName || "").trim() || "成员"} 的头像`}
          onError={() => setFailedUrl(safeUrl)}
          draggable={false}
          loading="lazy"
        />
      ) : (
        <span className="user-avatar-initial" aria-hidden="true">
          {getAvatarInitial(displayName)}
        </span>
      )}
    </span>
  );
}

export default memo(UserAvatar);
