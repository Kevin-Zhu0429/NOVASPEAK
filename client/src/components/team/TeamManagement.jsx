import {
  useEffect,
  useState,
} from "react";

const API_BASE =
  import.meta.env.VITE_API_BASE || "";

export default function TeamManagement({
  onClose,
}) {
  const [members, setMembers] =
    useState([]);

  const [loading, setLoading] =
    useState(true);

  const [submitting, setSubmitting] =
    useState(false);

  const [error, setError] =
    useState("");

  const [success, setSuccess] =
    useState("");

  const [form, setForm] = useState({
    nickname: "",
    position: "member",
    password: "",
    confirmPassword: "",
  });

  useEffect(() => {
    loadMembers();
  }, []);

  async function loadMembers() {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(
        `${API_BASE}/api/team/members`,
        {
          credentials: "include",
        }
      );

      const contentType =
        response.headers.get("content-type") || "";

      if (!contentType.includes("application/json")) {
        const text = await response.text();

        console.error(
          "成员接口返回了非 JSON 内容：",
          text
        );

        throw new Error(
          "战队管理接口未正确连接到后端"
        );
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
            "获取成员列表失败"
        );
      }

      setMembers(data.members || []);
    } catch (requestError) {
      console.error(
        "Load members error:",
        requestError
      );

      setError(
        requestError.message ||
          "获取成员列表失败"
      );
    } finally {
      setLoading(false);
    }
  }

  function updateForm(field, value) {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function createMember(event) {
    event.preventDefault();

    const cleanNickname =
      typeof form.nickname === "string"
        ? form.nickname.normalize("NFKC").trim()
        : "";

    const selectedPosition =
      typeof form.position === "string"
        ? form.position
        : "member";

    const password =
      typeof form.password === "string"
        ? form.password
        : "";

    const confirmPassword =
      typeof form.confirmPassword === "string"
        ? form.confirmPassword
        : "";

    if (!cleanNickname || !password) {
      setError("请完整填写游戏昵称和密码");
      setSuccess("");
      return;
    }

    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      setSuccess("");
      return;
    }

    if (password.length < 8) {
      setError("初始密码至少需要 8 位");
      setSuccess("");
      return;
    }

    try {
      setSubmitting(true);
      setError("");
      setSuccess("");

      const response = await fetch(
        `${API_BASE}/api/team/members`,
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
          },

          credentials: "include",

          body: JSON.stringify({
            nickname: cleanNickname,
            position: selectedPosition,
            password,
          }),
        }
      );

      const contentType =
        response.headers.get("content-type") || "";

      if (!contentType.includes("application/json")) {
        const responseText = await response.text();

        console.error(
          "创建成员接口返回了非 JSON 内容：",
          responseText
        );

        throw new Error(
          "创建成员接口未正确连接到后端"
        );
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "创建成员失败"
        );
      }

      setForm({
        nickname: "",
        position: "member",
        password: "",
        confirmPassword: "",
      });

      setSuccess(
        `成员 ${data.member.nickname || cleanNickname} 创建成功`
      );

      await loadMembers();
    } catch (requestError) {
      console.error(
        "Create member error:",
        requestError
      );

      setError(
        requestError.message || "创建成员失败"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="team-management-overlay"
      role="dialog"
      aria-modal="true"
    >
      <div className="team-management-modal">
        <header className="management-header">
          <div>
            <div className="management-label">
              NOVA GAMING
            </div>

            <h2>战队管理</h2>

            <p>
              管理战队成员和登录账号
            </p>
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

        <div className="management-content">
          <section className="member-list-section">
            <div className="section-heading">
              <h3>战队成员</h3>

              <span>
                {members.length} 人
              </span>
            </div>

            {loading ? (
              <div className="management-empty">
                正在加载成员...
              </div>
            ) : members.length === 0 ? (
              <div className="management-empty">
                暂无成员
              </div>
            ) : (
              <div className="management-member-list">
                {members.map((member) => (
                  <div
                    className="management-member"
                    key={member.id}
                  >
                    <div className="member-avatar">
                      {member.displayName
                        .slice(0, 1)
                        .toUpperCase()}
                    </div>

                    <div className="member-information">
                      <strong>
                        {member.displayName}
                      </strong>

                      <span>
                        {member.positionName}
                      </span>
                    </div>

                    <div
                      className={
                        member.isCaptain
                          ? "member-role captain"
                          : "member-role"
                      }
                    >
                      {member.isCaptain
                        ? "队长"
                        : "成员"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="create-member-section">
            <div className="section-heading">
              <h3>添加战队成员</h3>
            </div>

            <form
              className="create-member-form"
              onSubmit={createMember}
            >
              <label>
                <span>游戏昵称</span>

                <input
                    value={form.nickname}
                    onChange={(event) =>
                    updateForm(
                        "nickname",
                        event.target.value
                    )
                    }
                    placeholder="例如：CHILLILY"
                    maxLength={30}
                    disabled={submitting}
                />
                </label>

                <label>
                <span>战队职位</span>

                <select
                    value={form.position}
                    onChange={(event) =>
                    updateForm(
                        "position",
                        event.target.value
                    )
                    }
                    disabled={submitting}
                >
                    <option value="member">
                    队员
                    </option>

                    <option value="commander">
                    指挥
                    </option>

                    <option value="entry">
                    突破手
                    </option>

                    <option value="sniper">
                    狙击手
                    </option>

                    <option value="support">
                    辅助
                    </option>

                    <option value="rifler">
                    步枪手
                    </option>

                    <option value="freeman">
                    自由人
                    </option>

                    <option value="backup">
                    替补
                    </option>
                </select>
                </label>

              <label>
                <span>初始密码</span>

                <input
                  type="password"
                  value={form.password}
                  onChange={(event) =>
                    updateForm(
                      "password",
                      event.target.value
                    )
                  }
                  placeholder="至少 8 位"
                  maxLength={128}
                  disabled={submitting}
                />
              </label>

              <label>
                <span>确认密码</span>

                <input
                  type="password"
                  value={
                    form.confirmPassword
                  }
                  onChange={(event) =>
                    updateForm(
                      "confirmPassword",
                      event.target.value
                    )
                  }
                  placeholder="再次输入密码"
                  maxLength={128}
                  disabled={submitting}
                />
              </label>

              {error && (
                <div className="management-error">
                  {error}
                </div>
              )}

              {success && (
                <div className="management-success">
                  {success}
                </div>
              )}

              <button
                type="submit"
                className="create-member-button"
                disabled={submitting}
              >
                {submitting
                  ? "正在创建..."
                  : "创建成员账号"}
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}