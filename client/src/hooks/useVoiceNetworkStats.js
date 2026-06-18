import { useCallback, useEffect, useRef, useState } from "react";
import { RoomEvent, Track } from "livekit-client";
import {
  calculateLossSample,
  findInboundAudio,
  findOutboundAudio,
  findRemoteInboundAudio,
  NETWORK_POLL_INTERVAL_MS,
  outboundLossSample,
  readRtt,
  reportValues,
  smoothMetric,
  weightedLoss,
} from "../utils/voice-network";

const DEBUG_VOICE_STATS = import.meta.env.DEV || import.meta.env.VITE_DEBUG_VOICE_STATS === "true";
const EMPTY_STATS = {
  rtt: null,
  outboundLoss: null,
  inboundLoss: null,
  participantLoss: {},
  localStatus: "waiting-local-track",
  inboundStatus: "no-remote-audio",
};

export default function useVoiceNetworkStats(room, active, baselineVersion) {
  const [stats, setStats] = useState(EMPTY_STATS);
  const baselines = useRef({ localTrack: null, outbound: null, remoteInbound: null, inbound: new Map() });
  const running = useRef(false);
  const generation = useRef(0);
  const debuggedReports = useRef(new Set());

  const reset = useCallback(() => {
    baselines.current = { localTrack: null, outbound: null, remoteInbound: null, inbound: new Map() };
    setStats(EMPTY_STATS);
  }, []);

  useEffect(() => { queueMicrotask(reset); }, [baselineVersion, reset]);

  useEffect(() => {
    if (!room || !active) return undefined;
    const currentGeneration = ++generation.current;
    let timer;
    let stopped = false;

    const debugReportOnce = (key, report, reason) => {
      if (!DEBUG_VOICE_STATS || debuggedReports.current.has(key)) return;
      debuggedReports.current.add(key);
      console.debug(`[voice-stats] ${reason}`);
      console.table(reportValues(report).map((stat) => ({
        id: stat.id,
        type: stat.type,
        kind: stat.kind,
        mediaType: stat.mediaType,
        packetsSent: stat.packetsSent,
        packetsReceived: stat.packetsReceived,
        packetsLost: stat.packetsLost,
        roundTripTime: stat.roundTripTime,
        remoteId: stat.remoteId,
        localId: stat.localId,
      })));
    };

    const poll = async () => {
      if (stopped || running.current || document.hidden) return;
      running.current = true;
      try {
        const localPublication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
        const localTrack = localPublication?.track;
        if (localTrack !== baselines.current.localTrack) {
          baselines.current.localTrack = localTrack || null;
          baselines.current.outbound = null;
          baselines.current.remoteInbound = null;
        }
        const previousOutbound = baselines.current.outbound;
        const previousRemoteInbound = baselines.current.remoteInbound;
        const localReport = await localTrack?.getRTCStatsReport?.();
        const outbound = findOutboundAudio(localReport);
        const remoteInbound = findRemoteInboundAudio(localReport, outbound);
        const outboundSample = outboundLossSample(
          outbound,
          previousOutbound,
          remoteInbound,
          previousRemoteInbound,
        );
        const rtt = readRtt(remoteInbound);
        if (localReport && (!outbound || !remoteInbound)) {
          debugReportOnce(`local:${localTrack?.sid || "unknown"}`, localReport, !outbound
            ? "本地音频报告缺少 outbound-rtp"
            : "本地音频报告缺少匹配的 remote-inbound-rtp");
        }
        baselines.current.outbound = outbound;
        baselines.current.remoteInbound = remoteInbound;

        const inboundSamples = [];
        const participantLoss = {};
        const liveTrackIds = new Set();
        for (const participant of room.remoteParticipants.values()) {
          for (const publication of participant.audioTrackPublications.values()) {
            const track = publication.track;
            if (!track || publication.source !== Track.Source.Microphone) continue;
            const key = publication.trackSid;
            liveTrackIds.add(key);
            const remoteReport = await track.getRTCStatsReport?.();
            const current = findInboundAudio(remoteReport);
            if (remoteReport && !current) debugReportOnce(`remote:${key}`, remoteReport, "远端音频报告缺少 inbound-rtp");
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
        const localStatus = !localTrack
          ? "waiting-local-track"
          : !outbound
            ? "stats-unavailable"
            : !previousOutbound || !remoteInbound
              ? "waiting-first-sample"
              : "ready";
        const inboundStatus = liveTrackIds.size === 0
          ? "no-remote-audio"
          : inboundLoss == null
            ? "waiting-first-sample"
            : "ready";
        if (!stopped && generation.current === currentGeneration) {
          setStats((previous) => ({
            rtt: smoothMetric(previous.rtt, rtt),
            outboundLoss: outboundSample ? smoothMetric(previous.outboundLoss, outboundSample.loss) : previous.outboundLoss,
            inboundLoss: inboundLoss == null ? (liveTrackIds.size ? previous.inboundLoss : null) : smoothMetric(previous.inboundLoss, inboundLoss),
            participantLoss,
            localStatus,
            inboundStatus,
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
    const resetForTrackChange = () => {
      baselines.current = { localTrack: null, outbound: null, remoteInbound: null, inbound: new Map() };
      if (!stopped) setStats(EMPTY_STATS);
    };
    room.on(RoomEvent.LocalTrackPublished, resetForTrackChange);
    room.on(RoomEvent.LocalTrackUnpublished, resetForTrackChange);
    room.on(RoomEvent.TrackSubscribed, resetForTrackChange);
    room.on(RoomEvent.TrackUnsubscribed, resetForTrackChange);
    room.on(RoomEvent.Reconnecting, resetForTrackChange);
    room.on(RoomEvent.Reconnected, resetForTrackChange);
    return () => {
      stopped = true;
      generation.current += 1;
      window.clearInterval(timer);
      running.current = false;
      room.off(RoomEvent.LocalTrackPublished, resetForTrackChange);
      room.off(RoomEvent.LocalTrackUnpublished, resetForTrackChange);
      room.off(RoomEvent.TrackSubscribed, resetForTrackChange);
      room.off(RoomEvent.TrackUnsubscribed, resetForTrackChange);
      room.off(RoomEvent.Reconnecting, resetForTrackChange);
      room.off(RoomEvent.Reconnected, resetForTrackChange);
    };
  }, [room, active, baselineVersion]);

  return stats;
}
