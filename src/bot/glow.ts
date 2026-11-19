/**
 * The edge glow: a quiet blue shimmer along the whole screen edge while a
 * session runs. It rises from the bottom centre, breathes a little with the
 * voice, shows two lights circling while Handy transcribes, then fades.
 *
 * Drawn on a small canvas that CSS stretches over the window, so the soft
 * falloff costs a few ten thousand pixels per frame instead of a full-screen
 * blur. Nothing runs while the glow is off.
 */

export type GlowState = "idle" | "listen" | "think";

export interface Glow {
  setState(next: GlowState): void;
  setLevel(value: number): void;
}

// One hue in three steps of brightness.
const COLORS: [number, number, number][] = [
  [138, 166, 218],
  [175, 189, 228],
  [92, 126, 196],
];
const STRENGTH = 0.8; // between "dezent" (0.62) and "mittel" (1) of the preview
const VOICE = 1.5; // how far the voice widens the glow
const STEPS = 256; // samples around the edge
const RISE_SECONDS = 1.2;
const FADE_SECONDS = 0.5;

type Phase = "off" | "listen" | "think" | "leave";

export function initGlow(canvas: HTMLCanvasElement): Glow {
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let phase: Phase = "off";
  let phaseTime = 0;
  let front = 0;
  let fade = 0;
  let level = 0;
  let target = 0;
  let running = false;
  let last = 0;
  let clock = 0;

  let width = 0;
  let height = 0;
  let unit = 1; // 1 % of the screen width, in canvas pixels
  let image: ImageData | null = null;
  let cells = new Uint32Array(0);
  let distX = new Float32Array(0);
  let distY = new Float32Array(0);
  let edgeFade = new Float32Array(0);
  let around = new Uint16Array(0);
  let fromOrigin = new Float32Array(0);

  const reach = new Float32Array(STEPS);
  const gain = new Float32Array(STEPS);
  const mixA = new Float32Array(STEPS);
  const mixB = new Float32Array(STEPS);

  function layout() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (!w || !h) return;
    const scale = Math.max(2.5, w / 420);
    width = Math.max(40, Math.round(w / scale));
    height = Math.max(30, Math.round(h / scale));
    canvas.width = width;
    canvas.height = height;
    image = ctx.createImageData(width, height);
    unit = width / 100;

    const maxDist = unit * 13;
    const hx = width / 2;
    const hy = height / 2;
    const far = Math.sqrt(hx * hx + height * height);
    const c: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    const fs: number[] = [];
    const as: number[] = [];
    const os: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const ex = Math.min(px, width - px);
        const ey = Math.min(py, height - py);
        const d = Math.min(ex, ey);
        if (d > maxDist) continue;
        let a =
          Math.atan2((py - hy) / height, (px - hx) / width) / (Math.PI * 2);
        if (a < 0) a += 1;
        // The glow starts at the bottom centre of the screen.
        const dx = px - hx;
        const dy = height - py;
        const f = 1 - d / maxDist;
        c.push(y * width + x);
        xs.push(ex);
        ys.push(ey);
        fs.push(f * f);
        as.push(Math.floor(a * STEPS) % STEPS);
        os.push(Math.sqrt(dx * dx + dy * dy) / far);
      }
    }
    cells = new Uint32Array(c);
    distX = new Float32Array(xs);
    distY = new Float32Array(ys);
    edgeFade = new Float32Array(fs);
    around = new Uint16Array(as);
    fromOrigin = new Float32Array(os);
  }

  function stop() {
    running = false;
    phase = "off";
    front = 0;
    fade = 0;
    level = 0;
    target = 0;
    ctx.clearRect(0, 0, width, height);
  }

  function frame(now: number) {
    if (!running || !image) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    phaseTime += dt;

    if (phase === "listen") {
      front = Math.min(1, front + dt / RISE_SECONDS);
      fade = Math.min(1, fade + dt / 0.25);
    } else if (phase === "think") {
      front = 1;
      fade = Math.min(1, fade + dt / 0.25);
      target = 0;
    } else {
      target = 0;
      fade = Math.max(0, fade - dt / FADE_SECONDS);
      if (fade <= 0) {
        stop();
        return;
      }
    }
    level += (target - level) * Math.min(1, dt * (target > level ? 16 : 5));
    // Between two mic events the voice falls away on its own.
    target *= Math.pow(0.04, dt);

    const sweep = (1 - Math.pow(1 - front, 2.2)) * 1.5;
    const think = phase === "think" ? Math.min(1, phaseTime / 0.3) : 0;
    const t = still ? 0 : clock;
    const turn = (t * 0.42) % 1;
    for (let i = 0; i < STEPS; i++) {
      const th = (i / STEPS) * Math.PI * 2;
      const n1 =
        0.5 +
        0.27 * Math.sin(th * 2 + t * 0.8) +
        0.15 * Math.sin(th * 5 - t * 1.3 + 1.3) +
        0.08 * Math.sin(th * 9 + t * 2 + 4);
      const n2 =
        0.5 +
        0.3 * Math.sin(th * 3 - t * 1.7 + 2) +
        0.2 * Math.sin(th * 7 + t * 2.6);
      let lobe = 0;
      if (think) {
        const a1 = Math.abs(((i / STEPS - turn + 1.5) % 1) - 0.5);
        const a2 = Math.abs(((i / STEPS - turn + 1) % 1) - 0.5);
        lobe =
          (Math.exp((-a1 * a1) / 0.006) + Math.exp((-a2 * a2) / 0.006)) * think;
      }
      reach[i] =
        unit *
        STRENGTH *
        ((0.75 + 0.7 * n1) * (1 - 0.3 * think) +
          level * VOICE * (0.3 + 0.7 * n2) +
          lobe * 1.1) *
        (0.55 + 0.45 * fade);
      gain[i] = 0.6 + 0.2 * n1 + level * 0.3 + lobe * 0.45 - 0.16 * think;
      mixA[i] = 0.5 + 0.5 * Math.sin(th + t * 0.35);
      mixB[i] = (0.5 + 0.5 * Math.sin(th * 2 - t * 0.5 + 1.7)) * 0.6;
    }

    const data = image.data;
    const rising = phase === "listen" && front < 1;
    const [c0, c1, c2] = COLORS;
    for (let j = 0; j < cells.length; j++) {
      const o = cells[j] * 4;
      let shown = (sweep - fromOrigin[j]) / 0.22;
      if (shown <= 0) {
        data[o + 3] = 0;
        continue;
      }
      if (shown > 1) shown = 1;
      const p = around[j];
      const w = reach[p];
      const e1 = Math.exp(-distX[j] / w);
      const e2 = Math.exp(-distY[j] / w);
      const h1 = Math.exp(-distX[j] / (w * 3.2));
      const h2 = Math.exp(-distY[j] / (w * 3.2));
      let a =
        gain[p] *
        (0.78 * (e1 + e2 - e1 * e2) + 0.22 * (h1 + h2 - h1 * h2)) *
        edgeFade[j];
      if (rising) {
        // A brighter crest where the glow is just arriving.
        const b = (sweep - fromOrigin[j] - 0.08) / 0.11;
        a *= 1 + 1.1 * Math.exp(-b * b);
      }
      a *= shown * fade;
      if (a > 1) a = 1;
      const m = mixA[p];
      const m2 = mixB[p];
      const r = c0[0] + (c1[0] - c0[0]) * m;
      const g = c0[1] + (c1[1] - c0[1]) * m;
      const b2 = c0[2] + (c1[2] - c0[2]) * m;
      data[o] = r + (c2[0] - r) * m2;
      data[o + 1] = g + (c2[1] - g) * m2;
      data[o + 2] = b2 + (c2[2] - b2) * m2;
      // A little noise keeps the faint outer part free of banding.
      data[o + 3] = a * 255 + Math.random() * 0.9;
    }
    ctx.putImageData(image, 0, 0);
    window.requestAnimationFrame(frame);
  }

  function run() {
    if (running) return;
    if (!image) layout();
    running = true;
    last = performance.now();
    window.requestAnimationFrame(frame);
  }

  window.addEventListener("resize", () => {
    layout();
  });

  return {
    setState(next) {
      if (next === "listen") {
        if (phase === "off" || phase === "leave") {
          front = phase === "off" ? 0 : front;
        }
        phase = "listen";
        phaseTime = 0;
        run();
      } else if (next === "think") {
        if (phase === "off") return;
        phase = "think";
        phaseTime = 0;
      } else if (phase !== "off") {
        phase = "leave";
        phaseTime = 0;
      }
    },
    setLevel(value) {
      if (!Number.isFinite(value) || phase !== "listen") return;
      target = Math.max(target, Math.min(1, value));
    },
  };
}
