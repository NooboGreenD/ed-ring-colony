'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { IconMic, IconMicOff, IconHeadphones, IconVolumeOn, IconLock, IconTrash } from '@/components/Icons';

interface VoiceRoom {
  id: number;
  squadron_id: number;
  name: string;
  description: string | null;
  is_officer_only: boolean;
  sort_order: number;
  participant_count: number;
}

interface VoiceParticipant {
  id: number;
  room_id: number;
  user_id: string;
  cmdr_name: string | null;
  avatar_url: string | null;
  is_muted: boolean;
  is_deafened: boolean;
}

interface VoiceSignal {
  id: number;
  sender_id: string;
  target_id: string | null;
  signal_type: string;
  payload: any;
  created_at: string;
}

interface Props {
  squadronId: number;
  userId: string;
  isOfficer: boolean;
  myName: string;
}

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const SPEAKING_THRESHOLD = 15;
const VAD_CHECK_INTERVAL = 100;

export default function SquadronVoiceChat({ squadronId, userId, isOfficer, myName }: Props) {
  const [rooms, setRooms] = useState<VoiceRoom[]>([]);
  const [currentRoom, setCurrentRoom] = useState<number | null>(null);
  const [participants, setParticipants] = useState<VoiceParticipant[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomDesc, setNewRoomDesc] = useState('');
  const [newRoomOfficer, setNewRoomOfficer] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [speaking, setSpeaking] = useState<Record<string, boolean>>({});

  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Record<string, RTCPeerConnection>>({});
  const audioElementsRef = useRef<Record<string, HTMLAudioElement>>({});
  const processedSignalsRef = useRef<Set<number>>(new Set());
  const audioContextsRef = useRef<Record<string, AudioContext>>({});
  const analysersRef = useRef<Record<string, AnalyserNode>>({});
  const vadIntervalsRef = useRef<Record<string, number>>({});

  const loadRooms = useCallback(async () => {
    try {
      const res = await fetch(`/api/squadrons/${squadronId}/voice`);
      const json = await res.json();
      if (json.rooms) setRooms(json.rooms);
    } catch (e) {
      console.error('Failed to load rooms:', e);
    }
  }, [squadronId]);

  useEffect(() => {
    loadRooms();
    const interval = setInterval(loadRooms, 5000);
    return () => clearInterval(interval);
  }, [loadRooms]);

  const getLocalStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      return stream;
    } catch (e) {
      setError('Не удалось получить доступ к микрофону. Проверьте разрешения браузера.');
      throw e;
    }
  };

  const startVAD = (targetUserId: string, stream: MediaStream) => {
    if (vadIntervalsRef.current[targetUserId]) return;
    try {
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      audioContextsRef.current[targetUserId] = audioCtx;
      analysersRef.current[targetUserId] = analyser;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const check = () => {
        if (!analysersRef.current[targetUserId]) return;
        analysersRef.current[targetUserId].getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const isSpeaking = avg > SPEAKING_THRESHOLD;
        setSpeaking((prev) => {
          if (prev[targetUserId] === isSpeaking) return prev;
          return { ...prev, [targetUserId]: isSpeaking };
        });
      };
      const intervalId = window.setInterval(check, VAD_CHECK_INTERVAL);
      vadIntervalsRef.current[targetUserId] = intervalId;
    } catch (e) {
      console.error('VAD error:', e);
    }
  };

  const stopVAD = (targetUserId: string) => {
    if (vadIntervalsRef.current[targetUserId]) {
      clearInterval(vadIntervalsRef.current[targetUserId]);
      delete vadIntervalsRef.current[targetUserId];
    }
    if (audioContextsRef.current[targetUserId]) {
      audioContextsRef.current[targetUserId].close().catch(() => {});
      delete audioContextsRef.current[targetUserId];
    }
    if (analysersRef.current[targetUserId]) {
      delete analysersRef.current[targetUserId];
    }
    setSpeaking((prev) => {
      if (!prev[targetUserId]) return prev;
      const next = { ...prev };
      delete next[targetUserId];
      return next;
    });
  };

  const createPeerConnection = useCallback(
    (targetUserId: string, stream: MediaStream) => {
      const pc = new RTCPeerConnection(ICE_SERVERS);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal(targetUserId, 'ice-candidate', { candidate: event.candidate });
        }
      };
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        let audio = audioElementsRef.current[targetUserId];
        if (!audio) {
          audio = new Audio();
          audio.autoplay = true;
          audioElementsRef.current[targetUserId] = audio;
        }
        audio.srcObject = remoteStream;
        startVAD(targetUserId, remoteStream);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          pc.close();
          delete peerConnectionsRef.current[targetUserId];
          stopVAD(targetUserId);
          if (audioElementsRef.current[targetUserId]) {
            audioElementsRef.current[targetUserId].srcObject = null;
            delete audioElementsRef.current[targetUserId];
          }
        }
      };
      peerConnectionsRef.current[targetUserId] = pc;
      return pc;
    },
    []
  );

  const sendSignal = async (targetId: string | null, signalType: string, payload: any) => {
    if (!currentRoom) return;
    await fetch(`/api/squadrons/${squadronId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'signal', room_id: currentRoom, signal_type: signalType, target_id: targetId, payload }),
    });
  };

  const processSignal = useCallback(
    async (signal: VoiceSignal, stream: MediaStream) => {
      if (processedSignalsRef.current.has(signal.id)) return;
      processedSignalsRef.current.add(signal.id);
      const { sender_id, signal_type, payload } = signal;
      if (signal_type === 'join' && sender_id !== userId) {
        const pc = createPeerConnection(sender_id, stream);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await sendSignal(sender_id, 'offer', { sdp: offer });
      }
      if (signal_type === 'offer' && sender_id !== userId) {
        let pc = peerConnectionsRef.current[sender_id];
        if (!pc) pc = createPeerConnection(sender_id, stream);
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal(sender_id, 'answer', { sdp: answer });
      }
      if (signal_type === 'answer' && sender_id !== userId) {
        const pc = peerConnectionsRef.current[sender_id];
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      }
      if (signal_type === 'ice-candidate' && sender_id !== userId) {
        const pc = peerConnectionsRef.current[sender_id];
        if (pc) await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      }
      if (signal_type === 'leave' && sender_id !== userId) {
        const pc = peerConnectionsRef.current[sender_id];
        if (pc) {
          pc.close();
          delete peerConnectionsRef.current[sender_id];
        }
        stopVAD(sender_id);
        if (audioElementsRef.current[sender_id]) {
          audioElementsRef.current[sender_id].srcObject = null;
          delete audioElementsRef.current[sender_id];
        }
      }
    },
    [createPeerConnection, currentRoom, squadronId, userId]
  );

  const joinRoom = async (roomId: number) => {
    if (currentRoom === roomId) return;
    setLoading(true);
    setError('');
    try {
      if (currentRoom) await leaveRoom();
      const stream = await getLocalStream();
      const res = await fetch(`/api/squadrons/${squadronId}/voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'join', room_id: roomId }),
      });
      if (!res.ok) throw new Error('Failed to join room');
      setCurrentRoom(roomId);
      setIsConnected(true);
      const participantsRes = await fetch(`/api/squadrons/${squadronId}/voice?roomId=${roomId}`);
      const json = await participantsRes.json();
      setParticipants(json.participants || []);
      startVAD(userId, stream);
      for (const p of json.participants || []) {
        if (p.user_id !== userId) {
          const pc = createPeerConnection(p.user_id, stream);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await sendSignal(p.user_id, 'offer', { sdp: offer });
        }
      }
      for (const signal of json.signals || []) {
        if (signal.sender_id !== userId) await processSignal(signal, stream);
      }
    } catch (e: any) {
      setError(e.message || 'Ошибка подключения');
    } finally {
      setLoading(false);
    }
  };

  const leaveRoom = async () => {
    if (!currentRoom) return;
    Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
    peerConnectionsRef.current = {};
    Object.values(audioElementsRef.current).forEach((audio) => { audio.srcObject = null; });
    audioElementsRef.current = {};
    Object.keys(vadIntervalsRef.current).forEach((uid) => stopVAD(uid));
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    await fetch(`/api/squadrons/${squadronId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'leave', room_id: currentRoom }),
    });
    setCurrentRoom(null);
    setIsConnected(false);
    setParticipants([]);
    setIsMuted(false);
    setIsDeafened(false);
    setSpeaking({});
    processedSignalsRef.current.clear();
  };

  useEffect(() => {
    if (!currentRoom) return;
    const channel = supabase
      .channel(`voice_signals_${squadronId}_${currentRoom}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'squadron_voice_signals', filter: `room_id=eq.${currentRoom}` },
        async (payload) => {
          const signal = payload.new as VoiceSignal;
          if (signal.sender_id === userId) return;
          if (signal.target_id && signal.target_id !== userId) return;
          const stream = localStreamRef.current;
          if (stream) await processSignal(signal, stream);
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'squadron_voice_participants', filter: `room_id=eq.${currentRoom}` },
        () => {
          fetch(`/api/squadrons/${squadronId}/voice?roomId=${currentRoom}`)
            .then((r) => r.json())
            .then((json) => setParticipants(json.participants || []));
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'squadron_voice_participants', filter: `room_id=eq.${currentRoom}` },
        () => {
          fetch(`/api/squadrons/${squadronId}/voice?roomId=${currentRoom}`)
            .then((r) => r.json())
            .then((json) => setParticipants(json.participants || []));
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [currentRoom, squadronId, userId, processSignal]);

  const toggleMute = async () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = isMuted;
        setIsMuted(!isMuted);
        if (currentRoom) {
          await fetch(`/api/squadrons/${squadronId}/voice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'status', room_id: currentRoom, is_muted: !isMuted, is_deafened: isDeafened }),
          });
        }
      }
    }
  };

  const toggleDeafen = async () => {
    setIsDeafened(!isDeafened);
    Object.values(audioElementsRef.current).forEach((audio) => { audio.muted = !isDeafened; });
    if (currentRoom) {
      await fetch(`/api/squadrons/${squadronId}/voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status', room_id: currentRoom, is_muted: isMuted, is_deafened: !isDeafened }),
      });
    }
  };

  const createRoom = async () => {
    if (!newRoomName.trim()) return;
    const res = await fetch(`/api/squadrons/${squadronId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_room', name: newRoomName.trim(), description: newRoomDesc || null, is_officer_only: newRoomOfficer }),
    });
    if (res.ok) {
      setNewRoomName('');
      setNewRoomDesc('');
      setNewRoomOfficer(false);
      setShowCreateForm(false);
      loadRooms();
    }
  };

  const deleteRoom = async (roomId: number) => {
    if (!confirm('Удалить голосовую комнату?')) return;
    await fetch(`/api/squadrons/${squadronId}/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_room', room_id: roomId }),
    });
    loadRooms();
  };

  return (
    <div>
      {!currentRoom && (
        <div>
          <div className='voice-header' style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 14, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase', letterSpacing: 1 }}>
              Голосовые каналы
            </h3>
            {isOfficer && (
              <button onClick={() => setShowCreateForm(!showCreateForm)} className='btn' style={{ fontSize: 11, padding: '4px 10px' }}>
                {showCreateForm ? 'Отмена' : '+ Канал'}
              </button>
            )}
          </div>
          {showCreateForm && isOfficer && (
            <div className='card' style={{ marginBottom: 16, background: '#25282b', padding: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input placeholder='Название канала' value={newRoomName} onChange={(e) => setNewRoomName(e.target.value)} style={{ fontSize: 13 }} />
                <input placeholder='Описание (необязательно)' value={newRoomDesc} onChange={(e) => setNewRoomDesc(e.target.value)} style={{ fontSize: 13 }} />
                <label style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type='checkbox' checked={newRoomOfficer} onChange={(e) => setNewRoomOfficer(e.target.checked)} />
                  Только для офицеров
                </label>
                <button onClick={createRoom} className='btn btn-cyan' style={{ fontSize: 12 }}>Создать канал</button>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rooms.map((room) => (
              <div key={room.id} className='voice-room-card card' style={{ background: '#1a1c1e', border: '1px solid #2d3033', padding: '12px 16px', cursor: 'pointer', transition: 'border-color 0.2s', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#e67e22')}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#2d3033')}
                onClick={() => joinRoom(room.id)}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {room.is_officer_only && <span style={{ fontSize: 10, color: '#e67e22', fontFamily: 'ui-monospace, monospace', display: 'flex', alignItems: 'center' }}><IconLock size={10} /></span>}
                    {room.name}
                  </div>
                  {room.description && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{room.description}</div>}
                </div>
                <div className='voice-room-meta' style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 12, color: room.participant_count > 0 ? '#22c55e' : 'var(--muted)', fontFamily: 'ui-monospace, monospace' }}>
                    ● {room.participant_count}
                  </span>
                  {isOfficer && (
                    <button onClick={(e) => { e.stopPropagation(); deleteRoom(room.id); }} style={{ background: 'none', border: 'none', color: '#e74c3c', cursor: 'pointer', fontSize: 16, padding: '0 4px' }} title='Удалить'><IconTrash size={14} /></button>
                  )}
                </div>
              </div>
            ))}
            {rooms.length === 0 && <p style={{ color: 'var(--muted)', textAlign: 'center', padding: 20 }}>Голосовых каналов пока нет</p>}
          </div>
        </div>
      )}
      {currentRoom && (
        <div>
          <div className='voice-header' style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14, color: '#22c55e', fontFamily: 'ui-monospace, monospace' }}>
                ● Подключено: {rooms.find((r) => r.id === currentRoom)?.name || 'Канал'}
              </h3>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{participants.length} пилотов в канале</div>
            </div>
            <button onClick={leaveRoom} className='btn' style={{ fontSize: 11, padding: '4px 12px', borderColor: '#e74c3c', color: '#e74c3c' }}>Отключиться</button>
          </div>
          {error && (
            <div style={{ color: '#e74c3c', fontSize: 12, marginBottom: 12, padding: 8, background: 'rgba(231,76,60,0.1)', borderRadius: 4 }}>{error}</div>
          )}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' }}>Пилоты в канале</div>
            <div className='voice-participants-row' style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {participants.map((p) => {
                const isSpeaking = speaking[p.user_id];
                return (
                  <div key={p.user_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: '#25282b', borderRadius: 4, border: `2px solid ${isSpeaking ? '#22c55e' : p.user_id === userId ? '#e67e2255' : '#2d3033'}`, flexShrink: 0, transition: 'border-color 0.15s ease', position: 'relative' }}>
                    {p.avatar_url ? (
                      <img src={p.avatar_url} alt='' style={{ width: 24, height: 24, borderRadius: '50%', border: isSpeaking ? '2px solid #22c55e' : 'none', transition: 'border 0.15s ease' }} />
                    ) : (
                      <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#323538', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#9ca3af', border: isSpeaking ? '2px solid #22c55e' : 'none', transition: 'border 0.15s ease' }}>
                        {(p.cmdr_name || '?')[0]?.toUpperCase()}
                      </div>
                    )}
                    <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', color: isSpeaking ? '#22c55e' : 'var(--text)', transition: 'color 0.15s ease' }}>
                      {p.cmdr_name || 'Неизвестный'}{p.user_id === userId && ' (Вы)'}
                    </span>
                    {isSpeaking && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', animation: 'pulse 1s infinite', flexShrink: 0 }} />}
                    {p.is_muted && !isSpeaking && <span style={{ fontSize: 10, color: '#e74c3c', display: 'flex', alignItems: 'center' }}><IconMicOff size={10} /></span>}
                    {p.is_deafened && !isSpeaking && <span style={{ fontSize: 10, color: '#e74c3c', display: 'flex', alignItems: 'center' }}><IconHeadphones size={10} /></span>}
                  </div>
                );
              })}
            </div>
          </div>
          <div className='voice-controls' style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button onClick={toggleMute} className='btn' style={{ fontSize: 12, padding: '8px 16px', background: isMuted ? 'rgba(231,76,60,0.15)' : 'rgba(34,197,94,0.15)', borderColor: isMuted ? '#e74c3c' : '#22c55e', color: isMuted ? '#e74c3c' : '#22c55e' }}>
              {isMuted ? <><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><IconMicOff size={14} /> Включить микрофон</span></> : <><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><IconMic size={14} /> Выключить микрофон</span></>}
            </button>
            <button onClick={toggleDeafen} className='btn' style={{ fontSize: 12, padding: '8px 16px', background: isDeafened ? 'rgba(231,76,60,0.15)' : undefined, borderColor: isDeafened ? '#e74c3c' : undefined, color: isDeafened ? '#e74c3c' : undefined }}>
              {isDeafened ? <><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><IconVolumeOn size={14} /> Включить звук</span></> : <><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><IconHeadphones size={14} /> Выключить звук</span></>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
