import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  PanResponder,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { GLView } from 'expo-gl';
import { Renderer } from 'expo-three';
import * as THREE from 'three';

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function fmtMm(n) {
  if (!Number.isFinite(n)) return '?';
  return `${Math.round(n)}mm`;
}

function boundsDims(bounds) {
  const mn = bounds?.min || [0, 0, 0];
  const mx = bounds?.max || [0, 0, 0];
  return {
    dx: (mx[0] ?? 0) - (mn[0] ?? 0),
    dy: (mx[1] ?? 0) - (mn[1] ?? 0),
    dz: (mx[2] ?? 0) - (mn[2] ?? 0),
    center: [
      ((mx[0] ?? 0) + (mn[0] ?? 0)) / 2,
      ((mx[1] ?? 0) + (mn[1] ?? 0)) / 2,
      ((mx[2] ?? 0) + (mn[2] ?? 0)) / 2,
    ],
  };
}

/**
 * Full-screen 3D viewer modal.
 * Props: { designName, apiBase, onClose }
 */
export default function ModelViewer3D({ designName, apiBase, onClose }) {
  const [loading, setLoading] = useState(true);
  const [meshJson, setMeshJson] = useState(null);
  const [error, setError] = useState('');
  const [hintVisible, setHintVisible] = useState(true);
  const [interacting, setInteracting] = useState(false);

  const glRef = useRef(null);
  const rafRef = useRef(null);
  const threeRef = useRef({
    scene: null,
    camera: null,
    renderer: null,
    mesh: null,
    target: new THREE.Vector3(0, 0, 0),
    theta: 0,
    phi: Math.PI / 2.4,
    radius: 200,
    pan: new THREE.Vector3(0, 0, 0),
  });

  const dims = useMemo(() => boundsDims(meshJson?.bounds), [meshJson]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setMeshJson(null);
    const url = `${apiBase}/api/cad/mesh-json/${encodeURIComponent(designName)}`;
    (async () => {
      try {
        const res = await fetch(url);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!data?.ok) {
          setError(data?.error || 'Mesh conversion failed.');
          setLoading(false);
          return;
        }
        setMeshJson(data);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e?.message || 'Failed to load mesh.');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, designName]);

  useEffect(() => {
    const t = setTimeout(() => setHintVisible(false), 3000);
    return () => clearTimeout(t);
  }, []);

  const panResponder = useMemo(() => {
    let lastDist = 0;
    let lastMid = null;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        setInteracting(true);
        const touches = evt?.nativeEvent?.touches || [];
        if (touches.length >= 2) {
          const a = touches[0];
          const b = touches[1];
          lastDist = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
          lastMid = { x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 };
        } else {
          lastDist = 0;
          lastMid = null;
        }
      },
      onPanResponderMove: (evt, gesture) => {
        const touches = evt?.nativeEvent?.touches || [];
        const st = threeRef.current;
        if (!st?.camera) return;

        if (touches.length >= 2) {
          const a = touches[0];
          const b = touches[1];
          const dist = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
          const mid = { x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 };

          // Pinch zoom
          if (lastDist > 0) {
            const delta = dist - lastDist;
            st.radius = clamp(st.radius - delta * 0.6, 40, 5000);
          }
          lastDist = dist;

          // Two-finger pan (screen space -> world-ish)
          if (lastMid) {
            const dx = mid.x - lastMid.x;
            const dy = mid.y - lastMid.y;
            const panScale = st.radius * 0.002;
            st.pan.add(new THREE.Vector3(-dx * panScale, dy * panScale, 0));
          }
          lastMid = mid;
          return;
        }

        // One-finger rotate
        st.theta += gesture.dx * 0.01;
        st.phi = clamp(st.phi + gesture.dy * 0.01, 0.15, Math.PI - 0.15);
      },
      onPanResponderRelease: () => {
        setInteracting(false);
      },
      onPanResponderTerminate: () => {
        setInteracting(false);
      },
    });
  }, []);

  const onContextCreate = async (gl) => {
    glRef.current = gl;
    const { drawingBufferWidth: width, drawingBufferHeight: height } = gl;
    const renderer = new Renderer({ gl });
    renderer.setSize(width, height);
    renderer.setClearColor('#050509', 1);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#050509');

    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100000);

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(1, 1.2, 1.6);
    scene.add(dir);

    // Build mesh if loaded
    if (meshJson?.ok) {
      const verts = meshJson.vertices || [];
      const faces = meshJson.faces || [];
      const normals = meshJson.normals || [];

      const geometry = new THREE.BufferGeometry();
      const pos = new Float32Array(faces.length * 3);
      const nor = new Float32Array(faces.length * 3);
      for (let f = 0; f < faces.length; f += 3) {
        const i0 = faces[f + 0];
        const i1 = faces[f + 1];
        const i2 = faces[f + 2];
        const v0 = verts[i0] || [0, 0, 0];
        const v1 = verts[i1] || [0, 0, 0];
        const v2 = verts[i2] || [0, 0, 0];
        const base = f * 3;
        pos[base + 0] = v0[0];
        pos[base + 1] = v0[1];
        pos[base + 2] = v0[2];
        pos[base + 3] = v1[0];
        pos[base + 4] = v1[1];
        pos[base + 5] = v1[2];
        pos[base + 6] = v2[0];
        pos[base + 7] = v2[1];
        pos[base + 8] = v2[2];

        const fn = normals[f / 3] || null;
        if (fn) {
          for (let k = 0; k < 9; k += 3) {
            nor[base + k + 0] = fn[0];
            nor[base + k + 1] = fn[1];
            nor[base + k + 2] = fn[2];
          }
        }
      }
      geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (nor.some((x) => x !== 0)) {
        geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      } else {
        geometry.computeVertexNormals();
      }

      // Center at origin
      geometry.computeBoundingBox();
      const bb = geometry.boundingBox;
      const center = new THREE.Vector3();
      bb.getCenter(center);
      geometry.translate(-center.x, -center.y, -center.z);

      const material = new THREE.MeshPhongMaterial({
        color: 0x9aa0a6,
        shininess: 90,
        specular: 0xffffff,
      });
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);

      // Camera radius from bounds
      const dx = Math.abs(dims.dx || 0);
      const dy = Math.abs(dims.dy || 0);
      const dz = Math.abs(dims.dz || 0);
      const span = Math.max(dx, dy, dz) || 100;
      const st = threeRef.current;
      st.radius = span * 1.6;
      st.theta = 0.6;
      st.phi = Math.PI / 2.4;
      st.pan = new THREE.Vector3(0, 0, 0);
      st.target = new THREE.Vector3(0, 0, 0);
      st.scene = scene;
      st.camera = camera;
      st.renderer = renderer;
      st.mesh = mesh;
    } else {
      const st = threeRef.current;
      st.scene = scene;
      st.camera = camera;
      st.renderer = renderer;
      st.mesh = null;
    }

    const animate = () => {
      const st = threeRef.current;
      if (!st?.renderer || !st?.scene || !st?.camera) return;

      if (!interacting) {
        st.theta += 0.003; // slow auto-rotate
      }

      const sinPhi = Math.sin(st.phi);
      const x = st.radius * sinPhi * Math.cos(st.theta);
      const y = st.radius * Math.cos(st.phi);
      const z = st.radius * sinPhi * Math.sin(st.theta);
      st.camera.position.set(x, y, z).add(st.pan);
      st.camera.lookAt(st.target.clone().add(st.pan));

      st.renderer.render(st.scene, st.camera);
      gl.endFrameEXP();
      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
  };

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  const shareStl = async () => {
    const url = `${apiBase}/api/cad/download/${encodeURIComponent(designName)}/${encodeURIComponent(
      `${designName}.stl`
    )}`;
    try {
      await Share.share({ message: url, url });
    } catch (_) {}
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.wrap} {...panResponder.panHandlers}>
        <View style={styles.header}>
          <Pressable onPress={shareStl} style={styles.headerBtn} hitSlop={10}>
            <Text style={styles.headerBtnText}>Share</Text>
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            {designName}
          </Text>
          <Pressable onPress={onClose} style={styles.headerBtn} hitSlop={10}>
            <Text style={styles.headerBtnText}>Close</Text>
          </Pressable>
        </View>

        <View style={styles.viewer}>
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color="#A78BFA" />
              <Text style={styles.loadingText}>Loading 3D model…</Text>
            </View>
          ) : error ? (
            <View style={styles.center}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : (
            <GLView style={styles.gl} onContextCreate={onContextCreate} />
          )}
        </View>

        <View style={styles.footer}>
          <Text style={styles.dims}>
            {`W ${fmtMm(dims.dx)}   H ${fmtMm(dims.dy)}   D ${fmtMm(dims.dz)}`}
          </Text>
          {hintVisible ? <Text style={styles.hint}>Rotate to inspect</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: '#050509',
  },
  header: {
    height: 56,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#111827',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { color: '#E5E7EB', fontSize: 16, fontWeight: '700', flex: 1, textAlign: 'center' },
  headerBtn: { paddingVertical: 8, paddingHorizontal: 10, minWidth: 60 },
  headerBtnText: { color: '#A78BFA', fontSize: 14, fontWeight: '700' },
  viewer: { flex: 1 },
  gl: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 18 },
  loadingText: { marginTop: 10, color: '#9CA3AF' },
  errorText: { color: '#FCA5A5', textAlign: 'center' },
  footer: {
    height: 54,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: '#111827',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dims: { color: '#9CA3AF', fontSize: 12, fontWeight: '600' },
  hint: { color: '#E5E7EB', fontSize: 12, fontWeight: '700' },
});

