import { getPositionText } from "../../utils/user-display";

export default function WelcomeOverlay({
  user,
}) {
  if (!user) return null;

  const positionText = getPositionText(user);

  return (
    <div className="welcome-overlay">
      <div className="welcome-light" />

      <div className="welcome-content">
        <div className="welcome-small-text">
          WELCOME
        </div>

        <div className="welcome-team-text">
          NOVA GAMING
        </div>

        <div className="welcome-line" />

        <div className="welcome-member-text">
          欢迎 NOVA GAMING 战队
        </div>

        <div className="welcome-identity">
          <span>
            {positionText}
          </span>

          <strong>
            {user.displayName}
          </strong>

          <em>登录</em>
        </div>
      </div>
    </div>
  );
}
