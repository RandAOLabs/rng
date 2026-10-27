// The hero scene: one time-lock round in 3D. Each validator's puzzle closes
// around it (commit), bursts open (reveal) or is wound open by repeated
// squaring when it stays silent (crack); every answer streams into the core,
// which raises the round's 32 value bytes as a crown. Rendered with WebGPU,
// falling back to WebGL2 where WebGPU is missing.
import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';

/** A finalized round, with how long each phase really took on the network. */
export type SceneRound = { round: number; value: string; cracked: number[]; ms: { commit: number; reveal: number; crack?: number } };
export type Bar = { name: string; realMs: number | null; progress: number };
/** What the overlay shows: the phase bars, the log line, and how much playback is slowed. */
export type Status = { round: number; label: string; bars: Bar[]; speed: string };

// Black and white: locked is dim, revealed is bright, cracked flickers.
const LOCKED = new THREE.Color('#8a8a8a');
const OPEN = new THREE.Color('#ffffff');
const SILENT = new THREE.Color('#5a5a5a');
const LOW = new THREE.Color('#202020');
const HIGH = new THREE.Color('#ffffff');
const STAGE = new THREE.Color('#000000');

const N_VALIDATORS = 3;
const RING = 3.3;
const STREAM = 36;
const HELIX = 140;
const BYTES = 32;

// Round timeline, seconds from the round's start.
const T = { commit: 0, commitEnd: 1.0, reveal: 1.5, revealEnd: 2.3, flow: 0.9, crackEnd: 3.7, crownRise: 0.9, hold: 1.2 };

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function bytesOf(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < BYTES; i++) out.push(parseInt(hex.slice(i * 2, i * 2 + 2) || '00', 16) || 0);
  return out;
}

/** Faces of an icosphere as (centroid, rotation, size), one shard per face. */
function shellFaces() {
  const geo = new THREE.IcosahedronGeometry(1, 1).toNonIndexed();
  const p = geo.getAttribute('position');
  const faces: { c: THREE.Vector3; q: THREE.Quaternion; s: number }[] = [];
  for (let i = 0; i < p.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(p, i);
    const b = new THREE.Vector3().fromBufferAttribute(p, i + 1);
    const c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
    const centroid = a.clone().add(b).add(c).divideScalar(3);
    const n = centroid.clone().normalize();
    const x = a.clone().sub(centroid).normalize();
    const y = n.clone().cross(x);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n));
    faces.push({ c: centroid, q, s: a.distanceTo(centroid) });
  }
  geo.dispose();
  return faces;
}

class Validator {
  readonly group = new THREE.Group();
  readonly orb: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  readonly shards: THREE.InstancedMesh;
  readonly shardMat: THREE.MeshBasicMaterial;
  readonly stream: THREE.InstancedMesh;
  readonly helix: THREE.InstancedMesh;
  readonly faces = shellFaces();
  readonly spin: THREE.Vector3[];

  constructor(readonly index: number, readonly home: THREE.Vector3) {
    this.group.position.copy(home);
    this.orb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), new THREE.MeshBasicMaterial({ color: LOCKED.clone(), wireframe: true }));
    this.group.add(this.orb);

    const tri = new THREE.BufferGeometry();
    const k = Math.sqrt(3) / 2;
    tri.setAttribute('position', new THREE.Float32BufferAttribute([1, 0, 0, -0.5, k, 0, -0.5, -k, 0], 3));
    tri.computeVertexNormals();
    this.shardMat = new THREE.MeshBasicMaterial({ color: LOCKED.clone(), wireframe: true, side: THREE.DoubleSide });
    this.shards = new THREE.InstancedMesh(tri, this.shardMat, this.faces.length);
    this.group.add(this.shards);
    // Each shard tumbles on its own axis when it flies off.
    this.spin = this.faces.map((_, i) => new THREE.Vector3(Math.sin(i * 12.9898), Math.cos(i * 78.233), Math.sin(i * 3.7)).normalize());

    const dot = new THREE.SphereGeometry(0.045, 8, 6);
    this.stream = new THREE.InstancedMesh(dot, new THREE.MeshBasicMaterial({ color: OPEN.clone() }), STREAM);
    this.helix = new THREE.InstancedMesh(dot, new THREE.MeshBasicMaterial({ color: SILENT.clone() }), HELIX);
    this.helix.position.copy(home);
  }
}

export class RoundScene {
  private renderer!: THREE.WebGPURenderer;
  private pipeline!: THREE.RenderPipeline;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
  private world = new THREE.Group();
  private validators: Validator[] = [];
  private core!: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshBasicMaterial>;
  private coreGlow!: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private crown!: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private col = new THREE.Color();

  private clock = 0; // scene seconds
  private current: { r: SceneRound; start: number; bytes: number[] } | null = null;
  private previousBytes: number[] = new Array(BYTES).fill(0);
  private next: SceneRound | null = null;
  private running = false;
  private ro?: ResizeObserver;

  onFrame?: (s: Status) => void;
  backend = '';

  constructor(private canvas: HTMLCanvasElement) {}

  async init() {
    this.renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(STAGE, 1);
    this.renderer.toneMapping = THREE.NoToneMapping;
    await this.renderer.init();
    this.backend = (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';

    this.scene.background = STAGE;
    this.scene.add(this.world);

    this.buildStage();
    for (let i = 0; i < N_VALIDATORS; i++) {
      const a = Math.PI / 2 + (i * 2 * Math.PI) / N_VALIDATORS;
      const val = new Validator(i, new THREE.Vector3(Math.cos(a) * RING, 0, Math.sin(a) * RING));
      this.world.add(val.group, val.stream, val.helix);
      this.validators.push(val);
    }

    const scenePass = pass(this.scene, this.camera);
    const color = scenePass.getTextureNode('output');
    this.pipeline = new THREE.RenderPipeline(this.renderer, color.add(bloom(color, 0.4, 0.25, 0.6)));

    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);
  }

  private buildStage() {
    // Core: a faceted heart that takes in every answer.
    this.core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.55, 0),
      new THREE.MeshBasicMaterial({ color: OPEN.clone(), wireframe: true }),
    );
    this.coreGlow = new THREE.Mesh(new THREE.SphereGeometry(0.2, 32, 16), new THREE.MeshBasicMaterial({ color: OPEN.clone() }));
    this.world.add(this.core, this.coreGlow);

    // Crown: one bar per byte of the round value.
    const bar = new THREE.BoxGeometry(0.1, 1, 0.1);
    bar.translate(0, 0.5, 0);
    this.crown = new THREE.InstancedMesh(bar, new THREE.MeshBasicMaterial({ color: '#ffffff' }), BYTES);
    for (let i = 0; i < BYTES; i++) this.crown.setColorAt(i, LOW);
    this.world.add(this.crown);

    // The validators' orbit and faint spokes to the core.
    const orbit = new THREE.Mesh(new THREE.TorusGeometry(RING, 0.008, 6, 180), new THREE.MeshBasicMaterial({ color: '#3a3a3a' }));
    orbit.rotation.x = Math.PI / 2;
    this.world.add(orbit);
    const inner = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.006, 6, 120), new THREE.MeshBasicMaterial({ color: '#262626' }));
    inner.rotation.x = Math.PI / 2;
    this.world.add(inner);

    // Stars.
    const n = 1200, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = 30 + Math.random() * 40;
      const w = Math.sqrt(1 - u * u);
      pos.set([r * w * Math.cos(th), r * u, r * w * Math.sin(th)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: '#555555', size: 0.08, sizeAttenuation: true })));
  }

  private resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole ring in frame on tall, narrow screens.
    this.camera.fov = w / h < 1 ? 36 / Math.max(0.62, w / h) : 36;
    this.camera.updateProjectionMatrix();
  }

  /** Queue a finalized round; it plays when the current one has been shown. */
  push(r: SceneRound) {
    if (this.current?.r.round === r.round || this.next?.round === r.round) return;
    if (this.current && r.round < this.current.r.round) return;
    this.next = r;
  }

  private roundLength(r: SceneRound) {
    return (r.cracked.length ? T.crackEnd + T.flow : T.revealEnd + T.flow) + T.crownRise + T.hold;
  }

  /** Advance the scene by dt seconds and draw a frame. */
  async step(dt: number) {
    this.clock += dt;
    if (this.next && (!this.current || this.clock - this.current.start >= this.roundLength(this.current.r))) {
      if (this.current) this.previousBytes = this.current.bytes;
      this.current = { r: this.next, start: this.clock, bytes: bytesOf(this.next.value) };
      this.next = null;
    }
    this.update();
    await this.pipeline.renderAsync();
  }

  start() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    this.renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.step(dt);
    });
  }

  stop() {
    this.running = false;
    this.renderer?.setAnimationLoop(null);
  }

  dispose() {
    this.stop();
    this.ro?.disconnect();
    this.renderer?.dispose();
  }

  /** Phase bars over the animation: each spans [from, to] scene seconds and carries its real duration. */
  private status(t: number, r: SceneRound | undefined, combine: number): Status {
    if (!r) return { round: 0, label: 'waiting for a round', bars: [], speed: '' };
    const cracked = r.cracked.length > 0;
    const spans: [string, number, number, number | null][] = [
      ['commit', 0, T.commitEnd + 0.3, r.ms.commit],
      [cracked ? 'reveal window' : 'reveal', T.commitEnd + 0.3, T.revealEnd + 0.2, r.ms.reveal],
      ...(cracked ? [['crack', T.revealEnd + 0.2, T.crackEnd, r.ms.crack ?? null] as [string, number, number, number | null]] : []),
      ['combine', cracked ? T.crackEnd : T.revealEnd + 0.2, combine + 0.2, null],
    ];
    const bars = spans.map(([name, a, b, realMs]) => ({ name, realMs, progress: clamp01((t - a) / (b - a)) }));
    const active = spans.find(([, a, b]) => t >= a && t < b);
    let speed = 'replay finished';
    if (active) {
      const [, a, b, realMs] = active;
      const f = realMs ? ((b - a) * 1000) / realMs : null;
      speed = f === null ? 'computed inside the last message' : f >= 1.15 ? `${f.toFixed(f < 10 ? 1 : 0)}× slower than real time` : f <= 0.87 ? `${(1 / f).toFixed(0)}× faster than real time` : 'real time';
    }
    let label = `value    ${r.value.slice(0, 24)}…`;
    if (t < T.commitEnd + 0.3) label = 'commit   validators lock their puzzles';
    else if (t < T.revealEnd + 0.2) label = cracked ? 'reveal   2 open, 1 silent' : 'reveal   every puzzle opened';
    else if (cracked && t < T.crackEnd) label = 'crack    solving the silent puzzle by repeated squaring';
    else if (t < combine + 0.2) label = 'combine  sha256(every answer)';
    return { round: r.round, label, bars, speed };
  }

  private update() {
    const c = this.clock;
    this.world.rotation.y = c * 0.07;
    const camA = c * 0.05;
    this.camera.position.set(Math.sin(camA) * 1.2, 3.6 + Math.sin(c * 0.13) * 0.25, 11.2);
    this.camera.lookAt(0, 0.15, 0);

    const cur = this.current;
    const t = cur ? c - cur.start : -1;
    const cracked = new Set(cur?.r.cracked ?? []);
    const combine = cur ? (cracked.size ? T.crackEnd : T.revealEnd) + T.flow : 0;

    this.onFrame?.(this.status(t, cur?.r, combine));

    for (const val of this.validators) this.updateValidator(val, t, cracked.has(val.index), combine);
    this.updateCore(t, combine);
    this.updateCrown(t, combine, cur?.bytes ?? null);
  }

  private updateValidator(val: Validator, t: number, isCracked: boolean, combine: number) {
    const stagger = val.index * 0.12;
    const idle = t < 0;
    const close = idle ? 0 : ease((t - T.commit - stagger) / (T.commitEnd - T.commit));
    const burstAt = isCracked ? T.crackEnd : T.reveal + stagger;
    const burst = idle ? 0 : ease((t - burstAt) / 0.9);
    const bob = Math.sin(this.clock * 1.4 + val.index * 2) * 0.08;
    val.group.position.set(val.home.x, val.home.y + bob, val.home.z);
    val.group.rotation.y = this.clock * 0.4 + val.index;

    // Orb: a dim wireframe while hidden, solid once its answer is out.
    const out = t >= burstAt;
    val.orb.material.wireframe = !out;
    val.orb.material.color.copy(out ? OPEN : LOCKED).multiplyScalar(out ? 1.1 : 1);
    val.orb.scale.setScalar(out ? 0.7 + 0.25 * (1 - ease((t - burstAt) / 0.6)) : 1);

    // Shell shards: fly in to close, fly out to burst.
    const flicker = isCracked && t > T.reveal && !out;
    val.shardMat.color.copy(flicker ? (Math.sin(this.clock * 30) > 0 ? OPEN : SILENT) : LOCKED);
    val.faces.forEach((f, i) => {
      const jitter = (i % 7) * 0.025;
      const inP = ease(clamp01((close * 1.15) - jitter));
      const radius = 0.62 + (1 - inP) * 1.6 + burst * (1.8 + (i % 5) * 0.25);
      const size = f.s * 0.5 * (burst > 0 ? 1 - burst : inP > 0 ? 1 : 0);
      this.v.copy(f.c).normalize().multiplyScalar(radius);
      this.q.copy(f.q);
      if (burst > 0) this.q.multiply(new THREE.Quaternion().setFromAxisAngle(val.spin[i], burst * 4));
      this.s.setScalar(Math.max(size, 0.0001));
      this.m.compose(this.v, this.q, this.s);
      val.shards.setMatrixAt(i, this.m);
    });
    val.shards.instanceMatrix.needsUpdate = true;

    // Helix: repeated squaring winding around a silent validator.
    const crackOn = isCracked && t > T.reveal - 0.1 && t < T.crackEnd + 0.4;
    val.helix.visible = crackOn;
    if (crackOn) {
      const p = clamp01((t - T.reveal) / (T.crackEnd - T.reveal));
      const fade = 1 - smooth(T.crackEnd, T.crackEnd + 0.4, t);
      for (let k = 0; k < HELIX; k++) {
        const u = k / HELIX;
        const shown = u < ease(p * 1.3) ? 1 : 0;
        const ang = u * Math.PI * 14 + this.clock * (4 + p * 16);
        const r = (1.25 - 0.45 * p) * (0.9 + 0.1 * Math.sin(u * 40));
        this.v.set(Math.cos(ang) * r, (u - 0.5) * 1.6 * (1 - 0.3 * p) + val.group.position.y - val.home.y, Math.sin(ang) * r);
        this.s.setScalar(shown * fade * (0.6 + 0.6 * u));
        this.m.compose(this.v, this.q.identity(), this.s);
        val.helix.setMatrixAt(k, this.m);
      }
      val.helix.instanceMatrix.needsUpdate = true;
      (val.helix.material as THREE.MeshBasicMaterial).color.copy(SILENT).lerp(OPEN, p);
    }

    // Stream: the answer flowing into the core.
    const flowStart = burstAt + 0.15;
    const from = val.group.position;
    const ctrl = this.v.clone().copy(from).multiplyScalar(0.5).setY(1.6);
    let any = false;
    for (let k = 0; k < STREAM; k++) {
      const sp = (t - flowStart - k * 0.018) / (combine - flowStart - 0.1);
      const on = !idle && sp > 0 && sp < 1;
      any ||= on;
      const u = clamp01(sp);
      const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, cc = u * u;
      const p = new THREE.Vector3(from.x * a + ctrl.x * b, from.y * a + ctrl.y * b, from.z * a + ctrl.z * b).addScaledVector(new THREE.Vector3(), cc);
      this.s.setScalar(on ? 0.7 + 0.6 * Math.sin(u * Math.PI) : 0.0001);
      this.m.compose(p, this.q.identity(), this.s);
      val.stream.setMatrixAt(k, this.m);
    }
    val.stream.visible = any;
    val.stream.instanceMatrix.needsUpdate = true;
    (val.stream.material as THREE.MeshBasicMaterial).color.copy(OPEN).multiplyScalar(1.4);
  }

  private updateCore(t: number, combine: number) {
    const flare = t < 0 ? 0 : Math.max(0, 1 - Math.abs(t - combine - 0.15) / 0.45);
    this.core.rotation.set(this.clock * 0.3, this.clock * 0.45, 0);
    this.core.scale.setScalar(1 + 0.35 * ease(flare));
    this.core.material.color.copy(OPEN).multiplyScalar(0.7 + 1.5 * flare);
    this.coreGlow.scale.setScalar(1 + 1.2 * flare);
    this.coreGlow.material.color.copy(OPEN).multiplyScalar(0.8 + 3 * flare);
  }

  private updateCrown(t: number, combine: number, bytes: number[] | null) {
    const rise = t < 0 ? 0 : t < combine ? 0 : clamp01((t - combine - 0.1) / T.crownRise);
    const sink = t < 0 ? 0 : 1 - smooth(0, 0.6, t); // the previous value sinks as a new round locks in
    for (let i = 0; i < BYTES; i++) {
      const a = (i / BYTES) * Math.PI * 2;
      const local = clamp01(rise * 1.6 - (i / BYTES) * 0.6);
      const b = bytes && local > 0 ? bytes[i] : this.previousBytes[i];
      const h = bytes && local > 0 ? 0.12 + (b / 255) * 1.3 * ease(local) : 0.12 + (b / 255) * 1.3 * sink;
      this.v.set(Math.cos(a) * 1.25, -0.25, Math.sin(a) * 1.25);
      this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
      this.s.set(1, Math.max(h, 0.02), 1);
      this.m.compose(this.v, this.q, this.s);
      this.crown.setMatrixAt(i, this.m);
      this.col.copy(LOW).lerp(HIGH, b / 255);
      this.crown.setColorAt(i, this.col);
    }
    this.crown.instanceMatrix.needsUpdate = true;
    if (this.crown.instanceColor) this.crown.instanceColor.needsUpdate = true;
  }
}

/** Deterministic stand-in rounds for recording: every other round has a silent validator. */
export function demoRound(n: number, crackEvery = 2): SceneRound {
  let h = 2166136261 ^ n;
  let value = '';
  for (let i = 0; i < BYTES; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909);
    value += ((h >>> 0) & 255).toString(16).padStart(2, '0');
  }
  const cracked = crackEvery > 0 && n % crackEvery === 0;
  // Typical soak timings; a crack is the 10 s reveal window plus a native solve of ~2.5 min (SPEC.md §2.1).
  const ms = { commit: 120 + (h >>> 0) % 180, reveal: cracked ? 10_000 : 560 + ((h >>> 8) >>> 0) % 160, crack: cracked ? 150_000 : undefined };
  return { round: n, value, cracked: cracked ? [2] : [], ms };
}
