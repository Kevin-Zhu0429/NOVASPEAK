import VoiceParticipantCard from "./VoiceParticipantCard";

export default function VoiceParticipantList({ participants, participantLoss }) {
  return (
    <aside className="voice-participants-panel">
      <div className="voice-panel-title"><h3>频道成员</h3><span>{participants.length}</span></div>
      <div className="voice-participant-list">
        {participants.map((item) => <VoiceParticipantCard key={item.id} item={item} receiveLoss={participantLoss[item.id]} />)}
      </div>
    </aside>
  );
}
