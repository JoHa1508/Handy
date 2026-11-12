// Pixel bot that walks along the screen edge, listens while the user dictates
// and thinks while the text is being produced. Runs in the `bot_overlay`
// window (see src-tauri/src/overlay.rs). Opened in a plain browser it shows a
// preview with buttons instead of listening for Tauri events.

type BotState = "idle" | "listen" | "think";
type Mode = "walk" | "stand" | "listen" | "think";

const GRID = 32; // sprite canvas, in cells
const BOX = 64; // sprite box on screen, in CSS px (2 px per cell)
const SPEED = 26; // walking speed, CSS px per second
const OX = 6; // sprite's left column inside the grid

const COLOR = {
  hi: "#a9d6ff",
  head: "#5aa9ff",
  shade: "#3a7bd5",
  arm: "#2c5fb0",
  screen: "#131a2e",
  eye: "#7df9ff",
  eyeDim: "#2e6f8a",
  horn: "#ffc94d",
  wave: "#ffffff",
  outline: "#0e1424",
};

const HEAD = [
  ".....HHHH.....",
  "..HHHBBBBHHH..",
  ".HBBBBBBBBBBB.",
  "HBBBBBBBBBBBBB",
  "BBDDDDDDDDDDBB",
  "BBDDDDDDDDDDBB",
  "BBDDDDDDDDDDBB",
  "BBDDDDDDDDDDBB",
  "BBDDDDDDDDDDBB",
  "BBBBBBBBBBBBBS",
  ".SBBBBBBBBBBS.",
  "..SSSSSSSSSS..",
];
const HEAD_COLOR: Record<string, string> = {
  H: COLOR.hi,
  B: COLOR.head,
  S: COLOR.shade,
  D: COLOR.screen,
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

function render() {
  grid.fill(null);
  const walking = mode === "walk";
  const step = walking ? frame % 4 : 0;
  const bob = step % 2 === 1 ? -1 : 0;

  // Legs and feet.
  for (const [x, lifted] of [
    [OX + 5, step === 1],
    [OX + 8, step === 3],
  ] as [number, boolean][]) {
    if (lifted) {
      rect(x, 28, 1, 1, COLOR.shade);
      rect(x, 29, 2, 1, COLOR.shade);
    } else {
      rect(x, 28, 1, 2, COLOR.shade);
      rect(x, 30, 2, 1, COLOR.shade);
    }
  }

  // Body, then the arm that hangs down on the left.
  rect(OX + 4, 24, 6, 4, COLOR.shade);
  rect(OX + 3, 25, 1, step === 1 ? 3 : 2, COLOR.arm);
  if (mode === "walk" || mode === "stand") {
    rect(OX + 10, 25, 1, step === 3 ? 3 : 2, COLOR.arm);
  }

  // Head.
  HEAD.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const color = HEAD_COLOR[row[i]];
      if (color) set(OX + i, 13 + bob + j, color);
    }
  });

  // Face on the screen.
  const sx = OX + 2;
  const sy = 17 + bob;
  if (mode === "think") {
    const active = frame % 3;
    for (let i = 0; i < 3; i++) {
      const on = i === active;
      rect(
        sx + 1 + i * 3,
        sy + (on ? 1 : 2),
        2,
        1,
        on ? COLOR.eye : COLOR.eyeDim,
      );
    }
  } else {
    const blinking = performance.now() < blinkUntil;
    const look = walking ? 1 : 0;
    const top = mode === "listen" ? 1 : blinking ? 2 : 1;
    const height = mode === "listen" ? 3 : blinking ? 1 : 2;
    rect(sx + 2 + look, sy + top, 2, height, COLOR.eye);
    rect(sx + 6 + look, sy + top, 2, height, COLOR.eye);
  }

  if (mode === "listen") {
    // Arm up to the ear, holding a little ear trumpet.
    set(OX + 10, 25, COLOR.arm);
    set(OX + 11, 24, COLOR.arm);
    set(OX + 12, 23, COLOR.arm);
    set(OX + 13, 22, COLOR.arm);
    rect(OX + 14, 20, 1, 2, COLOR.hi);
    rect(OX + 14, 18, 1, 2, COLOR.horn);
    rect(OX + 15, 17, 1, 4, COLOR.horn);
    rect(OX + 16, 16, 1, 6, COLOR.horn);
    // Sound arcs: more of them the louder the voice.
    const arcs = level > 0.5 ? 3 : level > 0.22 ? 2 : level > 0.06 ? 1 : 0;
    for (let k = 0; k < arcs; k++) {
      const x = OX + 18 + k * 3;
      const half = 1 + k;
      set(x - 1, 18 - half, COLOR.wave);
      rect(x, 19 - half, 1, half * 2, COLOR.wave);
      set(x - 1, 19 + half, COLOR.wave);
    }
  }

  if (mode === "think") {
    // Hand at the chin and thought bubbles rising above the head.
    set(OX + 10, 25, COLOR.arm);
    set(OX + 11, 24, COLOR.arm);
    set(OX + 11, 23, COLOR.arm);
    rect(OX + 9, 23, 2, 1, COLOR.hi);
    const bubbles = frame % 4;
    if (bubbles >= 1) rect(OX + 13, 10, 1, 1, COLOR.wave);
    if (bubbles >= 2) rect(OX + 15, 6, 2, 2, COLOR.wave);
    if (bubbles >= 3) rect(OX + 18, 1, 3, 3, COLOR.wave);
  }

  // Dark outline so the bot reads on light and dark windows alike.
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

  // Mirror when walking clockwise so the bot faces where it goes.
  const flip = dir < 0 && (mode === "walk" || mode === "stand");
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
  walkDuration = (Math.abs(target - t) / SPEED) * 1000;
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
  const api = { setState, setLevel };
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
