import { useEffect, useRef, useState } from "react";

export default function CreateChannelDialog({ onCancel, onCreate }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    const normalizedName = name.normalize("NFKC").trim();
    if (normalizedName.length < 1 || normalizedName.length > 40) {
      setError("频道名称必须为 1—40 个字符");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      await onCreate(normalizedName);
      onCancel();
    } catch (createError) {
      setError(createError?.message || "创建频道失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="channel-create-backdrop" role="presentation">
      <form
        className="channel-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-channel-title"
        onSubmit={handleSubmit}
      >
        <h3 id="create-channel-title">创建语音频道</h3>
        <label htmlFor="create-channel-name">频道名称</label>
        <input
          ref={inputRef}
          id="create-channel-name"
          value={name}
          maxLength={40}
          disabled={submitting}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：训练频道"
          autoComplete="off"
        />
        <div className="channel-create-counter">{name.length}/40</div>
        {error && <div className="channel-create-error" role="alert">{error}</div>}
        <div className="channel-create-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>取消</button>
          <button type="submit" className="primary-action" disabled={submitting}>
            {submitting ? "正在创建…" : "创建频道"}
          </button>
        </div>
      </form>
    </div>
  );
}
