import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import {
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  setAudioModeAsync,
  AudioModule,
} from 'expo-audio';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import { io } from 'socket.io-client';

const API_BASE = 'https://web-production-0166f.up.railway.app';
/** Default Engine.IO path; handshake uses e.g. wss://host/socket.io/?EIO=4&transport=websocket */
const SOCKET_IO_PATH = '/socket.io';
const PUSH_REGISTERED_KEY = 'angel_push_token_registered';
const VISION_ANALYZE_QUESTION =
  'What do you see? Describe everything relevant to my mission.';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldAnimate: true,
  }),
});

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa !== 'undefined') {
    return btoa(binary);
  }
  const key = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let base64 = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    base64 += key[a >> 2];
    base64 += key[((a & 3) << 4) | (b >> 4)];
    base64 += i + 1 < bytes.length ? key[((b & 15) << 2) | (c >> 6)] : '=';
    base64 += i + 2 < bytes.length ? key[c & 63] : '=';
  }
  return base64;
}

function formatDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isToday(dateStr) {
  if (!dateStr) return false;
  return dateStr === formatDateKey(new Date());
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseAngelReply(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  return (
    data?.reply ??
    data?.response ??
    data?.text ??
    data?.message ??
    ''
  );
}

export default function App() {
  const [mode, setMode] = useState('voice'); // 'voice' | 'text'
  const [layoutWidth, setLayoutWidth] = useState(0);

  const [messages, setMessages] = useState([]); // {id, role: 'user'|'assistant', content, kind?}
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);

  const [briefingBadge, setBriefingBadge] = useState(false);

  const [orbState, setOrbState] = useState('idle'); // 'idle' | 'listening' | 'speaking'

  const listRef = useRef(null);
  const socketRef = useRef(null);
  const expectingResponseRef = useRef(false);
  const playTTSRef = useRef(null);
  /** Latest UI mode for socket handlers (voice | text) */
  const modeRef = useRef(mode);
  /** True if the in-flight socket reply is for a `user_audio` emit (not `user_text`) */
  const lastSocketRequestWasVoiceRef = useRef(false);

  const [socketConnected, setSocketConnected] = useState(false);

  const [visionModalVisible, setVisionModalVisible] = useState(false);
  const [visionImageBase64, setVisionImageBase64] = useState('');
  const [visionPreviewUri, setVisionPreviewUri] = useState('');
  const [visionQuestionText, setVisionQuestionText] = useState('');
  const [visionSending, setVisionSending] = useState(false);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // SDK 55: call with no args when source is set later via replace() (avoids native ctor mismatch)
  const ttsPlayer = useAudioPlayer();
  const ttsStatus = useAudioPlayerStatus(ttsPlayer);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder);
  const isRecording = recorderState?.isRecording ?? false;

  const wasPlayingTtsRef = useRef(false);
  useEffect(() => {
    if (ttsStatus?.playing) {
      wasPlayingTtsRef.current = true;
    } else if (wasPlayingTtsRef.current) {
      wasPlayingTtsRef.current = false;
      setOrbState('idle');
      console.log('[TTS] step: playback finished (expo-audio), orb idle');
    }
  }, [ttsStatus?.playing]);

  const modeAnim = useRef(new Animated.Value(0)).current; // 0 voice, 1 text

  // Orb animation values
  const idlePulse = useRef(new Animated.Value(0)).current;
  const ripple = useRef(new Animated.Value(0)).current;
  const focus = useRef(new Animated.Value(0)).current; // listening intensity

  const glowColor = '#6D28FF'; // deep purple
  const glowColor2 = '#2563FF'; // deep blue

  // Smooth slide between modes
  useEffect(() => {
    Animated.timing(modeAnim, {
      toValue: mode === 'text' ? 1 : 0,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [mode, modeAnim]);

  // Orb idle pulse loop
  useEffect(() => {
    idlePulse.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(idlePulse, {
          toValue: 1,
          duration: 1800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(idlePulse, {
          toValue: 0,
          duration: 1800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [idlePulse]);

  // Listening focus animation (fast expand)
  useEffect(() => {
    Animated.timing(focus, {
      toValue: orbState === 'listening' ? 1 : 0,
      duration: orbState === 'listening' ? 140 : 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [orbState, focus]);

  // Speaking ripple loop
  useEffect(() => {
    ripple.stopAnimation();
    ripple.setValue(0);
    let loop;
    if (orbState === 'speaking') {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(ripple, {
            toValue: 1,
            duration: 900,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(ripple, {
            toValue: 0,
            duration: 10,
            useNativeDriver: true,
          }),
        ])
      );
      loop.start();
    }
    return () => {
      if (loop) loop.stop();
    };
  }, [orbState, ripple]);

  // Fetch briefing on launch and insert as first assistant message (text mode)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/briefing`);
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        const content = data?.briefing ?? data?.content ?? data?.text;
        const date = data?.date ?? data?.created_at ?? data?.createdAt;
        if (content && (!date || isToday(date))) {
          setMessages((prev) => {
            if (prev.some((m) => m.kind === 'briefing')) return prev;
            return [
              {
                id: makeId(),
                role: 'assistant',
                content,
                kind: 'briefing',
              },
              ...prev,
            ];
          });
          setBriefingBadge(true);
        }
      } catch (_) {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Register Expo push token once per install (Railway backend)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const already = await AsyncStorage.getItem(PUSH_REGISTERED_KEY);
        if (already === '1') {
          console.log('[push] already registered this install, skipping');
          return;
        }
        if (!Device.isDevice) {
          console.log('[push] not a physical device, skipping');
          return;
        }
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('angel-default', {
            name: 'Angel',
            importance: Notifications.AndroidImportance.HIGH,
            vibrationPattern: [0, 250, 250, 250],
            lightColor: '#6D28FF',
          });
        }
        const { status: existing } = await Notifications.getPermissionsAsync();
        let finalStatus = existing;
        if (existing !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }
        if (finalStatus !== 'granted') {
          console.log('[push] notification permission not granted');
          return;
        }
        const projectId =
          Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
        if (!projectId) {
          console.warn('[push] missing EAS projectId in app config');
          return;
        }
        const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
        const token = tokenData?.data;
        if (!token || cancelled) return;
        const res = await fetch(`${API_BASE}/api/register_push_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, user_id: 'tyler' }),
        });
        if (res.ok) {
          await AsyncStorage.setItem(PUSH_REGISTERED_KEY, '1');
          console.log('[push] token registered with backend');
        } else {
          console.warn('[push] register_push_token failed:', res.status);
        }
      } catch (e) {
        console.warn('[push] registration error:', e?.message ?? e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Clear briefing badge once user visits text mode (they've "seen" it)
  useEffect(() => {
    if (mode === 'text') setBriefingBadge(false);
  }, [mode]);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === 'voice' ? 'text' : 'voice'));
  }, []);

  const closeVisionModal = useCallback(() => {
    setVisionModalVisible(false);
    setVisionImageBase64('');
    setVisionPreviewUri('');
    setVisionQuestionText('');
  }, []);

  const openCameraForVision = useCallback(async () => {
    if (loading || visionSending || visionModalVisible) return;
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        console.warn('[vision] camera permission denied:', status);
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.85,
        base64: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      let b64 = asset.base64;
      if (!b64 && asset.uri) {
        try {
          b64 = await FileSystemLegacy.readAsStringAsync(asset.uri, {
            encoding: FileSystemLegacy.EncodingType.Base64,
          });
        } catch (readErr) {
          console.warn('[vision] read image base64 failed:', readErr);
          return;
        }
      }
      if (!b64) {
        console.warn('[vision] no base64 available for captured image');
        return;
      }
      setVisionImageBase64(b64);
      setVisionPreviewUri(asset.uri ?? '');
      setVisionQuestionText('');
      setVisionModalVisible(true);
    } catch (e) {
      console.warn('[vision] camera error:', e?.message ?? e);
    }
  }, [loading, visionSending, visionModalVisible]);

  const playTTS = useCallback(async (text) => {
    if (!text?.trim()) return;
    let step = 'init';
    try {
      step = 'setOrbState';
      setOrbState('speaking');

      step = 'setAudioModeAsync (expo-audio)';
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: false,
        shouldPlayInBackground: false,
      });
      console.log('[TTS] step: audio mode set (expo-audio)');

      step = 'fetch';
      const res = await fetch(`${API_BASE}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const responseStatus = res.status;
      const contentType = res.headers.get('content-type') ?? null;
      console.log('[TTS] step: fetch done:', { status: responseStatus, contentType });

      if (!res.ok) {
        console.log('[TTS] non-OK response, skipping playback');
        setOrbState('idle');
        return;
      }

      step = 'arrayBuffer';
      const arrayBuffer = await res.arrayBuffer();
      const bufferSizeBytes = arrayBuffer.byteLength;
      console.log('[TTS] step: arrayBuffer done, size (bytes):', bufferSizeBytes);

      step = 'arrayBufferToBase64';
      const base64 = arrayBufferToBase64(arrayBuffer);
      console.log('[TTS] step: base64 done, length:', base64?.length ?? 0);

      step = 'writeAsStringAsync';
      const fileUri = FileSystemLegacy.cacheDirectory + 'tts_' + Date.now() + '.mp3';
      try {
        await FileSystemLegacy.writeAsStringAsync(fileUri, base64, {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
        console.log('[TTS] step: file written:', fileUri);
      } catch (writeErr) {
        console.error('[TTS] writeAsStringAsync failed:', {
          message: writeErr?.message ?? String(writeErr),
          toString: writeErr?.toString?.(),
          name: writeErr?.name,
          stack: writeErr?.stack,
          full: writeErr,
        });
        throw writeErr;
      }

      step = 'ttsPlayer.replace';
      await ttsPlayer.replace(fileUri);
      console.log('[TTS] step: player.replace done');

      step = 'ttsPlayer.play';
      ttsPlayer.play();
      console.log('[TTS] step: player.play called');
    } catch (err) {
      console.error('[TTS] error at step:', step, {
        message: err?.message ?? String(err),
        name: err?.name,
        stack: err?.stack,
        full: err,
      });
      setOrbState('idle');
    }
  }, [ttsPlayer]);

  useEffect(() => {
    playTTSRef.current = playTTS;
  }, [playTTS]);

  const submitVision = useCallback(
    async (question) => {
      const q = (question || '').trim();
      if (!q || !visionImageBase64 || visionSending) return;
      setVisionSending(true);
      try {
        const res = await fetch(`${API_BASE}/api/vision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: visionImageBase64,
            question: q,
            device: 'ios',
          }),
        });
        const data = await res.json().catch(() => ({}));
        console.log('[vision] /api/vision response:', { status: res.status, data });
        const reply =
          parseAngelReply(data) || (typeof data === 'string' ? data : '');
        const userLine = `📷 ${q}`;
        setMessages((prev) => [
          ...prev,
          { id: makeId(), role: 'user', content: userLine },
          {
            id: makeId(),
            role: 'assistant',
            content: reply || "I couldn't interpret that image. Try again.",
          },
        ]);
        closeVisionModal();
        const finalReply = reply || '';
        if (finalReply && modeRef.current === 'voice') {
          await playTTS(finalReply);
        } else if (!finalReply) {
          setOrbState('idle');
        }
      } catch (e) {
        console.warn('[vision] request failed:', e?.message ?? e);
        setMessages((prev) => [
          ...prev,
          {
            id: makeId(),
            role: 'assistant',
            content: 'Vision request failed. Check your connection and try again.',
          },
        ]);
        closeVisionModal();
      } finally {
        setVisionSending(false);
      }
    },
    [visionImageBase64, visionSending, playTTS, closeVisionModal]
  );

  // Socket.IO — real-time text/voice; HTTP used when disconnected
  useEffect(() => {
    console.log('[socket] initializing client', {
      url: API_BASE,
      path: SOCKET_IO_PATH,
      auth: { device: 'ios' },
      transports: ['websocket', 'polling'],
    });

    const socket = io(API_BASE, {
      path: SOCKET_IO_PATH,
      auth: { device: 'ios' },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
    });
    socketRef.current = socket;

    const onConnect = () => {
      setSocketConnected(true);
      const transport = socket.io?.engine?.transport?.name ?? 'unknown';
      console.log('[socket] connected', {
        id: socket.id,
        connected: socket.connected,
        transport,
        url: API_BASE,
        path: SOCKET_IO_PATH,
      });
    };
    const onDisconnect = (reason) => {
      setSocketConnected(false);
      if (expectingResponseRef.current) {
        expectingResponseRef.current = false;
        setLoading(false);
        setOrbState('idle');
      }
      console.log('[socket] disconnected', { reason, url: API_BASE, path: SOCKET_IO_PATH });
    };
    const onConnectError = (err) => {
      setSocketConnected(false);
      console.warn('[socket] connect_error', {
        message: err?.message ?? String(err),
        description: err?.description,
        context: err?.context,
        type: err?.type,
        data: err?.data,
        url: API_BASE,
        path: SOCKET_IO_PATH,
      });
    };

    const onAngelThinking = () => {
      if (expectingResponseRef.current) {
        setLoading(true);
      }
    };

    const onAngelTranscript = (payload) => {
      const text =
        typeof payload === 'string'
          ? payload
          : payload?.transcript ?? payload?.text ?? '';
      const trimmed = (text || '').trim();
      if (trimmed) {
        setMessages((prev) => [...prev, { id: makeId(), role: 'user', content: trimmed }]);
      }
    };

    const onAngelResponse = (data) => {
      expectingResponseRef.current = false;
      setLoading(false);
      const reply = parseAngelReply(data);
      const fromVoice = lastSocketRequestWasVoiceRef.current;
      const inVoiceMode = modeRef.current === 'voice';
      const shouldPlayTTS = inVoiceMode || fromVoice;
      console.log('[socket] angel_response:', {
        data,
        inVoiceMode,
        fromVoiceRequest: fromVoice,
        shouldPlayTTS,
      });
      if (reply) {
        setMessages((prev) => [
          ...prev,
          { id: makeId(), role: 'assistant', content: reply },
        ]);
        if (shouldPlayTTS) {
          playTTSRef.current?.(reply);
        } else {
          setOrbState('idle');
        }
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: makeId(),
            role: 'assistant',
            content: "Sorry, I couldn't process that.",
          },
        ]);
        setOrbState('idle');
      }
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('angel_thinking', onAngelThinking);
    socket.on('angel_transcript', onAngelTranscript);
    socket.on('angel_response', onAngelResponse);

    const mgr = socket.io;
    const onReconnectAttempt = (n) => {
      console.log('[socket] reconnect_attempt', { attempt: n, url: API_BASE, path: SOCKET_IO_PATH });
    };
    const onReconnect = (n) => {
      console.log('[socket] reconnect OK', { attempts: n, url: API_BASE, path: SOCKET_IO_PATH });
    };
    const onReconnectError = (e) => {
      console.warn('[socket] reconnect_error', {
        message: e?.message ?? String(e),
        url: API_BASE,
        path: SOCKET_IO_PATH,
      });
    };
    const onReconnectFailed = () => {
      console.warn('[socket] reconnect_failed (giving up)', { url: API_BASE, path: SOCKET_IO_PATH });
    };
    mgr.on('reconnect_attempt', onReconnectAttempt);
    mgr.on('reconnect', onReconnect);
    mgr.on('reconnect_error', onReconnectError);
    mgr.on('reconnect_failed', onReconnectFailed);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('angel_thinking', onAngelThinking);
      socket.off('angel_transcript', onAngelTranscript);
      socket.off('angel_response', onAngelResponse);
      mgr.off('reconnect_attempt', onReconnectAttempt);
      mgr.off('reconnect', onReconnect);
      mgr.off('reconnect_error', onReconnectError);
      mgr.off('reconnect_failed', onReconnectFailed);
      socket.disconnect();
      socketRef.current = null;
      setSocketConnected(false);
      console.log('[socket] client torn down', { url: API_BASE, path: SOCKET_IO_PATH });
    };
  }, []);

  const sendTextMessage = useCallback(async () => {
    const trimmed = (inputText || '').trim();
    if (!trimmed || loading) return;

    setInputText('');
    const userMsg = { id: makeId(), role: 'user', content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    const socket = socketRef.current;
    if (socket?.connected) {
      lastSocketRequestWasVoiceRef.current = false;
      expectingResponseRef.current = true;
      setLoading(true);
      socket.emit('user_text', { message: trimmed });
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, device: 'ios' }),
      });
      const data = await res.json().catch(() => ({}));
      console.log('API /api/message response:', data);
      const reply = parseAngelReply(data) || (typeof data === 'string' ? data : '');

      const assistantMsg = {
        id: makeId(),
        role: 'assistant',
        content: reply || 'Sorry, I couldn’t process that.',
      };
      setMessages((prev) => [...prev, assistantMsg]);
      /* Text mode: show reply only, no TTS */
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { id: makeId(), role: 'assistant', content: 'Something went wrong. Please try again.' },
      ]);
    } finally {
      setLoading(false);
    }
  }, [inputText, loading]);

  const startRecording = useCallback(async () => {
    try {
      if (loading) return;
      setOrbState('listening');

      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm?.granted) {
        setOrbState('idle');
        return;
      }

      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
        shouldPlayInBackground: false,
      });

      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
    } catch (_) {
      setOrbState('idle');
    }
  }, [loading, audioRecorder]);

  const stopRecording = useCallback(async () => {
    if (!recorderState?.isRecording) {
      setOrbState('idle');
      return;
    }
    let awaitingSocketVoice = false;
    try {
      await audioRecorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const uri = audioRecorder.uri;

      if (!uri) {
        setOrbState('idle');
        return;
      }

      const socket = socketRef.current;
      if (socket?.connected) {
        let audioBase64;
        try {
          audioBase64 = await FileSystemLegacy.readAsStringAsync(uri, {
            encoding: FileSystemLegacy.EncodingType.Base64,
          });
        } catch (readErr) {
          console.warn('[voice] readAsStringAsync failed:', readErr);
          setOrbState('idle');
          return;
        }
        lastSocketRequestWasVoiceRef.current = true;
        expectingResponseRef.current = true;
        setLoading(true);
        socket.emit('user_audio', {
          audio_base64: audioBase64,
          filename: 'voice.m4a',
        });
        awaitingSocketVoice = true;
        return;
      }

      setLoading(true);
      const form = new FormData();
      form.append('audio', {
        uri,
        type: 'audio/m4a',
        name: 'voice.m4a',
      });
      form.append('device', 'ios');
      const res = await fetch(`${API_BASE}/api/voice`, {
        method: 'POST',
        body: form,
        headers: { Accept: 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      console.log('API /api/voice response:', data);
      const transcript = data?.transcript ?? data?.text ?? '';
      const reply =
        data?.reply ??
        data?.response ??
        data?.text_response ??
        data?.message ??
        data?.text ??
        '';

      if (transcript) {
        setMessages((prev) => [...prev, { id: makeId(), role: 'user', content: transcript }]);
      }
      if (reply) {
        setMessages((prev) => [...prev, { id: makeId(), role: 'assistant', content: reply }]);
        await playTTS(reply);
      } else {
        setOrbState('idle');
      }
    } catch (_) {
      setOrbState('idle');
      setMessages((prev) => [
        ...prev,
        { id: makeId(), role: 'assistant', content: 'Voice message could not be sent.' },
      ]);
    } finally {
      if (!awaitingSocketVoice) {
        setLoading(false);
      }
    }
  }, [recorderState?.isRecording, audioRecorder, playTTS]);

  const orbScale = useMemo(() => {
    const idleS = idlePulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] });
    const listenS = focus.interpolate({ inputRange: [0, 1], outputRange: [0, 0.12] });
    return Animated.add(idleS, listenS);
  }, [idlePulse, focus]);

  const coreGlowOpacity = useMemo(() => {
    const idleO = idlePulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.55] });
    const listenBoost = focus.interpolate({ inputRange: [0, 1], outputRange: [0, 0.35] });
    return Animated.add(idleO, listenBoost);
  }, [idlePulse, focus]);

  const rippleScale = useMemo(
    () => ripple.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }),
    [ripple]
  );
  const rippleOpacity = useMemo(
    () => ripple.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }),
    [ripple]
  );

  const translateX = useMemo(() => {
    if (!layoutWidth) return modeAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -360] });
    return modeAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -layoutWidth] });
  }, [layoutWidth, modeAnim]);

  const renderMessage = useCallback(({ item }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        {item.kind === 'briefing' ? (
          <Text style={styles.briefingLabel}>Morning briefing</Text>
        ) : null}
        <Text style={styles.bubbleText}>{item.content}</Text>
      </View>
    );
  }, []);

  const statusBarHeight = Constants.statusBarHeight ?? 50;

  return (
    <View
      style={[styles.root, { paddingTop: statusBarHeight }]}
      onLayout={(e) => setLayoutWidth(e.nativeEvent.layout.width)}
    >
      <StatusBar style="light" />

      <View style={styles.topBar}>
        <View style={styles.topBarLeft}>
          <View
            style={[
              styles.connDot,
              { backgroundColor: socketConnected ? '#22C55E' : '#6B7280' },
            ]}
          />
          <Text style={styles.topTitle}>Angel</Text>
        </View>
        <TouchableOpacity onPress={toggleMode} style={styles.modeToggle}>
          <Text style={styles.modeToggleText}>{mode === 'voice' ? 'Text' : 'Voice'}</Text>
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={styles.keyboardAvoiding}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <Animated.View
          style={[
            styles.pager,
            {
              width: layoutWidth ? layoutWidth * 2 : '200%',
              transform: [{ translateX }],
            },
          ]}
        >
        {/* Voice Mode */}
        <View style={[styles.page, { width: layoutWidth || '50%' }]}>
          <View style={styles.voicePage}>
            <View style={styles.voiceCenter}>
            <Text style={styles.voiceName}>Angel</Text>

            <View style={styles.orbWrap}>
              {/* Ripple ring when speaking */}
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.rippleRing,
                  {
                    opacity: orbState === 'speaking' ? rippleOpacity : 0,
                    transform: [{ scale: rippleScale }],
                    shadowColor: glowColor2,
                  },
                ]}
              />

              {/* Orb */}
              <Animated.View
                style={[
                  styles.orb,
                  {
                    transform: [{ scale: orbScale }],
                    shadowColor: glowColor,
                  },
                ]}
              >
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.orbGlow,
                    { opacity: coreGlowOpacity, backgroundColor: glowColor },
                  ]}
                />
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.orbGlow2,
                    {
                      opacity: coreGlowOpacity,
                      backgroundColor: glowColor2,
                    },
                  ]}
                />

                {briefingBadge ? <View style={styles.orbBadge} /> : null}
              </Animated.View>
            </View>

            <Text style={styles.voiceHint}>
              {loading
                ? socketConnected
                  ? 'Angel is thinking…'
                  : 'Connecting…'
                : orbState === 'speaking'
                  ? 'Angel is speaking…'
                  : isRecording
                    ? 'Listening…'
                    : 'Hold to speak'}
            </Text>

            <Pressable
              style={[styles.holdToSpeak, isRecording && styles.holdToSpeakActive]}
              onPressIn={startRecording}
              onPressOut={stopRecording}
            >
              <Text style={styles.holdToSpeakText}>{isRecording ? 'Release' : 'Hold'}</Text>
            </Pressable>
            </View>
            <View style={styles.voiceBottomBar}>
              <TouchableOpacity
                style={styles.cameraIconBtn}
                onPress={openCameraForVision}
                disabled={loading || visionSending || visionModalVisible}
                accessibilityLabel="Open camera for vision"
              >
                <Ionicons name="camera" size={22} color="#E5E7EB" />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Text Mode */}
        <View style={[styles.page, { width: layoutWidth || '50%' }]}>
          <View style={styles.textWrap}>
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={(m) => m.id}
              renderItem={renderMessage}
              contentContainerStyle={styles.listContent}
              onContentSizeChange={() => listRef.current?.scrollToEnd?.({ animated: true })}
              onLayout={() => listRef.current?.scrollToEnd?.({ animated: false })}
              ListEmptyComponent={
                <Text style={styles.emptyText}>Type a message to begin.</Text>
              }
            />

            <View style={styles.inputRow}>
              <TouchableOpacity
                style={styles.inputRowCamera}
                onPress={openCameraForVision}
                disabled={loading || visionSending || visionModalVisible}
                accessibilityLabel="Open camera for vision"
              >
                <Ionicons name="camera" size={22} color="#E5E7EB" />
              </TouchableOpacity>
              <TextInput
                style={styles.input}
                placeholder="Message Angel…"
                placeholderTextColor="#6B7280"
                value={inputText}
                onChangeText={setInputText}
                editable={!loading}
                multiline
                onSubmitEditing={sendTextMessage}
              />
              <TouchableOpacity
                style={[styles.sendBtn, loading && styles.sendBtnDisabled]}
                onPress={sendTextMessage}
                disabled={loading}
              >
                {loading ? (
                  <ActivityIndicator size="small" color="#000" />
                ) : (
                  <Text style={styles.sendBtnText}>Send</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Animated.View>
      </KeyboardAvoidingView>

      <Modal
        visible={visionModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => {
          if (!visionSending) closeVisionModal();
        }}
      >
        <KeyboardAvoidingView
          style={styles.visionModalRoot}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => {
              if (!visionSending) closeVisionModal();
            }}
          />
          <View style={styles.visionModalCard}>
            <Text style={styles.visionModalTitle}>What do you want to know?</Text>
            {visionPreviewUri ? (
              <Image
                source={{ uri: visionPreviewUri }}
                style={styles.visionPreview}
                resizeMode="cover"
              />
            ) : null}
            <TextInput
              style={styles.visionQuestionInput}
              placeholder="What do you want to know?"
              placeholderTextColor="#6B7280"
              value={visionQuestionText}
              onChangeText={setVisionQuestionText}
              editable={!visionSending}
              multiline
              maxLength={2000}
            />
            <TouchableOpacity
              style={styles.visionAnalyzeBtn}
              onPress={() => submitVision(VISION_ANALYZE_QUESTION)}
              disabled={visionSending || !visionImageBase64}
            >
              <Text style={styles.visionAnalyzeBtnText}>Analyze</Text>
              <Text style={styles.visionAnalyzeHint} numberOfLines={2}>
                {VISION_ANALYZE_QUESTION}
              </Text>
            </TouchableOpacity>
            <View style={styles.visionModalActions}>
              <TouchableOpacity
                style={styles.visionCancelBtn}
                onPress={() => {
                  if (!visionSending) closeVisionModal();
                }}
                disabled={visionSending}
              >
                <Text style={styles.visionCancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.visionSendBtn,
                  (!visionQuestionText.trim() || visionSending) && styles.visionSendBtnDisabled,
                ]}
                onPress={() => submitVision(visionQuestionText)}
                disabled={!visionQuestionText.trim() || visionSending || !visionImageBase64}
              >
                {visionSending ? (
                  <ActivityIndicator size="small" color="#000" />
                ) : (
                  <Text style={styles.visionSendBtnText}>Send</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  keyboardAvoiding: { flex: 1 },

  topBar: {
    height: 56,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#111827',
    backgroundColor: '#000',
  },
  topBarLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  connDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  topTitle: { color: '#fff', fontSize: 18, fontWeight: '600', letterSpacing: 0.3 },
  modeToggle: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1F2937',
  },
  modeToggleText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  pager: { flex: 1, flexDirection: 'row' },
  page: { flex: 1, backgroundColor: '#000' },

  // Voice mode
  voicePage: { flex: 1 },
  voiceCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  voiceBottomBar: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#111827',
    backgroundColor: '#000',
  },
  cameraIconBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1F2937',
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceName: { color: '#fff', fontSize: 22, fontWeight: '600', marginBottom: 22 },
  orbWrap: { alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  rippleRing: {
    position: 'absolute',
    width: 220,
    height: 220,
    borderRadius: 110,
    borderWidth: 2,
    borderColor: 'rgba(99,102,241,0.55)',
    shadowOpacity: 0.5,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
  },
  orb: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: '#050509',
    borderWidth: 1,
    borderColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.85,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
    overflow: 'hidden',
  },
  orbGlow: {
    position: 'absolute',
    width: 190,
    height: 190,
    borderRadius: 95,
    opacity: 0.5,
  },
  orbGlow2: {
    position: 'absolute',
    width: 240,
    height: 240,
    borderRadius: 120,
    opacity: 0.35,
  },
  orbBadge: {
    position: 'absolute',
    top: 14,
    right: 14,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#A78BFA',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  voiceHint: { color: '#9CA3AF', fontSize: 14, marginBottom: 18 },
  holdToSpeak: {
    width: 180,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0B0F1A',
    borderWidth: 1,
    borderColor: '#1F2937',
  },
  holdToSpeakActive: {
    backgroundColor: '#111827',
    borderColor: '#374151',
  },
  holdToSpeakText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  // Text mode
  textWrap: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingVertical: 16, paddingBottom: 18 },
  emptyText: { color: '#6B7280', textAlign: 'center', marginTop: 36, fontSize: 15 },
  bubble: {
    maxWidth: '88%',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    marginBottom: 10,
  },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#111827', borderWidth: 1, borderColor: '#1F2937' },
  assistantBubble: { alignSelf: 'flex-start', backgroundColor: '#050509', borderWidth: 1, borderColor: '#111827' },
  briefingLabel: { color: '#A78BFA', fontSize: 12, fontWeight: '700', marginBottom: 6, letterSpacing: 0.4 },
  bubbleText: { color: '#fff', fontSize: 16, lineHeight: 22 },
  inputRow: {
    paddingHorizontal: 10,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#111827',
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-end',
    backgroundColor: '#000',
  },
  inputRowCamera: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1F2937',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 0,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#050509',
    color: '#fff',
    borderWidth: 1,
    borderColor: '#111827',
    fontSize: 16,
  },
  sendBtn: {
    height: 44,
    paddingHorizontal: 18,
    borderRadius: 22,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.7 },
  sendBtnText: { color: '#000', fontSize: 15, fontWeight: '700' },

  visionModalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.88)',
  },
  visionModalCard: {
    backgroundColor: '#0B0F1A',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: '#1F2937',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 28,
  },
  visionModalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 14,
    textAlign: 'center',
  },
  visionPreview: {
    width: 140,
    height: 140,
    borderRadius: 12,
    alignSelf: 'center',
    marginBottom: 16,
    backgroundColor: '#111827',
  },
  visionQuestionInput: {
    minHeight: 88,
    maxHeight: 160,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#050509',
    color: '#fff',
    borderWidth: 1,
    borderColor: '#111827',
    fontSize: 16,
    marginBottom: 14,
    textAlignVertical: 'top',
  },
  visionAnalyzeBtn: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#374151',
    marginBottom: 16,
  },
  visionAnalyzeBtnText: {
    color: '#A78BFA',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 6,
  },
  visionAnalyzeHint: {
    color: '#9CA3AF',
    fontSize: 12,
    lineHeight: 17,
  },
  visionModalActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  visionCancelBtn: {
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  visionCancelBtnText: {
    color: '#9CA3AF',
    fontSize: 16,
    fontWeight: '600',
  },
  visionSendBtn: {
    flex: 1,
    maxWidth: 200,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  visionSendBtnDisabled: { opacity: 0.5 },
  visionSendBtnText: { color: '#000', fontSize: 16, fontWeight: '700' },
});
