import { useState } from "react";
import CreateChannelDialog from "./channels/CreateChannelDialog";
import { sortChannels } from "../utils/channel-settings";
export default function ChannelList({
  channels,
  currentChannel,
  onJoinChannel,
  onCreateChannel,
  onOpenChannelManagement,
}) {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="channel-section">
      <div className="channel-section-header">
        <div className="section-title">语音频道</div>

        <div className="channel-header-actions">
          {typeof onOpenChannelManagement === "function" && (
            <button type="button" className="channel-management-entry" onClick={onOpenChannelManagement}>
              频道管理
            </button>
          )}

          {typeof onCreateChannel === "function" && (
            <button
              type="button"
              className="create-channel-btn"
              onClick={() => setCreateOpen(true)}
              aria-label="创建语音频道"
              title="创建语音频道"
            >
              +
            </button>
          )}
        </div>
      </div>

      <div className="channel-list">
        {sortChannels(channels).map((channel) => {
          const active = currentChannel?.id === channel.id;
          const hasUsers = channel.participantCount > 0;

          return (
            <button
              key={channel.id}
              className={active ? "channel active" : "channel"}
              onClick={() => onJoinChannel(channel)}
            >
              <span className="channel-name">
                <span className={hasUsers ? "channel-dot online" : "channel-dot"} />
                # {channel.name}
              </span>

              <span className={hasUsers ? "user-count online" : "user-count"}>
                {channel.participantCount}
              </span>
            </button>
          );
        })}
      </div>

      {createOpen && (
        <CreateChannelDialog
          onCancel={() => setCreateOpen(false)}
          onCreate={onCreateChannel}
        />
      )}
    </div>
  );
}
