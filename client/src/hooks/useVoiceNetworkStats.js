import { useCallback, useEffect, useRef, useState } from "react";
import { Track } from "livekit-client";
import { calculateLossSample, NETWORK_POLL_INTERVAL_MS, smoothMetric, weightedLoss } from "../utils/voice-network";

async function receiverStats(track) {
  const report = await track.getRTCStatsReport?.();
  let result;
  report?.forEach((stat) => {
    if (stat.type === "inbound-rtp" && (stat.kind === "audio" || stat.mediaType === "audio")) {
      result = { packetsReceived: stat.packetsReceived, packetsLost: stat.packetsLost, timestamp: stat.timestamp };
    }
  });
  return result;
}

export default function useVoiceNetworkStats(room, active, baselineVersion) {
  const [stats, setStats] = useState({ rtt: null, outboundLoss: null, inboundLoss: null, participantLoss: {} });
  const baselines = useRef({ outbound: null, inbound: new Map() });
  const running = useRef(false);
  const generation = useRef(0);

  const reset = useCallback(() => {
    baselines.current = { outbound: null, inbound: new Map() };
    setStats({ rtt: null, outboundLoss: null, inboundLoss: null, participantLoss: {} });
  }, []);

  useEffect(() => { queueMicrotask(reset); }, [baselineVersion, reset]);

  useEffect(() => {
    if (!room || !active) return undefined;
    const currentGeneration = ++generation.current;
    let timer;
    let stopped = false;

    const poll = async () => {
      if (stopped || running.current || document.hidden) return;
      running.current = true;
      try {
        const localPublication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
        const sender = await localPublication?.track?.getSenderStats?.();
        const outboundSample = calculateLossSample(sender, baselines.current.outbound, "packetsSent");
        if (sender) baselines.current.outbound = sender;

        const inboundSamples = [];
        const participantLoss = {};
        const liveTrackIds = new Set();
        for (const participant of room.remoteParticipants.values()) {
          for (const publication of participant.audioTrackPublications.values()) {
            const track = publication.track;
            if (!track || publication.source !== Track.Source.Microphone) continue;
            const key = publication.trackSid;
            liveTrackIds.add(key);
            const current = await receiverStats(track);
            const sample = calculateLossSample(current, baselines.current.inbound.get(key), "packetsReceived");
            if (current) baselines.current.inbound.set(key, current);
            if (sample) {
              inboundSamples.push(sample);
              participantLoss[participant.identity] = sample.loss;
            }
          }
        }
        for (const key of baselines.current.inbound.keys()) if (!liveTrackIds.has(key)) baselines.current.inbound.delete(key);
        const inboundLoss = weightedLoss(inboundSamples);
        const rtt = Number.isFinite(sender?.roundTripTime) && sender.roundTripTime >= 0 ? sender.roundTripTime * 1000 : null;
        if (!stopped && generation.current === currentGeneration) {
          setStats((previous) => ({
            rtt: smoothMetric(previous.rtt, rtt),
            outboundLoss: outboundSample ? smoothMetric(previous.outboundLoss, outboundSample.loss) : previous.outboundLoss,
            inboundLoss: inboundLoss == null ? (liveTrackIds.size ? previous.inboundLoss : null) : smoothMetric(previous.inboundLoss, inboundLoss),
            participantLoss,
          }));
        }
      } catch (error) {
        console.warn("网络统计暂不可用：", error);
      } finally {
        running.current = false;
      }
    };

    poll();
    timer = window.setInterval(poll, NETWORK_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      generation.current += 1;
      window.clearInterval(timer);
      running.current = false;
    };
  }, [room, active, baselineVersion]);

  return stats;
}
