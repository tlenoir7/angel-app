import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import ModelViewer3D from './components/ModelViewer3D';
import {
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  setAudioModeAsync,
  AudioModule,
  IOSOutputFormat,
  AudioQuality,
} from 'expo-audio';
import {
  Audio as ExpoAvAudio,
  InterruptionModeAndroid,
  InterruptionModeIOS,
} from 'expo-av';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import { io } from 'socket.io-client';

const API_BASE = 'https://web-production-0166f.up.railway.app';
/** Must match Railway deploy; forensic + file-read use this host. */
const EXPECTED_RAILWAY_API_BASE = 'https://web-production-0166f.up.railway.app';
console.log('[angel] API_BASE configured:', {
  API_BASE,
  expected: EXPECTED_RAILWAY_API_BASE,
  matchesProduction: API_BASE === EXPECTED_RAILWAY_API_BASE,
});
/** Default Engine.IO path; handshake uses e.g. wss://host/socket.io/?EIO=4&transport=websocket */
const SOCKET_IO_PATH = '/socket.io';
const PUSH_REGISTERED_KEY = 'angel_push_token_registered';
const VISION_ANALYZE_QUESTION =
  'What do you see? Describe everything relevant to my mission.';
/** Default context when sending an attachment with no typed message */
const DEFAULT_ATTACHMENT_MESSAGE = 'Analyze this';

/** expo-audio: 24 kHz mono PCM16 WAV for Realtime `realtime_audio_chunk` (SDK 55–aligned; avoids legacy expo-av native headers). */
const REALTIME_RECORDING_OPTIONS = {
  isMeteringEnabled: false,
  extension: '.wav',
  sampleRate: 24000,
  numberOfChannels: 1,
  bitRate: 384000,
  android: {
    extension: '.wav',
    outputFormat: 'default',
    audioEncoder: 'default',
    sampleRate: 24000,
    numberOfChannels: 1,
  },
  ios: {
    extension: '.wav',
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.MAX,
    sampleRate: 24000,
    numberOfChannels: 1,
    bitRate: 384000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: 'audio/wav', bitsPerSecond: 384000 },
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldAnimate: true,
  }),
});

function uint8ArrayToBase64(u8) {
  return arrayBufferToBase64(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
}

function base64ToUint8Array(b64) {
  if (typeof atob === 'undefined') {
    throw new Error('base64 decode requires atob');
  }
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** New PCM bytes in a growing WAV file (fixed 44-byte PCM header). */
function extractNewPcmFromWavFile(fullBytes, sentOffset) {
  const WAV_HEADER = 44;
  if (fullBytes.length <= WAV_HEADER) {
    return { chunk: new Uint8Array(0), nextOffset: 0 };
  }
  const pcm = fullBytes.slice(WAV_HEADER);
  if (sentOffset >= pcm.length) {
    return { chunk: new Uint8Array(0), nextOffset: sentOffset };
  }
  const chunk = pcm.slice(sentOffset);
  return { chunk, nextOffset: pcm.length };
}

/** Build WAV container for raw PCM16 mono (e.g. OpenAI Realtime playback). */
function buildWavFromPcm16(pcmData, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmData.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  w(36, 'data');
  view.setUint32(40, dataSize, true);
  const out = new Uint8Array(buffer);
  out.set(pcmData, 44);
  return out;
}

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
    data?.summary ??
    data?.extracted_text ??
    ''
  );
}

function extractCadResultFromResponse(data, fallbackReplyText, apiBase) {
  // Preferred: direct CAD endpoints return { design_name, download_urls, files_generated, ... }
  if (data && typeof data === 'object') {
    const dn = (data?.design_name || '').trim();
    const urls = data?.download_urls;
    if (dn && urls && typeof urls === 'object') {
      return { design_name: dn, download_urls: urls, api_base: apiBase };
    }
  }

  // Fallback: chat replies may contain one or more /api/cad/download/<design>/<file> links.
  const txt = String(fallbackReplyText || '');
  const re = /\/api\/cad\/download\/([^/\s]+)\/([^\s)]+)/g;
  let m = null;
  const found = [];
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(txt))) {
    found.push({ design: m[1], file: m[2] });
  }
  if (!found.length) return null;

  const design = found[0].design;
  const download_urls = {};
  for (const f of found) {
    if (f.design !== design) continue;
    const ext = (f.file.split('.').pop() || '').toLowerCase();
    if (ext === 'stl') download_urls.stl = `${apiBase}/api/cad/download/${design}/${f.file}`;
    if (ext === 'step') download_urls.step = `${apiBase}/api/cad/download/${design}/${f.file}`;
    if (ext === 'iges') download_urls.iges = `${apiBase}/api/cad/download/${design}/${f.file}`;
  }
  return { design_name: design, download_urls, api_base: apiBase };
}

/**
 * After Socket.IO delivers assistant text, detect CAD links for "View in 3D".
 * Uses structured download_urls when present, else parses /api/cad/download/ in reply,
 * else matches design folder and defaults to lenticular.step / lenticular.stl.
 */
function applyLastCadIfDetected(payload, replyText, apiBase, setLastCadResult) {
  let cad = extractCadResultFromResponse(payload, replyText, apiBase);
  if (!cad?.design_name) {
    const text = String(replyText || '');
    const m = text.match(
      /\/api\/cad\/download\/([^/\s]+)\/|\/tmp\/angel_cad\/[^/]+\/([^/\s]+)\//
    );
    let designName = m ? m[1] || m[2] : '';
    if (!designName) {
      const nameMatch = text.match(/angel_cad\/[^/]+\/([^/\s]+)\//);
      if (nameMatch) designName = nameMatch[1];
    }
    if (designName) {
      cad = {
        design_name: designName,
        download_urls: {
          step: `${apiBase}/api/cad/download/${designName}/lenticular.step`,
          stl: `${apiBase}/api/cad/download/${designName}/lenticular.stl`,
        },
        api_base: apiBase,
      };
    }
  }
  if (cad?.design_name) {
    setLastCadResult(cad);
  }
}

/** Readable label from expo-location reverseGeocode first result */
function placeNameFromGeocode(a) {
  if (!a) return '';
  if (a.formattedAddress) return String(a.formattedAddress).trim();
  const street =
    a.streetNumber && a.street
      ? `${a.streetNumber} ${a.street}`
      : a.street || a.name || '';
  const parts = [street, a.district, a.city, a.subregion, a.region, a.postalCode, a.country].filter(
    (p) => p != null && String(p).trim() !== ''
  );
  return parts.join(', ').trim();
}

/**
 * Payload for API/socket: { latitude, longitude, place }.
 * Returns null if coords unavailable (permission denied, error, etc.).
 */
function locationFieldFromRef(locRef) {
  const loc = locRef?.current;
  if (
    !loc ||
    typeof loc.latitude !== 'number' ||
    Number.isNaN(loc.latitude) ||
    typeof loc.longitude !== 'number' ||
    Number.isNaN(loc.longitude)
  ) {
    return null;
  }
  const place = typeof loc.place === 'string' ? loc.place : '';
  return {
    latitude: loc.latitude,
    longitude: loc.longitude,
    place: place || '',
  };
}

export default function App() {
  const [mode, setMode] = useState('voice'); // 'voice' | 'text'
  const [layoutWidth, setLayoutWidth] = useState(0);

  const [messages, setMessages] = useState([]); // {id, role: 'user'|'assistant', content, kind?}
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);

  // Last CAD generation result (for "View in 3D" button)
  const [lastCadResult, setLastCadResult] = useState(null); // { design_name, download_urls, api_base }
  const [viewer3DOpen, setViewer3DOpen] = useState(false);

  const [briefingBadge, setBriefingBadge] = useState(false);

  const [orbState, setOrbState] = useState('idle'); // 'idle' | 'listening' | 'speaking'

  const listRef = useRef(null);
  const locationRef = useRef(null);
  /** Prevent overlapping native document / photo pickers (expo throws if re-entered). */
  const isPickingDocument = useRef(false);
  const isPickingPhoto = useRef(false);
  const socketRef = useRef(null);
  const expectingResponseRef = useRef(false);
  const playTTSRef = useRef(null);
  /** Latest UI mode for socket handlers (voice | text) */
  const modeRef = useRef(mode);
  /** True if the in-flight socket reply is for a `user_audio` emit (not `user_text`) */
  const lastSocketRequestWasVoiceRef = useRef(false);
  /** Streaming assistant bubble state for `angel_chunk` events. */
  const streamingAssistantIdRef = useRef(null);
  const streamingAssistantTextRef = useRef('');

  const [socketConnected, setSocketConnected] = useState(false);

  const [visionModalVisible, setVisionModalVisible] = useState(false);
  const [visionImageBase64, setVisionImageBase64] = useState('');
  const [visionPreviewUri, setVisionPreviewUri] = useState('');
  const [visionQuestionText, setVisionQuestionText] = useState('');
  const [visionSending, setVisionSending] = useState(false);
  /** false = Describe (/api/vision), true = Forensic (/api/vision/forensic) */
  const [visionForensicMode, setVisionForensicMode] = useState(false);
  const [visionForensicResult, setVisionForensicResult] = useState(null);

  /** Text-mode file/photo attachment before send (separate from camera vision flow) */
  const [textAttachment, setTextAttachment] = useState(null);
  /** Modal: Choose File vs Choose Photo */
  const [attachMenuVisible, setAttachMenuVisible] = useState(false);
  /** Disables attach UI while a native picker session is active (refs alone don’t re-render). */
  const [attachmentPickerBusy, setAttachmentPickerBusy] = useState(false);
  /** Brief status above input while uploading/analyzing attachment */
  const [attachmentStatus, setAttachmentStatus] = useState(null);

  /** Voice: Standard (expo-audio / HTTP) vs GPT-4o Realtime (Socket.IO + expo-audio PCM WAV) */
  const [voiceInputMode, setVoiceInputMode] = useState('standard');
  const [realtimeReady, setRealtimeReady] = useState(false);
  const [realtimeOrbLabel, setRealtimeOrbLabel] = useState('');
  /** True while Realtime mic is streaming to the server (second `AudioRecorder`); separate from Standard `isRecording`. */
  const [realtimeStreaming, setRealtimeStreaming] = useState(false);

  const realtimeChunkIntervalRef = useRef(null);
  const realtimePcmSentRef = useRef(0);
  const realtimeResponsePcmRef = useRef([]);
  /** expo-av `Sound` for Realtime assistant PCM (WAV); unloaded after each response. */
  const realtimeAvSoundRef = useRef(null);
  const realtimeAvFinishOnceRef = useRef(false);
  const unloadRealtimeResponseSoundRef = useRef(() => Promise.resolve());
  /** Latest Realtime `AudioRecorder` for socket cleanup / chunk loop. */
  const realtimeAudioRecorderRef = useRef(null);
  /** Set after `cleanupRealtimeRecording` is defined each render (socket handlers call latest cleanup). */
  const cleanupRealtimeRecordingRef = useRef(() => {});
  /** After Realtime TTS `play()`, until we reset session and restart the mic. */
  const realtimeAwaitingPlaybackFinalizeRef = useRef(false);
  const realtimePlaybackFallbackTimerRef = useRef(null);
  /** Set after `finalizeRealtimeResponsePlayback` is defined (effect + socket merge call this). */
  const finalizeRealtimeResponsePlaybackRef = useRef(() => Promise.resolve());
  const voiceInputModeRef = useRef('standard');
  const realtimeReadyRef = useRef(false);
  const beginRealtimeStreamingRef = useRef(() => Promise.resolve());

  useEffect(() => {
    voiceInputModeRef.current = voiceInputMode;
  }, [voiceInputMode]);

  useEffect(() => {
    realtimeReadyRef.current = realtimeReady;
  }, [realtimeReady]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const refreshLocation = useCallback(async () => {
    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') {
        locationRef.current = null;
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const { latitude, longitude } = pos.coords;
      let place_name = '';
      try {
        const places = await Location.reverseGeocodeAsync({ latitude, longitude });
        const first = places?.[0];
        place_name = placeNameFromGeocode(first);
      } catch (geoErr) {
        console.warn('[location] reverseGeocodeAsync failed:', geoErr?.message ?? geoErr);
      }
      locationRef.current = {
        latitude,
        longitude,
        place: place_name || '',
      };
      console.log('[location] updated', {
        latitude,
        longitude,
        place: place_name || '(none)',
      });
    } catch (e) {
      console.warn('[location] getCurrentPositionAsync failed:', e?.message ?? e);
    }
  }, []);

  useEffect(() => {
    let intervalId;
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (status !== 'granted') {
          locationRef.current = null;
          console.log('[location] foreground permission not granted:', status);
          return;
        }
        await refreshLocation();
        if (cancelled) return;
        intervalId = setInterval(() => {
          refreshLocation();
        }, 5 * 60 * 1000);
      } catch (e) {
        console.warn('[location] requestForegroundPermissionsAsync failed:', e?.message ?? e);
      }
    })();
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [refreshLocation]);

  // SDK 55: call with no args when source is set later via replace() (avoids native ctor mismatch)
  const ttsPlayer = useAudioPlayer();
  const ttsStatus = useAudioPlayerStatus(ttsPlayer);
  /** Realtime assistant audio uses expo-av `Sound` (unload + session reset each turn); TTS stays on expo-audio. */

  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const realtimeAudioRecorder = useAudioRecorder(REALTIME_RECORDING_OPTIONS);
  realtimeAudioRecorderRef.current = realtimeAudioRecorder;

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

  const unloadRealtimeResponseSound = useCallback(async () => {
    const sound = realtimeAvSoundRef.current;
    realtimeAvSoundRef.current = null;
    if (!sound) return;
    try {
      const st = await sound.getStatusAsync();
      if (st.isLoaded) {
        await sound.unloadAsync();
      }
    } catch (e) {
      console.warn('[realtime] expo-av Sound unload:', e?.message ?? e);
    }
  }, []);
  unloadRealtimeResponseSoundRef.current = unloadRealtimeResponseSound;

  const modeAnim = useRef(new Animated.Value(0)).current; // 0 voice, 1 text

  // Orb animation values
  const idlePulse = useRef(new Animated.Value(0)).current;
  const ripple = useRef(new Animated.Value(0)).current;
  const focus = useRef(new Animated.Value(0)).current; // listening intensity

  const glowColor = voiceInputMode === 'realtime' ? '#06B6D4' : '#6D28FF'; // cyan vs deep purple
  const glowColor2 = voiceInputMode === 'realtime' ? '#0891B2' : '#2563FF'; // cyan vs deep blue

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
    setVisionForensicResult(null);
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
      setVisionForensicResult(null);
      setVisionImageBase64(b64);
      setVisionPreviewUri(asset.uri ?? '');
      setVisionQuestionText('');
      setVisionModalVisible(true);
    } catch (e) {
      console.warn('[vision] camera error:', e?.message ?? e);
    }
  }, [loading, visionSending, visionModalVisible]);

  const clearTextAttachment = useCallback(() => {
    setTextAttachment(null);
  }, []);

  const pickDocumentForText = useCallback(async () => {
    if (isPickingDocument.current || isPickingPhoto.current) return;
    isPickingDocument.current = true;
    setAttachmentPickerBusy(true);
    setAttachMenuVisible(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      // iOS: use */* so UIDocumentPicker can show Files / iCloud / providers; narrow MIME lists often break browsing.
      const result = await DocumentPicker.getDocumentAsync({
        type: ['*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) {
        return;
      }
      if (!result.assets?.[0]) {
        Alert.alert(
          'No file selected',
          'Choose a document from Files, iCloud Drive, or another location.'
        );
        return;
      }
      const asset = result.assets[0];
      console.log('[attach] document selected (raw asset):', asset);
      console.log('[attach] document selected (metadata):', {
        fileName: asset?.name || 'file',
        mimeType: asset?.mimeType || '(unknown)',
        sizeBytes:
          typeof asset?.size === 'number'
            ? asset.size
            : typeof asset?.fileSize === 'number'
              ? asset.fileSize
              : '(unknown)',
        uri: asset?.uri || '(none)',
      });
      const b64 = await FileSystemLegacy.readAsStringAsync(asset.uri, {
        encoding: FileSystemLegacy.EncodingType.Base64,
      });
      console.log('[attach] document base64 prepared:', {
        fileName: asset?.name || 'file',
        mimeType: asset?.mimeType || '(unknown)',
        base64Length: typeof b64 === 'string' ? b64.length : 0,
      });
      setTextAttachment({
        kind: 'document',
        fileName: asset.name || 'file',
        base64: b64,
        mimeType: asset.mimeType,
      });
    } catch (e) {
      const msg = e?.message ?? String(e);
      console.warn('[attach] document pick failed:', msg, e);
      Alert.alert(
        'Couldn’t open file picker',
        msg || 'Try again. If this keeps happening, rebuild the app after updating iOS document settings.'
      );
    } finally {
      isPickingDocument.current = false;
      setAttachmentPickerBusy(false);
    }
  }, []);

  const pickPhotoFromLibraryForText = useCallback(async () => {
    if (isPickingDocument.current || isPickingPhoto.current) return;
    isPickingPhoto.current = true;
    setAttachmentPickerBusy(true);
    setAttachMenuVisible(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        console.warn('[attach] photo library permission denied');
        Alert.alert(
          'No photo access',
          'Allow Angel to access your photo library in Settings to attach images.'
        );
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.9,
        base64: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      let b64 = asset.base64;
      if (!b64 && asset.uri) {
        b64 = await FileSystemLegacy.readAsStringAsync(asset.uri, {
          encoding: FileSystemLegacy.EncodingType.Base64,
        });
      }
      if (!b64) {
        console.warn('[attach] no base64 for library image');
        Alert.alert('Couldn’t read photo', 'Try choosing a different image.');
        return;
      }
      const baseName = asset.fileName || asset.uri?.split('/').pop()?.split('?')[0] || 'photo.jpg';
      setTextAttachment({
        kind: 'image',
        fileName: baseName,
        base64: b64,
        previewUri: asset.uri,
      });
    } catch (e) {
      const msg = e?.message ?? String(e);
      console.warn('[attach] library photo failed:', msg, e);
      Alert.alert(
        'Couldn’t open photo library',
        msg || 'Try again in a moment.'
      );
    } finally {
      isPickingPhoto.current = false;
      setAttachmentPickerBusy(false);
    }
  }, []);

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
      if (!visionImageBase64 || visionSending) return;
      if (!visionForensicMode && !q) return;

      setVisionSending(true);
      setVisionForensicResult(null);
      try {
        if (visionForensicMode) {
          const ctx = q || 'Forensic visual analysis.';
          const visionLoc = locationFieldFromRef(locationRef);
          const tylerLocationStr =
            (visionLoc?.place && String(visionLoc.place).trim()) ||
            (visionLoc &&
            typeof visionLoc.latitude === 'number' &&
            typeof visionLoc.longitude === 'number'
              ? `${visionLoc.latitude},${visionLoc.longitude}`
              : '');

          let imageUri = (visionPreviewUri && String(visionPreviewUri).trim()) || '';
          if (!imageUri) {
            const tmpSrc = `${FileSystemLegacy.cacheDirectory || ''}vision_forensic_src_${Date.now()}.jpg`;
            await FileSystemLegacy.writeAsStringAsync(tmpSrc, visionImageBase64, {
              encoding: FileSystemLegacy.EncodingType.Base64,
            });
            imageUri = tmpSrc;
          }

          let resizeActions = [{ resize: { width: 1024 } }];
          try {
            const dims = await new Promise((resolve, reject) => {
              Image.getSize(
                imageUri,
                (w, h) => resolve({ w, h }),
                (err) => reject(err)
              );
            });
            const maxDim = Math.max(dims.w, dims.h);
            if (maxDim > 1024) {
              resizeActions =
                dims.w >= dims.h
                  ? [{ resize: { width: 1024 } }]
                  : [{ resize: { height: 1024 } }];
            } else {
              resizeActions = [];
            }
          } catch {
            resizeActions = [{ resize: { width: 1024 } }];
          }

          const manipulated = await ImageManipulator.manipulateAsync(imageUri, resizeActions, {
            compress: 0.7,
            format: ImageManipulator.SaveFormat.JPEG,
            base64: true,
          });
          const compressedBase64 = manipulated.base64;
          if (!compressedBase64) {
            Alert.alert('Forensic vision', 'Could not compress image. Try another photo.');
            return;
          }

          const forensicUrl = `${API_BASE}/api/vision/forensic`;
          const b64LenOrig = typeof visionImageBase64 === 'string' ? visionImageBase64.length : 0;
          const b64Len = compressedBase64.length;
          const approxDecodedBytes = b64Len ? Math.floor((b64Len * 3) / 4) : 0;
          console.log('[vision][forensic] target URL (full):', forensicUrl);
          console.log('[vision][forensic] API_BASE check:', {
            API_BASE,
            expected: EXPECTED_RAILWAY_API_BASE,
            matchesExpected: API_BASE === EXPECTED_RAILWAY_API_BASE,
          });
          console.log('[vision][forensic] request payload summary:', {
            file_name: 'ios-camera.jpg',
            image_base64_length_original: b64LenOrig,
            image_base64_length_compressed: b64Len,
            approx_decoded_bytes: approxDecodedBytes,
            context_len: ctx.length,
            has_tyler_location: Boolean(tylerLocationStr),
          });
          console.log('[vision][forensic] sending POST request now…');

          const res = await fetch(forensicUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              image_base64: compressedBase64,
              context: ctx,
              ...(tylerLocationStr ? { tyler_location: tylerLocationStr } : {}),
              file_name: 'ios-camera.jpg',
            }),
          });

          console.log('[vision][forensic] response HTTP status:', res.status, res.statusText, 'ok:', res.ok);

          const data = await res.json().catch((parseErr) => {
            console.error('[vision][forensic] response JSON parse failed (full):', {
              message: parseErr?.message ?? String(parseErr),
              name: parseErr?.name,
              stack: parseErr?.stack,
              full: parseErr,
            });
            return {};
          });
          console.log('[vision][forensic] response body keys:', data && typeof data === 'object' ? Object.keys(data) : typeof data, {
            status: res.status,
            ok_field: data?.ok,
            error_field: data?.error,
          });
          if (!res.ok || data.ok === false) {
            const err = data.error || `HTTP ${res.status}`;
            console.error('[vision][forensic] request failed or ok=false:', {
              httpStatus: res.status,
              dataOk: data?.ok,
              error: err,
              fullData: data,
            });
            Alert.alert('Forensic vision', String(err));
            return;
          }
          setVisionForensicResult(data);
          return;
        }

        const visionBody = {
          image: visionImageBase64,
          question: q,
          device: 'ios',
        };
        const visionLoc = locationFieldFromRef(locationRef);
        if (visionLoc) visionBody.location = visionLoc;
        const res = await fetch(`${API_BASE}/api/vision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(visionBody),
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
        console.error('[vision] request failed (full details):', {
          message: e?.message ?? String(e),
          name: e?.name,
          stack: e?.stack,
          cause: e?.cause,
          full: e,
          API_BASE,
          urlAttempted: visionForensicMode
            ? `${API_BASE}/api/vision/forensic`
            : `${API_BASE}/api/vision`,
          visionForensicMode,
        });
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
    [visionImageBase64, visionPreviewUri, visionSending, visionForensicMode, playTTS, closeVisionModal]
  );

  const fileVisionForensicToIntel = useCallback(async () => {
    if (!visionImageBase64 || !visionForensicResult) return;
    setVisionSending(true);
    try {
      const payload = { ...visionForensicResult };
      delete payload.mission_cross_reference;
      delete payload.network_updates_applied;
      const r = await fetch(`${API_BASE}/api/vision/forensic/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: visionImageBase64,
          forensic_json: payload,
          file_name: 'ios-camera.jpg',
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || 'File failed');
      Alert.alert('Filed', j.cabinet_file || 'Visual Intelligence');
      setVisionForensicResult((prev) =>
        prev ? { ...prev, show_manual_file_button: false, auto_filed: true } : prev
      );
    } catch (e) {
      Alert.alert('File error', String(e.message || e));
    } finally {
      setVisionSending(false);
    }
  }, [visionImageBase64, visionForensicResult]);

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
      if (voiceInputModeRef.current === 'realtime') {
        try {
          cleanupRealtimeRecordingRef.current?.();
        } catch (_) {}
        setVoiceInputMode('standard');
        setRealtimeReady(false);
        setRealtimeOrbLabel('');
      }
      if (expectingResponseRef.current) {
        expectingResponseRef.current = false;
        setLoading(false);
        setOrbState('idle');
      }
      streamingAssistantIdRef.current = null;
      streamingAssistantTextRef.current = '';
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
      // Backward-compat path: some servers still send final `angel_response`.
      if (streamingAssistantIdRef.current) {
        return;
      }
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
        applyLastCadIfDetected(data, reply, API_BASE, setLastCadResult);
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

    const onAngelChunk = (payload) => {
      const chunk = typeof payload === 'string' ? payload : payload?.chunk ?? '';
      if (!chunk) return;
      if (expectingResponseRef.current) {
        setLoading(true);
      }
      if (!streamingAssistantIdRef.current) {
        const id = makeId();
        streamingAssistantIdRef.current = id;
        streamingAssistantTextRef.current = String(chunk);
        setMessages((prev) => [...prev, { id, role: 'assistant', content: String(chunk) }]);
        return;
      }
      streamingAssistantTextRef.current += String(chunk);
      const curId = streamingAssistantIdRef.current;
      const textNow = streamingAssistantTextRef.current;
      setMessages((prev) =>
        prev.map((m) => (m.id === curId ? { ...m, content: textNow } : m))
      );
    };

    const onAngelReplyComplete = (payload) => {
      expectingResponseRef.current = false;
      setLoading(false);
      const hadStreaming = Boolean(streamingAssistantIdRef.current);
      const streamed = streamingAssistantTextRef.current || '';
      const parsed = parseAngelReply(payload) || '';
      // Prefer accumulated chunks: servers often send a short `reply` without links while chunks hold the full CAD URLs.
      const reply =
        hadStreaming && streamed ? streamed : parsed || streamed || '';
      if (streamingAssistantIdRef.current) {
        const curId = streamingAssistantIdRef.current;
        setMessages((prev) =>
          prev.map((m) => (m.id === curId ? { ...m, content: reply } : m))
        );
      } else if (reply) {
        setMessages((prev) => [...prev, { id: makeId(), role: 'assistant', content: reply }]);
      }
      applyLastCadIfDetected(payload, reply, API_BASE, setLastCadResult);
      const fromVoice = lastSocketRequestWasVoiceRef.current;
      const inVoiceMode = modeRef.current === 'voice';
      const shouldPlayTTS = inVoiceMode || fromVoice;
      if (reply && shouldPlayTTS) {
        playTTSRef.current?.(reply);
      } else {
        setOrbState('idle');
      }
      streamingAssistantIdRef.current = null;
      streamingAssistantTextRef.current = '';
    };

    const mergeRealtimePlayback = async () => {
      try {
        cleanupRealtimeRecordingRef.current?.();
      } catch (_) {}
      const chunks = realtimeResponsePcmRef.current;
      realtimeResponsePcmRef.current = [];
      if (!chunks.length) {
        if (voiceInputModeRef.current === 'realtime') {
          beginRealtimeStreamingRef.current?.();
        }
        return;
      }
      const parts = chunks.map((c) => base64ToUint8Array(c));
      let total = 0;
      for (const p of parts) total += p.length;
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        merged.set(p, offset);
        offset += p.length;
      }
      const wav = buildWavFromPcm16(merged, 24000);
      const uri = FileSystemLegacy.cacheDirectory + 'rt_play_' + Date.now() + '.wav';
      await FileSystemLegacy.writeAsStringAsync(uri, uint8ArrayToBase64(wav), {
        encoding: FileSystemLegacy.EncodingType.Base64,
      });
      if (realtimePlaybackFallbackTimerRef.current) {
        clearTimeout(realtimePlaybackFallbackTimerRef.current);
        realtimePlaybackFallbackTimerRef.current = null;
      }

      await unloadRealtimeResponseSoundRef.current?.();
      realtimeAvFinishOnceRef.current = false;

      await ExpoAvAudio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        interruptionModeIOS: InterruptionModeIOS.DuckOthers,
        interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      setOrbState('speaking');
      setRealtimeOrbLabel('Speaking…');
      realtimeAwaitingPlaybackFinalizeRef.current = true;

      const { sound } = await ExpoAvAudio.Sound.createAsync(
        { uri },
        { shouldPlay: false },
        (status) => {
          if (!status.isLoaded || !status.didJustFinish) return;
          if (realtimeAvFinishOnceRef.current) return;
          realtimeAvFinishOnceRef.current = true;
          finalizeRealtimeResponsePlaybackRef.current?.().catch((e) =>
            console.warn('[realtime] finalize on didJustFinish:', e?.message ?? e)
          );
        }
      );
      realtimeAvSoundRef.current = sound;
      await sound.playAsync();

      realtimePlaybackFallbackTimerRef.current = setTimeout(() => {
        realtimePlaybackFallbackTimerRef.current = null;
        if (!realtimeAwaitingPlaybackFinalizeRef.current) return;
        (async () => {
          try {
            const snd = realtimeAvSoundRef.current;
            if (snd) {
              const st = await snd.getStatusAsync();
              if (st.isLoaded && st.isPlaying) return;
            }
          } catch (_) {}
          console.warn('[realtime] playback did not start; resetting session for mic');
          finalizeRealtimeResponsePlaybackRef.current?.().catch(() => {});
        })();
      }, 1500);
    };

    const onRealtimeReady = () => {
      setRealtimeReady(true);
      setRealtimeOrbLabel('Listening…');
    };
    const onRealtimeAudioResponse = (payload) => {
      const b64 = payload?.audio_b64;
      if (typeof b64 === 'string' && b64.length) {
        realtimeResponsePcmRef.current.push(b64);
      }
    };
    const onRealtimeAudioDone = () => {
      mergeRealtimePlayback().catch((e) =>
        console.warn('[realtime] playback failed:', e?.message ?? e)
      );
    };
    const onRealtimeTranscript = (p) => {
      if (!p || !p.done) return;
      const text = p.transcript != null ? String(p.transcript).trim() : '';
      if (!text) return;
      const role = p.role === 'assistant' ? 'assistant' : 'user';
      setMessages((prev) => [...prev, { id: makeId(), role, content: text }]);
    };
    const onRealtimeSpeechDetected = () => setRealtimeOrbLabel('Hearing you…');
    const onRealtimeProcessing = () => setRealtimeOrbLabel('Processing…');
    const onRealtimeError = (payload) => {
      const msg = payload?.message ?? 'Realtime error';
      console.warn('[realtime] error', payload);
      try {
        cleanupRealtimeRecordingRef.current?.();
      } catch (_) {}
      Alert.alert('Realtime', msg);
      setVoiceInputMode('standard');
      setRealtimeReady(false);
      setRealtimeOrbLabel('');
      setOrbState('idle');
    };
    const onRealtimeEnded = () => {
      setRealtimeReady(false);
      setRealtimeOrbLabel('');
      try {
        cleanupRealtimeRecordingRef.current?.();
      } catch (_) {}
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('angel_thinking', onAngelThinking);
    socket.on('angel_transcript', onAngelTranscript);
    socket.on('angel_chunk', onAngelChunk);
    socket.on('angel_reply_complete', onAngelReplyComplete);
    socket.on('angel_response', onAngelResponse);
    socket.on('realtime_ready', onRealtimeReady);
    socket.on('realtime_audio_response', onRealtimeAudioResponse);
    socket.on('realtime_audio_done', onRealtimeAudioDone);
    socket.on('realtime_transcript', onRealtimeTranscript);
    socket.on('realtime_speech_detected', onRealtimeSpeechDetected);
    socket.on('realtime_processing', onRealtimeProcessing);
    socket.on('realtime_error', onRealtimeError);
    socket.on('realtime_ended', onRealtimeEnded);

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
      if (realtimePlaybackFallbackTimerRef.current) {
        clearTimeout(realtimePlaybackFallbackTimerRef.current);
        realtimePlaybackFallbackTimerRef.current = null;
      }
      realtimeAwaitingPlaybackFinalizeRef.current = false;
      void unloadRealtimeResponseSoundRef.current?.();
      if (realtimeChunkIntervalRef.current) {
        clearInterval(realtimeChunkIntervalRef.current);
        realtimeChunkIntervalRef.current = null;
      }
      realtimePcmSentRef.current = 0;
      const rrec = realtimeAudioRecorderRef.current;
      if (rrec?.isRecording) {
        rrec.stop().catch(() => {});
      }
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('angel_thinking', onAngelThinking);
      socket.off('angel_transcript', onAngelTranscript);
      socket.off('angel_chunk', onAngelChunk);
      socket.off('angel_reply_complete', onAngelReplyComplete);
      socket.off('angel_response', onAngelResponse);
      socket.off('realtime_ready', onRealtimeReady);
      socket.off('realtime_audio_response', onRealtimeAudioResponse);
      socket.off('realtime_audio_done', onRealtimeAudioDone);
      socket.off('realtime_transcript', onRealtimeTranscript);
      socket.off('realtime_speech_detected', onRealtimeSpeechDetected);
      socket.off('realtime_processing', onRealtimeProcessing);
      socket.off('realtime_error', onRealtimeError);
      socket.off('realtime_ended', onRealtimeEnded);
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
    if (loading) return;
    const trimmed = (inputText || '').trim();
    const attach = textAttachment;
    if (!trimmed && !attach) return;

    const messageText = trimmed || (attach ? DEFAULT_ATTACHMENT_MESSAGE : '');

    // Race fix: first GPS fix may still be in flight from mount; ref stays null until then.
    let locField = locationFieldFromRef(locationRef);
    if (!locField) {
      console.log(
        '[location] locationRef.current empty before send; awaiting refreshLocation() fallback'
      );
      await refreshLocation();
      locField = locationFieldFromRef(locationRef);
    }
    console.log('[location] at send time (text message)', {
      locationRefCurrent: locationRef.current,
      locFieldForPayload: locField,
    });

    // ----- Attachments: always HTTP (no Socket.IO file channel) -----
    if (attach) {
      const attachSnap = attach;
      setInputText('');
      const userLine =
        attachSnap.kind === 'document'
          ? trimmed
            ? `📄 ${attachSnap.fileName}\n${trimmed}`
            : `📄 ${attachSnap.fileName}`
          : trimmed
            ? `📷 ${attachSnap.fileName}\n${trimmed}`
            : `📷 ${attachSnap.fileName}`;
      setMessages((prev) => [...prev, { id: makeId(), role: 'user', content: userLine }]);
      setLoading(true);
      setAttachmentStatus(
        attachSnap.kind === 'document' ? 'Analyzing file…' : 'Analyzing image…'
      );
      try {
        if (attachSnap.kind === 'document') {
          const filesReadUrl = `${API_BASE}/api/files/read`;
          const b64Len =
            typeof attachSnap.base64 === 'string' ? attachSnap.base64.length : 0;
          const approxDecodedBytes = b64Len ? Math.floor((b64Len * 3) / 4) : 0;
          console.log('[attach][files/read] target URL (full):', filesReadUrl);
          console.log('[attach][files/read] API_BASE check:', {
            API_BASE,
            expected: EXPECTED_RAILWAY_API_BASE,
            matchesExpected: API_BASE === EXPECTED_RAILWAY_API_BASE,
          });
          console.log('[attach] document upload start', {
            apiBase: API_BASE,
            endpoint: filesReadUrl,
            isLocalhost: /localhost|127\.0\.0\.1/i.test(API_BASE),
            fileName: attachSnap.fileName,
            fileSizeApproxBytes: approxDecodedBytes,
            mimeType: attachSnap.mimeType || '(unknown)',
            base64Length: b64Len,
          });
          const body = {
            file_content: attachSnap.base64,
            file_name: attachSnap.fileName,
            context: messageText,
            device: 'ios',
          };
          if (locField) body.location = locField;
          const fc = body.file_content;
          const fcStr = typeof fc === 'string' ? fc : '';
          console.log('[attach] /api/files/read REQUEST (pre-fetch)', {
            url: filesReadUrl,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            file_name: body.file_name,
            context: body.context,
            device: body.device,
            has_location: !!body.location,
            file_content_type: typeof fc,
            file_content_length: fcStr.length,
            file_content_prefix: fcStr.slice(0, 120),
          });
          console.log('[attach] /api/files/read sending POST request now…');
          const res = await fetch(filesReadUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(body),
          });
          console.log('[attach] /api/files/read response HTTP status:', res.status, res.statusText, 'ok:', res.ok);
          const rawText = await res.text();
          console.log('[attach] /api/files/read RAW response', {
            status: res.status,
            ok: res.ok,
            rawText:
              rawText.length > 4000 ? `${rawText.slice(0, 4000)}… (${rawText.length} chars)` : rawText,
          });
          let data = {};
          try {
            data = rawText ? JSON.parse(rawText) : {};
          } catch (parseErr) {
            console.warn('[attach] /api/files/read JSON parse failed:', parseErr?.message ?? parseErr);
          }
          console.log('[attach] /api/files/read parsed:', data);
          console.log('[attach] /api/files/read success path complete', {
            status: res.status,
            ok: res.ok,
            hasReply: !!parseAngelReply(data),
            backendError: data?.error ?? null,
          });
          let assistantText;
          if (data?.ok && data?.summary) {
            const keyFindings = Array.isArray(data.key_findings)
              ? data.key_findings.map((f) => `• ${f}`).join('\n')
              : '';
            assistantText = `📄 ${data.file_type_detected || 'File'} analyzed\n\n${data.summary}${keyFindings ? '\n\n**Key findings:**\n' + keyFindings : ''}`;
          } else {
            const reply = parseAngelReply(data) || (typeof data === 'string' ? data : '');
            const errMsg = data?.error != null ? String(data.error) : '';
            assistantText =
              reply ||
              (!res.ok && errMsg ? errMsg : '') ||
              (!res.ok ? `HTTP ${res.status}` : '') ||
              'Sorry, I couldn’t read that file.';
          }
          setMessages((prev) => [
            ...prev,
            {
              id: makeId(),
              role: 'assistant',
              content: assistantText,
            },
          ]);
        } else {
          const visionAttachUrl = `${API_BASE}/api/vision`;
          const imgB64Len =
            typeof attachSnap.base64 === 'string' ? attachSnap.base64.length : 0;
          const approxImgBytes = imgB64Len ? Math.floor((imgB64Len * 3) / 4) : 0;
          console.log('[attach][vision] target URL (full):', visionAttachUrl);
          console.log('[attach][vision] API_BASE check:', {
            API_BASE,
            expected: EXPECTED_RAILWAY_API_BASE,
            matchesExpected: API_BASE === EXPECTED_RAILWAY_API_BASE,
          });
          console.log('[attach][vision] sending POST (library image):', {
            fileName: attachSnap.fileName,
            approx_decoded_bytes: approxImgBytes,
            base64_length: imgB64Len,
          });
          const visionBody = {
            image: attachSnap.base64,
            question: messageText,
            device: 'ios',
          };
          if (locField) visionBody.location = locField;
          const res = await fetch(visionAttachUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(visionBody),
          });
          console.log('[attach][vision] response HTTP status:', res.status, res.statusText, 'ok:', res.ok);
          const data = await res.json().catch((parseErr) => {
            console.error('[attach][vision] JSON parse failed (full):', {
              message: parseErr?.message ?? String(parseErr),
              name: parseErr?.name,
              stack: parseErr?.stack,
              full: parseErr,
            });
            return {};
          });
          console.log('[attach] /api/vision (library) response:', { status: res.status, data });
          const reply = parseAngelReply(data) || (typeof data === 'string' ? data : '');
          setMessages((prev) => [
            ...prev,
            {
              id: makeId(),
              role: 'assistant',
              content: reply || "I couldn't interpret that image.",
            },
          ]);
        }
        setTextAttachment(null);
      } catch (e) {
        console.error('[attach] upload failed (full error):', {
          message: e?.message ?? String(e),
          name: e?.name,
          stack: e?.stack,
          cause: e?.cause,
          full: e,
          apiBase: API_BASE,
          expectedApiBase: EXPECTED_RAILWAY_API_BASE,
          apiBaseMatchesExpected: API_BASE === EXPECTED_RAILWAY_API_BASE,
          endpoint:
            attachSnap?.kind === 'document' ? `${API_BASE}/api/files/read` : `${API_BASE}/api/vision`,
          attachKind: attachSnap?.kind,
          fileName: attachSnap?.fileName,
          base64Length:
            typeof attachSnap?.base64 === 'string' ? attachSnap.base64.length : 0,
        });
        console.warn('[attach] upload failed:', e?.message ?? e);
        setMessages((prev) => [
          ...prev,
          {
            id: makeId(),
            role: 'assistant',
            content: 'Attachment could not be sent. Please try again.',
          },
        ]);
      } finally {
        setLoading(false);
        setAttachmentStatus(null);
      }
      return;
    }

    // ----- Plain text only -----
    setInputText('');
    const userMsg = { id: makeId(), role: 'user', content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    const socket = socketRef.current;
    if (socket?.connected) {
      lastSocketRequestWasVoiceRef.current = false;
      expectingResponseRef.current = true;
      streamingAssistantIdRef.current = null;
      streamingAssistantTextRef.current = '';
      setLoading(true);
      const textPayload = { message: trimmed };
      if (locField) textPayload.location = locField;
      console.log('[location] before socket user_text emit', {
        locationRefCurrent: locationRef.current,
        payloadHasLocation: !!textPayload.location,
      });
      socket.emit('user_text', textPayload);
      return;
    }

    setLoading(true);
    try {
      const messageBody = { message: trimmed, device: 'ios' };
      if (locField) messageBody.location = locField;
      console.log(
        '[location] locationRef.current immediately before /api/chat fetch:',
        locationRef.current
      );
      console.log('[chat] /api/chat request body', {
        ...messageBody,
        message:
          trimmed.length > 100 ? `${trimmed.slice(0, 100)}… (${trimmed.length} chars)` : trimmed,
      });
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messageBody),
      });
      const data = await res.json().catch(() => ({}));
      console.log('API /api/chat response:', data);
      const reply = parseAngelReply(data) || (typeof data === 'string' ? data : '');

      const assistantMsg = {
        id: makeId(),
        role: 'assistant',
        content: reply || 'Sorry, I couldn’t process that.',
      };
      setMessages((prev) => [...prev, assistantMsg]);
      const cad = extractCadResultFromResponse(data, reply, API_BASE);
      if (cad?.design_name) {
        setLastCadResult(cad);
      }
      /* Text mode: show reply only, no TTS */
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { id: makeId(), role: 'assistant', content: 'Something went wrong. Please try again.' },
      ]);
    } finally {
      setLoading(false);
    }
  }, [inputText, loading, refreshLocation, textAttachment]);

  const cleanupRealtimeRecording = useCallback(() => {
    if (realtimeChunkIntervalRef.current) {
      clearInterval(realtimeChunkIntervalRef.current);
      realtimeChunkIntervalRef.current = null;
    }
    realtimePcmSentRef.current = 0;
    const rec = realtimeAudioRecorderRef.current;
    if (rec?.isRecording) {
      rec.stop().catch(() => {});
    }
    setRealtimeStreaming(false);
  }, []);

  cleanupRealtimeRecordingRef.current = cleanupRealtimeRecording;

  const beginRealtimeStreaming = useCallback(async () => {
    if (voiceInputModeRef.current !== 'realtime' || modeRef.current !== 'voice') return;
    if (!realtimeReadyRef.current || !socketRef.current?.connected) return;

    try {
      setOrbState('listening');
      setRealtimeOrbLabel('Listening…');

      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm?.granted) {
        setOrbState('idle');
        setRealtimeStreaming(false);
        Alert.alert('Microphone', 'Permission is required for Realtime voice.');
        return;
      }

      await ExpoAvAudio.setAudioModeAsync({
        allowsRecordingIOS: true,
        interruptionModeIOS: InterruptionModeIOS.DuckOthers,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      if (voiceInputModeRef.current !== 'realtime' || modeRef.current !== 'voice') return;
      if (!realtimeReadyRef.current || !socketRef.current?.connected) return;

      cleanupRealtimeRecordingRef.current?.();

      if (voiceInputModeRef.current !== 'realtime' || modeRef.current !== 'voice') return;

      await realtimeAudioRecorder.prepareToRecordAsync();
      if (voiceInputModeRef.current !== 'realtime' || modeRef.current !== 'voice') return;
      if (!realtimeReadyRef.current || !socketRef.current?.connected) return;

      realtimeAudioRecorder.record();
      realtimePcmSentRef.current = 0;
      setRealtimeStreaming(true);

      realtimeChunkIntervalRef.current = setInterval(async () => {
        const uri = realtimeAudioRecorderRef.current?.uri;
        if (!uri) return;
        try {
          const b64 = await FileSystemLegacy.readAsStringAsync(uri, {
            encoding: FileSystemLegacy.EncodingType.Base64,
          });
          const fullBytes = base64ToUint8Array(b64);
          const { chunk, nextOffset } = extractNewPcmFromWavFile(
            fullBytes,
            realtimePcmSentRef.current
          );
          realtimePcmSentRef.current = nextOffset;
          if (chunk.length > 0) {
            const pcmB64 = uint8ArrayToBase64(chunk);
            socketRef.current?.emit('realtime_audio_chunk', { audio_b64: pcmB64 });
          }
        } catch (e) {
          console.warn('[realtime] chunk:', e?.message ?? e);
        }
      }, 500);
    } catch (e) {
      console.warn('[realtime] begin streaming failed:', e?.message ?? e);
      setOrbState('idle');
      setRealtimeStreaming(false);
    }
  }, [realtimeAudioRecorder]);

  beginRealtimeStreamingRef.current = beginRealtimeStreaming;

  const finalizeRealtimeResponsePlayback = useCallback(async () => {
    if (realtimePlaybackFallbackTimerRef.current) {
      clearTimeout(realtimePlaybackFallbackTimerRef.current);
      realtimePlaybackFallbackTimerRef.current = null;
    }

    const hadAwaiting = realtimeAwaitingPlaybackFinalizeRef.current;
    realtimeAwaitingPlaybackFinalizeRef.current = false;
    if (!hadAwaiting) return;

    try {
      await unloadRealtimeResponseSound();
      await ExpoAvAudio.setAudioModeAsync({
        allowsRecordingIOS: true,
        interruptionModeIOS: InterruptionModeIOS.DuckOthers,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
    } catch (e) {
      console.warn('[realtime] reset audio session after playback (expo-av):', e?.message ?? e);
    }

    await new Promise((r) => setTimeout(r, 100));

    if (voiceInputModeRef.current !== 'realtime' || modeRef.current !== 'voice') {
      setOrbState('idle');
      return;
    }

    setOrbState('idle');
    setRealtimeOrbLabel('Listening…');
    await beginRealtimeStreamingRef.current?.();
  }, [unloadRealtimeResponseSound]);

  finalizeRealtimeResponsePlaybackRef.current = finalizeRealtimeResponsePlayback;

  useEffect(() => {
    const canStream =
      mode === 'voice' &&
      voiceInputMode === 'realtime' &&
      realtimeReady &&
      socketConnected;

    if (!canStream) {
      cleanupRealtimeRecording();
      return;
    }

    (async () => {
      await beginRealtimeStreamingRef.current?.();
    })();

    return () => {
      cleanupRealtimeRecording();
    };
  }, [mode, voiceInputMode, realtimeReady, socketConnected, cleanupRealtimeRecording]);

  useEffect(() => {
    if (mode !== 'text') return;
    if (voiceInputModeRef.current !== 'realtime') return;
    socketRef.current?.emit('realtime_stop');
    cleanupRealtimeRecording();
    setVoiceInputMode('standard');
    setRealtimeReady(false);
    setRealtimeOrbLabel('');
  }, [mode, cleanupRealtimeRecording]);

  const selectVoiceInputMode = useCallback(
    (next) => {
      if (next === 'standard') {
        socketRef.current?.emit('realtime_stop');
        cleanupRealtimeRecording();
        setVoiceInputMode('standard');
        setRealtimeReady(false);
        setRealtimeOrbLabel('');
        return;
      }
      if (!socketRef.current?.connected) {
        Alert.alert('Realtime', 'Connect to the server first (green dot).');
        return;
      }
      setVoiceInputMode('realtime');
      setRealtimeReady(false);
      setRealtimeOrbLabel('Connecting…');
      socketRef.current.emit('realtime_start');
    },
    [cleanupRealtimeRecording]
  );

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
        const audioPayload = {
          audio_base64: audioBase64,
          filename: 'voice.m4a',
        };
        const audioLoc = locationFieldFromRef(locationRef);
        if (audioLoc) audioPayload.location = audioLoc;
        socket.emit('user_audio', audioPayload);
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
      const voiceLoc = locationFieldFromRef(locationRef);
      if (voiceLoc) {
        form.append('location', JSON.stringify(voiceLoc));
      }
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

  const voiceHintText = useMemo(() => {
    if (voiceInputMode === 'realtime') {
      if (!socketConnected) return 'Connect to use Realtime.';
      if (!realtimeReady) return realtimeOrbLabel || 'Connecting…';
    }
    if (loading) return socketConnected ? 'Angel is thinking…' : 'Connecting…';
    if (voiceInputMode === 'realtime') {
      if (orbState === 'speaking') return 'Speaking…';
      if (realtimeOrbLabel && realtimeOrbLabel !== 'Listening…') return realtimeOrbLabel;
      if (realtimeStreaming) return 'Listening…';
      return 'Preparing mic…';
    }
    if (orbState === 'speaking') return 'Angel is speaking…';
    if (isRecording) return 'Listening…';
    return 'Hold to speak';
  }, [
    voiceInputMode,
    socketConnected,
    realtimeReady,
    realtimeOrbLabel,
    loading,
    orbState,
    isRecording,
    realtimeStreaming,
  ]);

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

            <View style={styles.voiceModeRow}>
              <TouchableOpacity
                style={[
                  styles.voiceModeBtn,
                  voiceInputMode === 'standard' && styles.voiceModeBtnActive,
                ]}
                onPress={() => selectVoiceInputMode('standard')}
                disabled={loading}
              >
                <Text
                  style={[
                    styles.voiceModeBtnText,
                    voiceInputMode === 'standard' && styles.voiceModeBtnTextActive,
                  ]}
                >
                  Standard
                </Text>
              </TouchableOpacity>
              {socketConnected ? (
                <TouchableOpacity
                  style={[
                    styles.voiceModeBtn,
                    voiceInputMode === 'realtime' && styles.voiceModeBtnActiveRealtime,
                  ]}
                  onPress={() => selectVoiceInputMode('realtime')}
                  disabled={loading}
                >
                  <Text
                    style={[
                      styles.voiceModeBtnText,
                      voiceInputMode === 'realtime' && styles.voiceModeBtnTextActiveRealtime,
                    ]}
                  >
                    Realtime
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>

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

            <Text style={styles.voiceHint}>{voiceHintText}</Text>

            {voiceInputMode === 'standard' ? (
              <Pressable
                style={[
                  styles.holdToSpeak,
                  isRecording && styles.holdToSpeakActive,
                ]}
                onPressIn={startRecording}
                onPressOut={stopRecording}
              >
                <Text style={styles.holdToSpeakText}>
                  {isRecording ? 'Release' : 'Hold'}
                </Text>
              </Pressable>
            ) : (
              <View style={styles.realtimeMicSpacer} />
            )}
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

            {lastCadResult?.design_name ? (
              <TouchableOpacity
                style={styles.view3DBtn}
                onPress={() => setViewer3DOpen(true)}
                accessibilityLabel={`View ${lastCadResult.design_name} in 3D`}
              >
                <Text style={styles.view3DBtnText}>
                  🔺 View {lastCadResult.design_name} in 3D
                </Text>
              </TouchableOpacity>
            ) : null}

            {(attachmentStatus || textAttachment) ? (
              <View style={styles.attachmentPreviewWrap}>
                {attachmentStatus ? (
                  <View style={styles.attachmentStatusRow}>
                    <ActivityIndicator size="small" color="#A78BFA" />
                    <Text style={styles.attachmentStatusText}>{attachmentStatus}</Text>
                  </View>
                ) : null}
                {textAttachment?.kind === 'document' ? (
                  <View style={styles.attachmentChip}>
                    <Text style={styles.attachmentChipText} numberOfLines={1}>
                      📄 {textAttachment.fileName}
                    </Text>
                    <TouchableOpacity
                      onPress={clearTextAttachment}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      accessibilityLabel="Remove attachment"
                    >
                      <Text style={styles.attachmentRemove}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
                {textAttachment?.kind === 'image' ? (
                  <View style={styles.attachmentImageRow}>
                    <Image
                      source={{ uri: textAttachment.previewUri }}
                      style={styles.attachmentThumb}
                      resizeMode="cover"
                    />
                    <TouchableOpacity
                      onPress={clearTextAttachment}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      accessibilityLabel="Remove photo"
                    >
                      <Text style={styles.attachmentRemove}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            ) : null}

            <View style={styles.inputRow}>
              <TouchableOpacity
                style={styles.inputRowCamera}
                onPress={openCameraForVision}
                disabled={loading || visionSending || visionModalVisible}
                accessibilityLabel="Open camera for vision"
              >
                <Ionicons name="camera" size={22} color="#E5E7EB" />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.inputRowAttach}
                onPress={() => setAttachMenuVisible(true)}
                disabled={
                  loading || visionSending || !!attachmentStatus || attachmentPickerBusy
                }
                accessibilityLabel="Attach file or photo"
              >
                <Ionicons name="attach" size={22} color="#E5E7EB" />
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
                style={[
                  styles.sendBtn,
                  (loading || (!inputText.trim() && !textAttachment)) && styles.sendBtnDisabled,
                ]}
                onPress={sendTextMessage}
                disabled={loading || (!inputText.trim() && !textAttachment)}
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

      {viewer3DOpen && lastCadResult?.design_name ? (
        <ModelViewer3D
          designName={lastCadResult.design_name}
          apiBase={API_BASE}
          onClose={() => setViewer3DOpen(false)}
        />
      ) : null}

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
            {visionForensicResult ? (
              <ScrollView
                style={styles.visionForensicScroll}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <Text style={styles.visionModalTitle}>Forensic report</Text>
                <Text style={styles.visionForensicBadge}>
                  TYPE:{' '}
                  {String(
                    visionForensicResult.classification?.primary_type ||
                      visionForensicResult.analysis_type ||
                      '—'
                  ).toUpperCase()}
                </Text>
                <Text style={styles.visionForensicBadge}>
                  CONFIDENCE: {visionForensicResult.confidence || '—'}
                </Text>
                <Text style={styles.visionForensicBadge}>
                  MISSION: {visionForensicResult.mission_relevance || '—'}
                </Text>
                <Text style={styles.visionForensicSummary}>
                  {visionForensicResult.summary_for_progressive_ui ||
                    visionForensicResult.summary ||
                    ''}
                </Text>
                <Text style={styles.visionForensicSection}>Key findings</Text>
                {(visionForensicResult.key_findings || []).map((k, i) => (
                  <Text key={`kf-${i}`} style={styles.visionForensicBullet}>
                    • {k}
                  </Text>
                ))}
                <Text style={styles.visionForensicSection}>Anomalies</Text>
                {(visionForensicResult.anomalies || []).length ? (
                  (visionForensicResult.anomalies || []).map((a, i) => (
                    <Text key={`an-${i}`} style={styles.visionForensicAnomaly}>
                      ⚠ {a}
                    </Text>
                  ))
                ) : (
                  <Text style={styles.visionForensicMuted}>None noted</Text>
                )}
                <Text style={styles.visionForensicAction}>
                  {visionForensicResult.recommended_action || ''}
                </Text>
                {visionForensicResult.show_manual_file_button ? (
                  <TouchableOpacity
                    style={styles.visionFileIntelBtn}
                    onPress={fileVisionForensicToIntel}
                    disabled={visionSending}
                  >
                    <Text style={styles.visionFileIntelBtnText}>File to Intelligence</Text>
                  </TouchableOpacity>
                ) : null}
                {visionForensicResult.auto_filed ? (
                  <Text style={styles.visionForensicMuted}>
                    Auto-filed to Visual Intelligence
                  </Text>
                ) : null}
                <View style={styles.visionForensicFooter}>
                  <TouchableOpacity
                    style={styles.visionCancelBtn}
                    onPress={() => {
                      if (!visionSending) setVisionForensicResult(null);
                    }}
                    disabled={visionSending}
                  >
                    <Text style={styles.visionCancelBtnText}>Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.visionSendBtn}
                    onPress={() => {
                      if (!visionSending) closeVisionModal();
                    }}
                    disabled={visionSending}
                  >
                    <Text style={styles.visionSendBtnText}>Done</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            ) : (
              <>
                <Text style={styles.visionModalTitle}>What do you want to know?</Text>
                <View style={styles.visionModeRow}>
                  <Text style={styles.visionModeLabel}>Describe</Text>
                  <Switch
                    value={visionForensicMode}
                    onValueChange={setVisionForensicMode}
                    disabled={visionSending}
                    trackColor={{ false: '#374151', true: '#6D28FF' }}
                    thumbColor={Platform.OS === 'ios' ? '#fff' : '#E9D5FF'}
                  />
                  <Text style={styles.visionModeLabel}>Forensic</Text>
                </View>
                {visionPreviewUri ? (
                  <Image
                    source={{ uri: visionPreviewUri }}
                    style={styles.visionPreview}
                    resizeMode="cover"
                  />
                ) : null}
                <TextInput
                  style={styles.visionQuestionInput}
                  placeholder={
                    visionForensicMode
                      ? 'Context for forensic analysis (optional)'
                      : 'What do you want to know?'
                  }
                  placeholderTextColor="#6B7280"
                  value={visionQuestionText}
                  onChangeText={setVisionQuestionText}
                  editable={!visionSending}
                  multiline
                  maxLength={2000}
                />
                <TouchableOpacity
                  style={styles.visionAnalyzeBtn}
                  onPress={() =>
                    submitVision(
                      visionForensicMode
                        ? 'Forensic visual analysis.'
                        : VISION_ANALYZE_QUESTION
                    )
                  }
                  disabled={visionSending || !visionImageBase64}
                >
                  <Text style={styles.visionAnalyzeBtnText}>Analyze</Text>
                  <Text style={styles.visionAnalyzeHint} numberOfLines={2}>
                    {visionForensicMode
                      ? 'Run full structured forensic pass'
                      : VISION_ANALYZE_QUESTION}
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
                      (visionSending ||
                        !visionImageBase64 ||
                        (!visionForensicMode && !visionQuestionText.trim())) &&
                        styles.visionSendBtnDisabled,
                    ]}
                    onPress={() => submitVision(visionQuestionText)}
                    disabled={
                      visionSending ||
                      !visionImageBase64 ||
                      (!visionForensicMode && !visionQuestionText.trim())
                    }
                  >
                    {visionSending ? (
                      <ActivityIndicator size="small" color="#000" />
                    ) : (
                      <Text style={styles.visionSendBtnText}>Send</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={attachMenuVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setAttachMenuVisible(false)}
      >
        <View style={styles.attachMenuRoot}>
          <Pressable
            style={styles.attachMenuDim}
            onPress={() => setAttachMenuVisible(false)}
          />
          <View style={styles.attachMenuCard}>
          <Text style={styles.attachMenuTitle}>Attach</Text>
          <TouchableOpacity
            style={styles.attachMenuOption}
            onPress={pickDocumentForText}
            disabled={attachmentPickerBusy}
          >
            <Ionicons name="document-text-outline" size={22} color="#E5E7EB" />
            <Text style={styles.attachMenuOptionText}>Choose File</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.attachMenuOption}
            onPress={pickPhotoFromLibraryForText}
            disabled={attachmentPickerBusy}
          >
            <Ionicons name="images-outline" size={22} color="#E5E7EB" />
            <Text style={styles.attachMenuOptionText}>Choose Photo</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.attachMenuCancel}
            onPress={() => setAttachMenuVisible(false)}
            disabled={attachmentPickerBusy}
          >
            <Text style={styles.attachMenuCancelText}>Cancel</Text>
          </TouchableOpacity>
          </View>
        </View>
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
  voiceName: { color: '#fff', fontSize: 22, fontWeight: '600', marginBottom: 12 },
  voiceModeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 18,
  },
  voiceModeBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1F2937',
  },
  voiceModeBtnActive: {
    borderColor: '#6D28FF',
    backgroundColor: '#1E1B4B',
  },
  voiceModeBtnActiveRealtime: {
    borderColor: '#06B6D4',
    backgroundColor: '#083344',
  },
  voiceModeBtnText: { color: '#9CA3AF', fontSize: 13, fontWeight: '600' },
  voiceModeBtnTextActive: { color: '#E9D5FF' },
  voiceModeBtnTextActiveRealtime: { color: '#A5F3FC' },
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
  realtimeMicSpacer: { height: 46, marginBottom: 0 },
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
  view3DBtn: {
    marginHorizontal: 16,
    marginTop: 2,
    marginBottom: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    backgroundColor: '#0B0F1A',
    borderWidth: 1,
    borderColor: '#312E81',
  },
  view3DBtnText: { color: '#C4B5FD', fontSize: 14, fontWeight: '800', textAlign: 'center' },
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
  inputRowAttach: {
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
  attachmentPreviewWrap: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
    borderTopWidth: 1,
    borderTopColor: '#111827',
    backgroundColor: '#000',
  },
  attachmentStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  attachmentStatusText: { color: '#A78BFA', fontSize: 14, fontWeight: '600' },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#111827',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1F2937',
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 8,
  },
  attachmentChipText: { color: '#E5E7EB', fontSize: 15, flex: 1 },
  attachmentImageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  attachmentThumb: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: '#111827',
  },
  attachmentRemove: {
    color: '#9CA3AF',
    fontSize: 18,
    fontWeight: '700',
    paddingHorizontal: 4,
  },
  attachMenuRoot: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.75)',
  },
  attachMenuDim: {
    ...StyleSheet.absoluteFillObject,
  },
  attachMenuCard: {
    backgroundColor: '#0B0F1A',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 28,
    borderWidth: 1,
    borderColor: '#1F2937',
  },
  attachMenuTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 14,
    textAlign: 'center',
  },
  attachMenuOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
  },
  attachMenuOptionText: { color: '#E5E7EB', fontSize: 16, fontWeight: '600' },
  attachMenuCancel: { paddingVertical: 16, alignItems: 'center', marginTop: 4 },
  attachMenuCancelText: { color: '#9CA3AF', fontSize: 16, fontWeight: '600' },
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

  visionModeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 14,
  },
  visionModeLabel: { color: '#9CA3AF', fontSize: 14, fontWeight: '600' },
  visionForensicScroll: { maxHeight: 480 },
  visionForensicBadge: {
    fontSize: 12,
    fontWeight: '700',
    color: '#A78BFA',
    marginBottom: 4,
    letterSpacing: 0.3,
  },
  visionForensicSummary: {
    color: '#E5E7EB',
    fontSize: 16,
    lineHeight: 24,
    marginTop: 10,
    marginBottom: 8,
  },
  visionForensicSection: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
    marginTop: 12,
    marginBottom: 6,
  },
  visionForensicBullet: {
    color: '#E5E7EB',
    fontSize: 14,
    lineHeight: 20,
    marginLeft: 4,
    marginBottom: 4,
  },
  visionForensicAnomaly: {
    color: '#FBBF24',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
  },
  visionForensicMuted: { color: '#6B7280', fontSize: 13, marginTop: 8 },
  visionForensicAction: {
    color: '#9CA3AF',
    fontSize: 14,
    fontStyle: 'italic',
    marginTop: 12,
    marginBottom: 8,
    lineHeight: 20,
  },
  visionFileIntelBtn: {
    marginTop: 8,
    marginBottom: 8,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: '#1E1B4B',
    borderWidth: 1,
    borderColor: '#6D28FF',
    alignItems: 'center',
  },
  visionFileIntelBtnText: { color: '#E9D5FF', fontSize: 16, fontWeight: '700' },
  visionForensicFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 16,
    paddingBottom: 4,
  },
});
