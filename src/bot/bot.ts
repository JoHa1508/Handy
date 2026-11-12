// Pixel golden retriever that walks along the screen edge, listens while the
// user dictates and thinks while the text is being produced. Runs in the `bot_overlay`
// window (see src-tauri/src/overlay.rs). Opened in a plain browser it shows a
// preview with buttons instead of listening for Tauri events.

type BotState = "idle" | "listen" | "think";
type Mode = "walk" | "stand" | "listen" | "think";

const GRID = 32; // sprite canvas, in cells
const BOX = 64; // sprite box on screen, in CSS px (2 px per cell)
let speed = 26; // walking speed, CSS px per second

const COLOR = {
  gold: "#e8a93c",
  light: "#f7d083",
  dark: "#b9781f",
  ink: "#2a1a0e",
  tongue: "#f27b8a",
  wave: "#ffffff",
  outline: "#1a1208",
};

// Rotation of the sprite per edge, so the feet always touch the screen edge.
// Edge 0 bottom, 1 right, 2 top, 3 left; walking counter-clockwise for dir 1.
const EDGE_ROTATION = [0, -90, 180, 90];

const stageEl = document.getElementById("stage") as HTMLElement;
const botEl = document.getElementById("bot") as HTMLElement;
const canvas = document.getElementById("sprite") as HTMLCanvasElement;
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

const grid: (string | null)[] = new Array(GRID * GRID).fill(null);

let state: BotState = "idle";
let mode: Mode = "stand";
let frame = 0;
let level = 0;
let blinkUntil = 0;

let edge = 0;
let dir = 1;
let t = 0; // distance walked along the current edge, in CSS px
let walkFrom = 0;
let walkTarget = 0;
let walkStart = 0;
let walkDuration = 0;
let planTimer: number | undefined;
let tickTimer: number | undefined;
let thinkTimer: number | undefined;

function edgeLength(e: number): number {
  const r = stageEl.getBoundingClientRect();
  return Math.max(0, (e % 2 === 0 ? r.width : r.height) - BOX);
}

function position(e: number, d: number): [number, number] {
  const r = stageEl.getBoundingClientRect();
  const w = r.width - BOX;
  const h = r.height - BOX;
  if (e === 0) return [d, h];
  if (e === 1) return [w, h - d];
  if (e === 2) return [w - d, 0];
  return [0, d];
}

function place(d: number, seconds: number) {
  const [x, y] = position(edge, d);
  botEl.style.transition =
    seconds > 0 ? `transform ${seconds}s linear` : "none";
  botEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  canvas.style.transform = `rotate(${EDGE_ROTATION[edge]}deg)`;
}

// ---- drawing ----

function set(x: number, y: number, color: string) {
  if (x >= 0 && y >= 0 && x < GRID && y < GRID) grid[y * GRID + x] = color;
}

function rect(x: number, y: number, w: number, h: number, color: string) {
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) set(x + i, y + j, color);
}

// The dog is drawn from the side, facing right, paws on row 30.
function render() {
  grid.fill(null);
  const walking = mode === "walk";
  const sitting = mode === "listen" || mode === "think";
  const step = walking ? frame % 4 : 0;
  const wag = frame % 2 === 1;

  if (sitting) {
    // Tail on the ground, wagging faster the louder the voice.
    if (wag && (mode === "think" || level > 0.06)) {
      rect(6, 27, 3, 2, COLOR.gold);
      rect(5, 25, 2, 2, COLOR.gold);
    } else {
      rect(5, 28, 5, 2, COLOR.gold);
    }
    // Haunch, chest and front legs.
    rect(9, 24, 7, 6, COLOR.gold);
    rect(10, 30, 7, 1, COLOR.light);
    rect(14, 20, 6, 8, COLOR.gold);
    rect(17, 23, 3, 4, COLOR.light);
    rect(18, 27, 2, 3, COLOR.gold);
    rect(18, 30, 3, 1, COLOR.light);
  } else {
    // Tail up, wagging while walking.
    if (walking && wag) {
      rect(6, 21, 2, 2, COLOR.gold);
      rect(4, 20, 3, 2, COLOR.gold);
    } else {
      rect(6, 20, 2, 3, COLOR.gold);
      rect(5, 18, 2, 3, COLOR.gold);
    }
    // Four legs; diagonal pairs lift in turn.
    const legs: [number, boolean][] = [
      [8, step === 1],
      [11, step === 3],
      [17, step === 3],
      [20, step === 1],
    ];
    for (const [x, lifted] of legs) {
      if (lifted) {
        rect(x + 1, 27, 2, 2, COLOR.gold);
        rect(x + 1, 29, 2, 1, COLOR.light);
      } else {
        rect(x, 27, 2, 3, COLOR.gold);
        rect(x, 30, 2, 1, COLOR.light);
      }
    }
    // Body with a lighter belly.
    rect(8, 22, 14, 5, COLOR.gold);
    rect(10, 26, 9, 1, COLOR.light);
  }

  // Neck and head; the head bobs a little while walking.
  const hy = walking && step % 2 === 1 ? 1 : 0;
  rect(17, 19, 4, 4, COLOR.gold);
  rect(19, 14 + hy, 5, 1, COLOR.gold);
  rect(18, 15 + hy, 7, 6, COLOR.gold);
  // Muzzle, nose, eye.
  rect(24, 17 + hy, 4, 3, COLOR.light);
  set(27, 17 + hy, COLOR.ink);
  const blinking = performance.now() < blinkUntil;
  if (mode === "think" || blinking) {
    rect(21, 17 + hy, 2, 1, COLOR.dark);
  } else {
    set(22, 16 + hy, COLOR.ink);
  }
  // Tongue out while trotting along.
  if (walking && frame % 8 < 4) rect(25, 20 + hy, 1, 2, COLOR.tongue);

  if (mode === "listen") {
    // Ear pricked up, sound arcs arriving at it: more the louder the voice.
    rect(18, 11, 2, 5, COLOR.dark);
    const arcs = level > 0.5 ? 3 : level > 0.22 ? 2 : level > 0.06 ? 1 : 0;
    for (let k = 0; k < arcs; k++) {
      const x = 15 - k * 3;
      const half = 1 + k;
      set(x + 1, 12 - half, COLOR.wave);
      rect(x, 13 - half, 1, half * 2, COLOR.wave);
      set(x + 1, 13 + half, COLOR.wave);
    }
  } else {
    // Floppy ear.
    rect(18, 15 + hy, 2, 5, COLOR.dark);
  }

  if (mode === "think") {
    // Thought bubbles rising above the head.
    const bubbles = frame % 4;
    if (bubbles >= 1) rect(25, 11, 1, 1, COLOR.wave);
    if (bubbles >= 2) rect(26, 7, 2, 2, COLOR.wave);
    if (bubbles >= 3) rect(26, 2, 3, 3, COLOR.wave);
  }

  // Dark outline so the dog reads on light and dark windows alike.
  const outline: number[] = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (grid[y * GRID + x]) continue;
      const filled =
        (x > 0 && grid[y * GRID + x - 1]) ||
        (x < GRID - 1 && grid[y * GRID + x + 1]) ||
        (y > 0 && grid[(y - 1) * GRID + x]) ||
        (y < GRID - 1 && grid[(y + 1) * GRID + x]);
      if (filled) outline.push(y * GRID + x);
    }
  }
  for (const i of outline) grid[i] = COLOR.outline;

  // Mirror when walking clockwise so the dog faces where it goes.
  const flip = dir < 0;
  ctx.clearRect(0, 0, GRID, GRID);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const color = grid[y * GRID + x];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(flip ? GRID - 1 - x : x, y, 1, 1);
    }
  }
}

// Few frames per second on purpose: the window is always on screen.
const TICK_MS: Record<Mode, number> = {
  walk: 150,
  stand: 500,
  listen: 100,
  think: 260,
};

function tick() {
  frame++;
  level *= 0.8;
  if (mode === "stand" && Math.random() < 0.15) {
    blinkUntil = performance.now() + 400;
  }
  render();
  tickTimer = window.setTimeout(tick, TICK_MS[mode]);
}

function setMode(next: Mode) {
  mode = next;
  window.clearTimeout(tickTimer);
  render();
  tickTimer = window.setTimeout(tick, TICK_MS[mode]);
}

// ---- walking ----

function currentDistance(): number {
  if (mode !== "walk" || walkDuration <= 0) return t;
  const done = Math.min(1, (performance.now() - walkStart) / walkDuration);
  return walkFrom + (walkTarget - walkFrom) * done;
}

function freeze() {
  window.clearTimeout(planTimer);
  t = currentDistance();
  place(t, 0);
}

function plan() {
  if (state !== "idle") return;
  const length = edgeLength(edge);
  t = Math.min(Math.max(t, 0), length);

  if (Math.random() < 0.22) {
    // Stand around for a moment, now and then turn back.
    setMode("stand");
    place(t, 0);
    planTimer = window.setTimeout(
      () => {
        if (Math.random() < 0.25) dir = -dir;
        walk();
      },
      1500 + Math.random() * 3500,
    );
    return;
  }
  walk();
}

function walk() {
  if (state !== "idle") return;
  const length = edgeLength(edge);
  const end = dir > 0 ? length : 0;

  if (Math.abs(end - t) < 1) {
    // Corner: carry on along the next edge.
    edge = (edge + (dir > 0 ? 1 : 3)) % 4;
    t = dir > 0 ? 0 : edgeLength(edge);
    place(t, 0);
    planTimer = window.setTimeout(walk, 60);
    return;
  }

  const stride = 140 + Math.random() * 420;
  const target =
    dir > 0 ? Math.min(end, t + stride) : Math.max(end, t - stride);
  walkFrom = t;
  walkTarget = target;
  walkDuration = (Math.abs(target - t) / speed) * 1000;
  walkStart = performance.now();
  setMode("walk");
  // Let the browser apply the start position before the transition begins.
  place(t, 0);
  void botEl.offsetWidth;
  place(target, walkDuration / 1000);
  planTimer = window.setTimeout(() => {
    t = target;
    plan();
  }, walkDuration);
}

function setState(next: BotState) {
  if (next === state) return;
  state = next;
  window.clearTimeout(thinkTimer);
  freeze();
  if (next === "idle") {
    setMode("stand");
    planTimer = window.setTimeout(walk, 700);
    return;
  }
  setMode(next);
  if (next === "think") {
    // Never get stuck thinking if the end of a session goes missing.
    thinkTimer = window.setTimeout(() => setState("idle"), 120000);
  }
}

function setLevel(value: number) {
  if (Number.isFinite(value)) level = Math.max(level, Math.min(1, value));
}

function fromBackend(value: string): BotState {
  if (value === "recording" || value === "streaming") return "listen";
  if (value === "transcribing" || value === "processing") return "think";
  return "idle";
}

window.addEventListener("resize", () => {
  if (mode === "walk") {
    freeze();
    setMode("stand");
    if (state === "idle") planTimer = window.setTimeout(walk, 300);
  } else {
    t = Math.min(t, edgeLength(edge));
    place(t, 0);
  }
});

async function start() {
  t = Math.random() * edgeLength(0);
  place(t, 0);
  setMode("stand");
  planTimer = window.setTimeout(walk, 800);

  if ("__TAURI_INTERNALS__" in window) {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string>("bot-state", (event) => {
      setState(fromBackend(event.payload));
    });
    await listen<number[]>("mic-level", (event) => {
      let peak = 0;
      for (const v of event.payload) if (v > peak) peak = v;
      setLevel(peak);
    });
    return;
  }

  // Browser preview: buttons for the states and a made-up voice level.
  const api = {
    setState,
    setLevel,
    setSpeed: (value: number) => {
      speed = value;
    },
  };
  (window as unknown as { handyBot: typeof api }).handyBot = api;
  window.setInterval(() => {
    if (state === "listen") setLevel(Math.random() ** 2);
  }, 180);
  if (document.documentElement.dataset.botControls === "own") return;
  document.body.classList.add("bot-preview");
  const controls = document.createElement("div");
  controls.className = "bot-preview-controls";
  for (const [label, value] of [
    ["Walk", "idle"],
    ["Listen", "listen"],
    ["Think", "think"],
  ] as [string, BotState][]) {
    const button = document.createElement("button");
    button.textContent = label;
    button.addEventListener("click", () => setState(value));
    controls.appendChild(button);
  }
  stageEl.appendChild(controls);
}

void start();
