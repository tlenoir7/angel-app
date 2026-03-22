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
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
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
import { Audio } from 'expo-av';
import { io } from 'socket.io-client';

const API_BASE = 'https://web-production-0166f.up.railway.app';
/** Default Engine.IO path; handshake uses e.g. wss://host/socket.io/?EIO=4&transport=websocket */
const SOCKET_IO_PATH = '/socket.io';
const PUSH_REGISTERED_KEY = 'angel_push_token_registered';
const VISION_ANALYZE_QUESTION =
  'What do you see? Describe everything relevant to my mission.';
/** Default context when sending an attachment with no typed message */
const DEFAULT_ATTACHMENT_MESSAGE = 'Analyze this';

/** expo-av recording: 24 kHz mono PCM16 WAV for Realtime `realtime_audio_chunk` */
const REALTIME_RECORDING_OPTIONS = {
  isMeteringEnabled: false,
  android: {
    extension: '.wav',
    outputFormat: Audio.AndroidOutputFormat.DEFAULT,
    audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
    sampleRate: 24000,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  ios: {
    extension: '.wav',
    outputFormat: Audio.IOSOutputFormat.LINEARPCM,
    audioQuality: Audio.IOSAudioQuality.MAX,
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
    ''
  );
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

  const [socketConnected, setSocketConnected] = useState(false);

  const [visionModalVisible, setVisionModalVisible] = useState(false);
  const [visionImageBase64, setVisionImageBase64] = useState('');
  const [visionPreviewUri, setVisionPreviewUri] = useState('');
  const [visionQuestionText, setVisionQuestionText] = useState('');
  const [visionSending, setVisionSending] = useState(false);

  /** Text-mode file/photo attachment before send (separate from camera vision flow) */
  const [textAttachment, setTextAttachment] = useState(null);
  /** Modal: Choose File vs Choose Photo */
  const [attachMenuVisible, setAttachMenuVisible] = useState(false);
  /** Disables attach UI while a native picker session is active (refs alone don’t re-render). */
  const [attachmentPickerBusy, setAttachmentPickerBusy] = useState(false);
  /** Brief status above input while uploading/analyzing attachment */
  const [attachmentStatus, setAttachmentStatus] = useState(null);

  /** Voice: Standard (expo-audio / HTTP) vs GPT-4o Realtime (Socket.IO + expo-av PCM) */
  const [voiceInputMode, setVoiceInputMode] = useState('standard');
  const [realtimeReady, setRealtimeReady] = useState(false);
  const [realtimeOrbLabel, setRealtimeOrbLabel] = useState('');
  /** True while Realtime hold-to-speak is active (expo-av Recording); separate from expo-audio `isRecording`. */
  const [rtHolding, setRtHolding] = useState(false);

  const realtimeRecordingRef = useRef(null);
  const realtimeChunkIntervalRef = useRef(null);
  const realtimePcmSentRef = useRef(0);
  const realtimeResponsePcmRef = useRef([]);
  const realtimeSoundRef = useRef(null);
  /** Set after `cleanupRealtimeRecording` is defined each render (socket handlers call latest cleanup). */
  const cleanupRealtimeRecordingRef = useRef(() => {});
  const voiceInputModeRef = useRef('standard');

  useEffect(() => {
    voiceInputModeRef.current = voiceInputMode;
  }, [voiceInputMode]);

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
      const b64 = await FileSystemLegacy.readAsStringAsync(asset.uri, {
        encoding: FileSystemLegacy.EncodingType.Base64,
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
      if (!q || !visionImageBase64 || visionSending) return;
      setVisionSending(true);
      try {
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

    const mergeRealtimePlayback = async () => {
      const chunks = realtimeResponsePcmRef.current;
      realtimeResponsePcmRef.current = [];
      if (!chunks.length) return;
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
      await Audio.setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecordingIOS: false,
      });
      if (realtimeSoundRef.current) {
        try {
          await realtimeSoundRef.current.unloadAsync();
        } catch (_) {}
        realtimeSoundRef.current = null;
      }
      const { sound } = await Audio.Sound.createAsync({ uri });
      realtimeSoundRef.current = sound;
      setOrbState('speaking');
      setRealtimeOrbLabel('Speaking…');
      sound.setOnPlaybackStatusUpdate((st) => {
        if (st.isLoaded && st.didJustFinish) {
          setOrbState('idle');
          if (voiceInputModeRef.current === 'realtime') {
            setRealtimeOrbLabel('Listening…');
          }
        }
      });
      await sound.playAsync();
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
      if (realtimeChunkIntervalRef.current) {
        clearInterval(realtimeChunkIntervalRef.current);
        realtimeChunkIntervalRef.current = null;
      }
      realtimePcmSentRef.current = 0;
      const rrec = realtimeRecordingRef.current;
      if (rrec) {
        rrec.stopAndUnloadAsync().catch(() => {});
        realtimeRecordingRef.current = null;
      }
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('angel_thinking', onAngelThinking);
      socket.off('angel_transcript', onAngelTranscript);
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
            url: `${API_BASE}/api/files/read`,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            file_name: body.file_name,
            context: body.context,
            device: body.device,
            has_location: !!body.location,
            file_content_type: typeof fc,
            file_content_length: fcStr.length,
            file_content_prefix: fcStr.slice(0, 120),
          });
          const res = await fetch(`${API_BASE}/api/files/read`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(body),
          });
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
          const reply = parseAngelReply(data) || (typeof data === 'string' ? data : '');
          const errMsg = data?.error != null ? String(data.error) : '';
          const assistantText =
            reply ||
            (!res.ok && errMsg ? errMsg : '') ||
            (!res.ok ? `HTTP ${res.status}` : '') ||
            'Sorry, I couldn’t read that file.';
          setMessages((prev) => [
            ...prev,
            {
              id: makeId(),
              role: 'assistant',
              content: assistantText,
            },
          ]);
        } else {
          const visionBody = {
            image: attachSnap.base64,
            question: messageText,
            device: 'ios',
          };
          if (locField) visionBody.location = locField;
          const res = await fetch(`${API_BASE}/api/vision`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(visionBody),
          });
          const data = await res.json().catch(() => ({}));
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
    const rec = realtimeRecordingRef.current;
    if (rec) {
      rec.stopAndUnloadAsync().catch(() => {});
      realtimeRecordingRef.current = null;
    }
    setRtHolding(false);
  }, []);

  cleanupRealtimeRecordingRef.current = cleanupRealtimeRecording;

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

      if (voiceInputMode === 'realtime') {
        if (!socketRef.current?.connected) {
          Alert.alert('Realtime', 'Connect to the server first (green dot).');
          return;
        }
        if (!realtimeReady) {
          setRealtimeOrbLabel('Connecting…');
          return;
        }

        setOrbState('listening');
        setRealtimeOrbLabel('Listening…');

        const { status } = await Audio.requestPermissionsAsync();
        if (status !== 'granted') {
          setOrbState('idle');
          Alert.alert('Microphone', 'Permission is required for Realtime voice.');
          return;
        }

        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });

        cleanupRealtimeRecording();
        const recording = new Audio.Recording();
        await recording.prepareToRecordAsync(REALTIME_RECORDING_OPTIONS);
        await recording.startAsync();
        realtimeRecordingRef.current = recording;
        realtimePcmSentRef.current = 0;
        setRtHolding(true);

        realtimeChunkIntervalRef.current = setInterval(async () => {
          const rec = realtimeRecordingRef.current;
          if (!rec) return;
          const uri = rec.getURI();
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
        return;
      }

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
  }, [loading, audioRecorder, voiceInputMode, realtimeReady, cleanupRealtimeRecording]);

  const stopRecording = useCallback(async () => {
    if (voiceInputMode === 'realtime') {
      cleanupRealtimeRecording();
      setOrbState('idle');
      if (realtimeReady) {
        setRealtimeOrbLabel('Listening…');
      }
      return;
    }

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
  }, [
    voiceInputMode,
    cleanupRealtimeRecording,
    realtimeReady,
    recorderState?.isRecording,
    audioRecorder,
    playTTS,
  ]);

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
    if (voiceInputMode === 'realtime' && realtimeOrbLabel) return realtimeOrbLabel;
    if (orbState === 'speaking') {
      return voiceInputMode === 'realtime' ? 'Speaking…' : 'Angel is speaking…';
    }
    if (isRecording || rtHolding) return 'Listening…';
    return 'Hold to speak';
  }, [
    voiceInputMode,
    socketConnected,
    realtimeReady,
    realtimeOrbLabel,
    loading,
    orbState,
    isRecording,
    rtHolding,
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

            <Pressable
              style={[
                styles.holdToSpeak,
                (isRecording || rtHolding) && styles.holdToSpeakActive,
              ]}
              onPressIn={startRecording}
              onPressOut={stopRecording}
            >
              <Text style={styles.holdToSpeakText}>
                {isRecording || rtHolding ? 'Release' : 'Hold'}
              </Text>
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
});
