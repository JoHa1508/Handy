// Pixel golden retriever that walks along the screen edge, listens while the
// user dictates and thinks while the text is being produced. Runs in the `bot_overlay`
// window (see src-tauri/src/overlay.rs). Opened in a plain browser it shows a
// preview with buttons instead of listening for Tauri events.

type BotState = "idle" | "listen" | "think";
type Mode = "walk" | "stand" | "listen" | "think";

const GRID = 32; // sprite canvas, in cells
const BOX = 80; // sprite box on screen, in CSS px (2.5 px per cell)
let speed = 26; // walking speed, CSS px per second
const RUN_SPEED = 240; // speed on the way to the parking spot
const PARK_KEY = "handy-bot-parked";

// The golden retriever from Jos's "Mathe für Gina" mascot: left half of each
// row plus its centre column, mirrored to 21 columns. Rows 0-10 are the head.
const HALF: [string, string][] = [
  ["......oooo", "o"],
  [".....ogggg", "g"],
  ["...ooggggg", "g"],
  ["..oddggggg", "g"],
  [".odddgEEgg", "g"],
  [".odddgEEgg", "g"],
  [".oddgggggl", "l"],
  [".oddoggglk", "k"],
  ["..ooogglll", "l"],
  [".....ogllp", "p"],
  ["......oggl", "l"],
  [".....oggll", "c"],
  ["....ogggll", "c"],
  ["...oggggll", "c"],
  ["...ogggggl", "l"],
  ["...ogggogg", "g"],
  ["....ooolll", "o"],
  ["......oooo", "o"],
];
const ROWS = HALF.map(([h, c]) => h + c + h.split("").reverse().join(""));
const TAIL: [number, number, string][] = [
  [17, 12, "o"],
  [18, 11, "o"],
  [19, 10, "o"],
  [17, 13, "g"],
  [18, 12, "g"],
  [19, 11, "g"],
  [20, 10, "o"],
  [20, 11, "o"],
  [18, 13, "o"],
  [19, 12, "o"],
];
const PALETTE: Record<string, string> = {
  o: "#5b3a21",
  g: "#e3a54e",
  d: "#c98431",
  l: "#f7dcab",
  c: "#f7dcab",
  k: "#2a1b14",
  p: "#e9788b",
  E: "#2a1b14",
};
const WAVE = "#ffffff";
const WAVE_OUTLINE = "#1a1208";
const OX = 8; // sprite's left column inside the grid
const OY = 14; // sprite's top row; its last row sits on the grid's bottom row

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

// Parked: the dog sits at the bottom centre, where the pill used to be, until
// it is clicked again. Remembered across restarts.
let parked = false;
try {
  parked = window.localStorage.getItem(PARK_KEY) === "1";
} catch {
  // No storage: the dog simply starts out roaming.
}
// Last cursor position inside the window, or null when it is away from the dog.
let cursor: [number, number] | null = null;
let clickable = false;
let setClickThrough: ((ignore: boolean) => void) | undefined;

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

// Standing still the dog sits facing the viewer, exactly as in the mascot. On
// the move it is drawn from the side in the same palette, with a walk cycle.
const SIDE = [
  "............ggggggg.....",
  "...........ggggggggg....",
  "..........ddgggggggggg..",
  "..........dddgggEggggg..",
  "..........dddgggEggllll.",
  "..........dddggggglllk..",
  "...........ddggggglllll.",
  "............gggggggll...",
  "............ggggggg.....",
  "........gggggggggg......",
  ".....ggggggggggggg......",
  "...ggggggggggggggg......",
  "....gggggggggggggg......",
  "....gggggggggggggg......",
  "....gggllllllllggg......",
];
const SIDE_HEAD_ROWS = 9;
const SX = 4; // side sprite's left column inside the grid
const SY = 13; // side sprite's top row; paws end on row 30

function renderWalk() {
  const step = frame % 4;
  const wag = frame % 2 === 1;
  const hy = step % 2 === 1 ? 1 : 0;
  const blinking = performance.now() < blinkUntil;

  // Tail up, wagging.
  const tail: [number, number][] = wag
    ? [
        [0, 10],
        [1, 10],
        [1, 11],
        [2, 11],
      ]
    : [
        [1, 8],
        [1, 9],
        [2, 9],
        [2, 10],
        [3, 10],
      ];
  for (const [x, y] of tail) set(SX + x, SY + y, PALETTE.g);

  // Four short legs; diagonal pairs lift in turn.
  const legs: [number, boolean][] = [
    [4, step === 1],
    [7, step === 3],
    [13, step === 3],
    [16, step === 1],
  ];
  for (const [x, lifted] of legs) {
    if (lifted) {
      rect(SX + x + 1, SY + 15, 2, 1, PALETTE.g);
      rect(SX + x + 1, SY + 16, 2, 1, PALETTE.l);
    } else {
      rect(SX + x, SY + 15, 2, 2, PALETTE.g);
      rect(SX + x, SY + 17, 2, 1, PALETTE.l);
    }
  }

  // Body first, then the big head on top; the head nods with each step.
  for (let y = SIDE.length - 1; y >= 0; y--) {
    const row = SIDE[y];
    const dy = y < SIDE_HEAD_ROWS ? hy : 0;
    for (let x = 0; x < row.length; x++) {
      let ch = row[x];
      if (ch === ".") continue;
      if (ch === "E" && blinking) ch = y === 3 ? "g" : "o";
      set(SX + x, SY + y + dy, PALETTE[ch]);
    }
  }
  // A small tongue tip at the mouth while trotting along.
  if (frame % 8 < 4) set(SX + 20, SY + 8 + hy, PALETTE.p);
}

function render() {
  grid.fill(null);
  const walking = mode === "walk";
  const wagging = mode === "think" || (mode === "listen" && level > 0.06);
  const wag = wagging && frame % 2 === 1 ? -1 : 0;
  const eyesShut = mode === "think" || performance.now() < blinkUntil;

  if (walking) {
    renderWalk();
  } else {
    for (const [x, y, ch] of TAIL) set(OX + x, OY + y + wag, PALETTE[ch]);

    ROWS.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        let ch = row[x];
        if (ch === ".") continue;
        if (ch === "E" && eyesShut) ch = y === 4 ? "g" : "o";
        if (mode === "listen" && x <= 4 && y >= 4 && y <= 7) {
          // The left ear no longer hangs down here; close the head's outline.
          if (x < 4) continue;
          ch = "o";
        }
        set(OX + x, OY + y, PALETTE[ch]);
      }
    });
  }

  if (mode === "listen") {
    // Left ear pricked up, sound arcs arriving at it: more the louder.
    rect(OX + 2, OY, 1, 3, PALETTE.o);
    rect(OX + 3, OY - 1, 2, 1, PALETTE.o);
    rect(OX + 3, OY, 2, 3, PALETTE.d);
    const arcs = level > 0.4 ? 2 : level > 0.06 ? 1 : 0;
    for (let k = 0; k < arcs; k++) {
      const x = OX - 2 - k * 3;
      const half = 1 + k;
      set(x + 1, OY - half, WAVE);
      rect(x, OY + 1 - half, 1, half * 2, WAVE);
      set(x + 1, OY + 1 + half, WAVE);
    }
  }

  if (mode === "think") {
    // Thought bubbles rising above the head.
    const bubbles = frame % 4;
    if (bubbles >= 1) rect(OX + 16, OY - 3, 1, 1, WAVE);
    if (bubbles >= 2) rect(OX + 17, OY - 7, 2, 2, WAVE);
    if (bubbles >= 3) rect(OX + 17, OY - 12, 3, 3, WAVE);
  }

  // The sitting dog brings its own outline; the walking one gets it here.
  // Arcs and bubbles get a dark one so they read on light windows too.
  const outline: [number, string][] = [];
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < GRID && y < GRID ? grid[y * GRID + x] : null;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (grid[y * GRID + x]) continue;
      const around = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)];
      if (around.includes(WAVE)) {
        outline.push([y * GRID + x, WAVE_OUTLINE]);
      } else if (walking && around.some((c) => c)) {
        outline.push([y * GRID + x, PALETTE.o]);
      }
    }
  }
  for (const [i, color] of outline) grid[i] = color;

  // Walking, the dog faces where it goes. Sitting, its tail trails behind.
  const flip = walking ? dir < 0 : dir > 0;
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
  updateClickable();
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

function parkingSpot(): number {
  return edgeLength(0) / 2;
}

/** Shorter way round to the parking spot: 1 counter-clockwise, -1 clockwise. */
function directionToSpot(): number {
  const lengths = [0, 1, 2, 3].map(edgeLength);
  const total = lengths.reduce((a, b) => a + b, 0);
  let here = t;
  for (let e = 0; e < edge; e++) here += lengths[e];
  const ahead = (parkingSpot() - here + total) % total;
  return ahead <= total / 2 ? 1 : -1;
}

function plan() {
  if (state !== "idle") return;
  if (parked) {
    walk();
    return;
  }
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
  if (parked) {
    if (edge === 0 && Math.abs(t - parkingSpot()) < 1) {
      // Arrived: sit down and stay.
      setMode("stand");
      place(t, 0);
      return;
    }
    dir = directionToSpot();
  }
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
  let target = dir > 0 ? Math.min(end, t + stride) : Math.max(end, t - stride);
  if (parked) {
    const spot = parkingSpot();
    target = edge === 0 && (spot - t) * dir > 0 ? spot : end;
  }
  walkFrom = t;
  walkTarget = target;
  walkDuration = (Math.abs(target - t) / (parked ? RUN_SPEED : speed)) * 1000;
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

/** A click on the dog parks it at the bottom centre, the next one frees it. */
function togglePark() {
  parked = !parked;
  try {
    window.localStorage.setItem(PARK_KEY, parked ? "1" : "0");
  } catch {
    // Not remembered then.
  }
  if (state !== "idle") return;
  freeze();
  walk();
}

/**
 * The window lets every click through. Only while the cursor is on the dog
 * does it take clicks itself, so the dog can be clicked and nothing else is
 * ever blocked.
 */
function updateClickable() {
  let hit = false;
  if (cursor) {
    const r = botEl.getBoundingClientRect();
    hit =
      cursor[0] >= r.left &&
      cursor[0] <= r.right &&
      cursor[1] >= r.top &&
      cursor[1] <= r.bottom;
  }
  if (hit === clickable) return;
  clickable = hit;
  setClickThrough?.(!hit);
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
    if (parked && state === "idle") planTimer = window.setTimeout(walk, 300);
  }
});

botEl.addEventListener("click", togglePark);

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
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const appWindow = getCurrentWindow();
    setClickThrough = (ignore) => {
      void appWindow.setIgnoreCursorEvents(ignore);
    };
    await listen<[number, number]>("bot-cursor", (event) => {
      const [x, y] = event.payload;
      cursor = x < 0 ? null : [x, y];
      updateClickable();
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
