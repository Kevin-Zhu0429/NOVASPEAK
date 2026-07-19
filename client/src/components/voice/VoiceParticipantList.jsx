import VoiceParticipantCard from "./VoiceParticipantCard";
import OnlineMembersPanel from "../presence/OnlineMembersPanel";
import { useState } from "react";
import useChannelMusicStatus from "../../hooks/useChannelMusicStatus";

export default function VoiceParticipantList({ apiBase, participants, participantLoss, onlineMembers, presenceStatus, currentUser, currentChannel, channels, participantBusy, onManageParticipant, localAudioPrefs, onSetMemberVolume, onSetMemberLocalMuted }) {
  const [tab, setTab] = useState("channel");
  const musicStatus = useChannelMusicStatus({
    apiBase,
    channelId: currentChannel?.id,
    enabled: tab === "channel",
  });
  return (
    <aside className="voice-participants-panel">
      <div className="member-panel-tabs">
        <button type="button" className={tab === "channel" ? "active" : ""} onClick={() => setTab("channel")}>频道成员</button>
        <button type="button" className={tab === "online" ? "active" : ""} onClick={() => setTab("online")}>在线成员</button>
      </div>
      {tab === "channel" ? <>
        <div className="voice-panel-title"><h3>频道成员</h3><span>{participants.length}</span></div>
        <div className="voice-participant-list">
          {participants.map((item) => (
            <VoiceParticipantCard
              key={item.id}
              item={item}
              receiveLoss={participantLoss[item.id]}
              onlineMembers={onlineMembers}
              currentUser={currentUser}
              currentChannel={currentChannel}
              channels={channels}
              busy={participantBusy === item.id}
              anyBusy={Boolean(participantBusy)}
              onManageParticipant={onManageParticipant}
              localAudioPrefs={localAudioPrefs}
              onSetMemberVolume={onSetMemberVolume}
              onSetMemberLocalMuted={onSetMemberLocalMuted}
              musicStatus={musicStatus}
            />
          ))}
        </div>
      </> : <OnlineMembersPanel members={onlineMembers} connectionStatus={presenceStatus} embedded currentUser={currentUser} channels={channels} apiBase={apiBase} />}
    </aside>
  );
}
