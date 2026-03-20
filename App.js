import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Constants from 'expo-constants';
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

const API_BASE = 'https://web-production-0166f.up.railway.app';

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

export default function App() {
  const [mode, setMode] = useState('voice'); // 'voice' | 'text'
  const [layoutWidth, setLayoutWidth] = useState(0);

  const [messages, setMessages] = useState([]); // {id, role: 'user'|'assistant', content, kind?}
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);

  const [briefingBadge, setBriefingBadge] = useState(false);

  const [orbState, setOrbState] = useState('idle'); // 'idle' | 'listening' | 'speaking'

  const listRef = useRef(null);

  const ttsPlayer = useAudioPlayer(null);
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

  // Clear briefing badge once user visits text mode (they've "seen" it)
  useEffect(() => {
    if (mode === 'text') setBriefingBadge(false);
  }, [mode]);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === 'voice' ? 'text' : 'voice'));
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

  const sendTextMessage = useCallback(async () => {
    const trimmed = (inputText || '').trim();
    if (!trimmed || loading) return;

    setInputText('');
    const userMsg = { id: makeId(), role: 'user', content: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, device: 'ios' }),
      });
      const data = await res.json().catch(() => ({}));
      console.log('API /api/message response:', data);
      const reply =
        data?.reply ??
        data?.response ??
        data?.text ??
        data?.message ??
        (typeof data === 'string' ? data : '');

      const assistantMsg = {
        id: makeId(),
        role: 'assistant',
        content: reply || 'Sorry, I couldn’t process that.',
      };
      setMessages((prev) => [...prev, assistantMsg]);
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
    try {
      await audioRecorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const uri = audioRecorder.uri;

      if (!uri) {
        setOrbState('idle');
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
      setLoading(false);
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
        <Text style={styles.topTitle}>Angel</Text>
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
                ? 'Connecting…'
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
  voiceCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
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
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#111827',
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-end',
    backgroundColor: '#000',
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
});
