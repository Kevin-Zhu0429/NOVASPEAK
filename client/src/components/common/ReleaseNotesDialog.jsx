import { useEffect } from "react";
import { RELEASE_NOTES, WEB_APP_VERSION } from "../../release-notes";

export default function ReleaseNotesDialog({ onClose }) {
  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="release-notes-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <section
        className="release-notes-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="release-notes-title"
      >
        <header className="release-notes-header">
          <div>
            <span>WHAT&apos;S NEW</span>
            <h2 id="release-notes-title">NovaSpeak 更新日志</h2>
            <p>当前网页版本 v{WEB_APP_VERSION}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭更新日志">×</button>
        </header>

        <div className="release-notes-list">
          {RELEASE_NOTES.map((release) => (
            <article key={release.version} className="release-note-card">
              <div className="release-note-title-row">
                <div>
                  <strong>v{release.version}</strong>
                  <span>{release.title}</span>
                </div>
                <time dateTime={release.releasedAt}>{release.releasedAt}</time>
              </div>
              <div className={release.requiresDesktopUpdate ? "release-kind desktop" : "release-kind web"}>
                {release.requiresDesktopUpdate ? "桌面大版本 · 需要 OTA" : "网页小更新 · 自动生效"}
              </div>
              <ul>
                {release.changes.map((change) => <li key={change}>{change}</li>)}
              </ul>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
