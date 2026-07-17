import { memo, useEffect, useRef, useState } from "react";
import { Mic, MicOff, MoreHorizontal, Music, Pause, Play, Signal, SkipForward } from "lucide-react";
import { formatLoss, qualityLabel } from "../../utils/voice-network";
import { formatArtists, formatTrackDuration } from "../../utils/music-format";
import { getMemberStatusBadges } from "../../utils/voice-member-menu";
import { getMemberAudioKey, getMemberAudioPref } from "../../utils/local-audio-preferences";
import { createLongPressTracker, shouldIgnoreLongPressTarget } from "../../utils/long-press";
import { resolveParticipantAvatarUrl } from "../../utils/avatar";
import VoiceMemberContextMenu from "./VoiceMemberContextMenu";
import MemberProfileDialog from "./MemberProfileDialog";
import UserAvatar from "../common/UserAvatar";

function VoiceParticipantCard({ item, receiveLoss, onlineMembers, currentUser, currentChannel, channels, busy, anyBusy, onManageParticipant, localAudioPrefs, onSetMemberVolume, onSetMemberLocalMuted, musicStatus }) {
  const [contextMenu, setContextMenu] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const buttonRef = useRef(null);
  const memberKey = getMemberAudioKey(item);
  const localPref = getMemberAudioPref(localAudioPrefs, memberKey);
  const statusBadges = getMemberStatusBadges({ serverMuted: item.serverMuted, localMuted: !item.isLocal && localPref.muted });
  // LiveKit metadata 不含头像：本人用 currentUser，其余成员用 Presence 在线数据
  const avatarUrl = resolveParticipantAvatarUrl({ isLocal: item.isLocal, displayName: item.displayName, currentUser, onlineMembers });
  const musicNowPlaying = item.isMusicBot ? musicStatus?.nowPlaying : null;

  // 手机端补充入口：长按卡片 550ms 打开菜单（不影响滚动和按钮点击）
  const [longPress] = useState(() => createLongPressTracker({ onLongPress: (point) => setContextMenu({ x: point.x, y: point.y }) }));
  useEffect(() => () => longPress.cancel(), [longPress]);

  const openContextMenu = (event) => {
    event.preventDefault();
    // Portal 内的右键事件会沿 React 树冒泡回卡片，不重新打开菜单
    if (event.target instanceof Element && event.target.closest(".voice-member-menu, .member-profile-overlay")) return;
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  // ⋯ 按钮在所有端打开同一个完整成员菜单，再次点击关闭
  const toggleMenuFromButton = () => {
    setContextMenu((previous) => {
      if (previous) return null;
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return { x: rect.left, y: rect.bottom + 6 };
    });
  };

  const onTouchStart = (event) => {
    if (event.touches.length !== 1 || shouldIgnoreLongPressTarget(event.target)) {
      longPress.cancel();
      return;
    }
    const touch = event.touches[0];
    longPress.start({ x: touch.clientX, y: touch.clientY });
  };
  const onTouchMove = (event) => {
    const touch = event.touches[0];
    if (touch) longPress.move({ x: touch.clientX, y: touch.clientY });
  };

  return (
    <article
      className={`voice-participant-card ${item.isSpeaking ? "speaking" : ""} ${busy ? "operating" : ""} ${musicNowPlaying ? "music-bot-playing" : ""}`}
      onContextMenu={openContextMenu}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={() => longPress.cancel()}
      onTouchCancel={() => longPress.cancel()}
    >
      {musicNowPlaying ? (
        <MusicBotCover
          picUrl={musicNowPlaying.song.album?.picUrl}
          songName={musicNowPlaying.song.name}
        />
      ) : (
        <UserAvatar avatarUrl={avatarUrl} displayName={item.displayName} size="md" status={item.isSpeaking ? "speaking" : ""} />
      )}
      {musicNowPlaying ? (
        <div className="music-bot-participant-copy">
          <strong title={musicNowPlaying.song.name}>{musicNowPlaying.song.name}</strong>
          <span title={formatArtists(musicNowPlaying.song.artists)}>{formatArtists(musicNowPlaying.song.artists)}</span>
          <small>{musicNowPlaying.requester.displayName}{musicNowPlaying.requester.isCurrentUser ? "（我）" : ""} 点歌</small>
          <div className="music-bot-card-progress-row">
            <div className="music-bot-card-progress" role="progressbar" aria-label="歌曲播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(musicStatus.progress?.percent || 0)}>
              <span style={{ width: `${musicStatus.progress?.percent || 0}%` }} />
            </div>
            <span>{formatTrackDuration(musicStatus.progress?.elapsedMs || 0)} / {formatTrackDuration(musicStatus.progress?.durationMs || 0)}</span>
          </div>
          <div className="music-bot-card-controls">
            <button type="button" onClick={musicStatus.togglePaused} disabled={!musicStatus.canControl || Boolean(musicStatus.controlBusy)} title={musicStatus.canControl ? (musicNowPlaying.playback?.paused ? "继续播放" : "暂停播放") : "仅管理员可控制"} aria-label={musicNowPlaying.playback?.paused ? "继续播放" : "暂停播放"}>
              {musicNowPlaying.playback?.paused ? <Play size={14} /> : <Pause size={14} />}
              <span>{musicNowPlaying.playback?.paused ? "继续" : "暂停"}</span>
            </button>
            <button type="button" onClick={musicStatus.skip} disabled={!musicStatus.canControl || Boolean(musicStatus.controlBusy)} title={musicStatus.canControl ? "下一首" : "仅管理员可控制"} aria-label="下一首">
              <SkipForward size={14} /><span>下一首</span>
            </button>
            {musicStatus.error && <em title={musicStatus.error}>控制状态异常</em>}
          </div>
        </div>
      ) : (
        <>
          <div className="voice-participant-copy">
            <strong>{item.displayName}{item.isLocal ? "（我）" : ""}</strong>
            <span>{item.positionText}</span>
            <small>{busy ? "操作中..." : item.serverMuted ? "已被服务器静音" : item.isSpeaking ? "正在说话" : item.microphoneEnabled ? "麦克风开启" : "麦克风关闭"}</small>
            {!item.isLocal && Number.isFinite(receiveLoss) && <small>本机接收丢包 {formatLoss(receiveLoss)}</small>}
          </div>
          <div className="voice-participant-state" title={`网络质量：${qualityLabel(item.connectionQuality)}`}>
            <Signal size={17} /><span>{qualityLabel(item.connectionQuality)}</span>
            {item.microphoneEnabled && !item.serverMuted ? <Mic size={17} /> : <MicOff size={17} />}
          </div>
        </>
      )}
      <div className="voice-member-actions">
        <button ref={buttonRef} type="button" className="voice-member-menu-button" onClick={toggleMenuFromButton} disabled={busy || anyBusy} aria-label="成员菜单" aria-haspopup="menu" aria-expanded={Boolean(contextMenu)}>
          <MoreHorizontal size={17} />
        </button>
      </div>
      {statusBadges.length > 0 && (
        <div className="voice-card-badges">
          {statusBadges.map((badge) => <div key={badge.type} className={`${badge.type}-badge`}>{badge.label}</div>)}
        </div>
      )}
      {item.isSpeaking && <div className="voice-level" style={{ "--voice-level": Math.max(0.12, item.audioLevel) }} />}
      {contextMenu && (
        <VoiceMemberContextMenu
          position={contextMenu}
          item={item}
          currentUser={currentUser}
          currentChannel={currentChannel}
          channels={channels}
          localPref={localPref}
          busy={busy}
          anyBusy={anyBusy}
          anchorRef={buttonRef}
          onClose={() => setContextMenu(null)}
          onShowProfile={() => setProfileOpen(true)}
          onSetVolume={(volume) => onSetMemberVolume?.(memberKey, volume)}
          onSetLocalMuted={(muted) => onSetMemberLocalMuted?.(memberKey, muted)}
          onManageParticipant={onManageParticipant}
        />
      )}
      {profileOpen && (
        <MemberProfileDialog
          item={item}
          avatarUrl={avatarUrl}
          memberKey={memberKey}
          channelName={currentChannel?.name}
          localPref={localPref}
          onClose={() => setProfileOpen(false)}
        />
      )}
    </article>
  );
}

function MusicBotCover({ picUrl, songName }) {
  const [failedUrl, setFailedUrl] = useState("");
  const showImage = typeof picUrl === "string" && picUrl && picUrl !== failedUrl;
  return (
    <span className="music-bot-cover-avatar">
      {showImage ? (
        <img
          src={picUrl}
          alt={`${songName || "当前歌曲"}封面`}
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailedUrl(picUrl)}
        />
      ) : (
        <Music aria-hidden="true" />
      )}
    </span>
  );
}
export default memo(VoiceParticipantCard);
