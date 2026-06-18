export default function ChannelList({
  channels,
  currentChannel,
  onJoinChannel,
  onCreateChannel,
}) {
  async function handleCreateChannel() {
    const name = prompt("请输入新频道名称");

    if (!name || !name.trim()) {
      return;
    }

    await onCreateChannel(name.trim());
  }

  return (
    <div className="channel-section">
      <div className="channel-section-header">
        <div className="section-title">语音频道</div>

        {typeof onCreateChannel === "function" && (
          <button className="create-channel-btn" onClick={handleCreateChannel}>
            +
          </button>
        )}
      </div>

      <div className="channel-list">
        {channels.map((channel) => {
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
    </div>
  );
}
