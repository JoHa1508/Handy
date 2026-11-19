// Pixel golden retriever that walks along the screen edge, listens while the
// user dictates and thinks while the text is being produced. Runs in the `bot_overlay`
// window (see src-tauri/src/overlay.rs). Opened in a plain browser it shows a
// preview with buttons instead of listening for Tauri events.

import { initFocus, type Focus } from "./focus";
import { initGlow } from "./glow";

type BotState = "idle" | "listen" | "think";
type Mode = "walk" | "stand" | "listen" | "think" | "sleep" | "chew" | "eat";

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
type Breed = "golden" | "berner";
const BREED_KEY = "handy-bot-breed";
const PALETTES: Record<Breed, Record<string, string>> = {
  golden: {
    o: "#5b3a21",
    g: "#e3a54e",
    d: "#c98431",
    l: "#f7dcab",
    c: "#f7dcab",
    k: "#2a1b14",
    p: "#e9788b",
    E: "#2a1b14",
  },
  berner: {
    o: "#1a1514",
    g: "#2d2725",
    d: "#1f1a19",
    l: "#f6f1e8",
    c: "#f6f1e8",
    k: "#120d0c",
    p: "#e9788b",
    E: "#120d0c",
    r: "#b8642a",
  },
};
// The Bernese mountain dog's markings on top of the shared sprites: rust
// eyebrows, cheeks and paws, a white blaze (front) and a white chest (side).
const BERNER_FRONT: [number, number, string][] = [
  [6, 3, "r"],
  [7, 3, "r"],
  [13, 3, "r"],
  [14, 3, "r"],
  [4, 6, "r"],
  [16, 6, "r"],
  [5, 7, "r"],
  [15, 7, "r"],
  [4, 15, "r"],
  [16, 15, "r"],
  [9, 1, "l"],
  [10, 1, "l"],
  [11, 1, "l"],
  [9, 2, "l"],
  [10, 2, "l"],
  [11, 2, "l"],
  [10, 3, "l"],
  [9, 3, "l"],
  [11, 3, "l"],
];
const BERNER_SIDE: [number, number, string][] = [
  [16, 2, "r"],
  [18, 6, "r"],
  [17, 7, "r"],
  [18, 7, "r"],
  [16, 10, "l"],
  [17, 10, "l"],
  [16, 11, "l"],
  [17, 11, "l"],
  [17, 12, "l"],
];
let breed: Breed = "golden";
try {
  if (window.localStorage.getItem(BREED_KEY) === "berner") breed = "berner";
} catch {
  // No storage: golden retriever it is.
}
let PALETTE = PALETTES[breed];
const WAVE = "#ffffff";
const WAVE_OUTLINE = "#1a1208";
const OX = 8; // sprite's left column inside the grid
const OY = 14; // sprite's top row; its last row sits on the grid's bottom row

// Rotation of the sprite per edge, so the feet always touch the screen edge.
// Edge 0 bottom, 1 right, 2 top, 3 left; walking counter-clockwise for dir 1.
const EDGE_ROTATION = [0, -90, 180, 90];

const stageEl = document.getElementById("stage") as HTMLElement;
// The window covers the whole screen so the glow reaches every edge; the dog
// keeps to the area below the menu bar.
const menuBar = (window.screen as Screen & { availTop?: number }).availTop ?? 0;
if ("__TAURI_INTERNALS__" in window && menuBar > 0 && menuBar < 80) {
  stageEl.style.top = `${menuBar}px`;
}
const glow = initGlow(document.getElementById("glow") as HTMLCanvasElement);
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

// Home life: visits to the hut, the bowl, being stroked.
let visiting = false;
let wantFood = false;
let forcedAct: Mode | null = null;
let homeTimer: number | undefined;
let visitTimer: number | undefined;
let hoverSince = 0;
let pettingPause = false;
let lastHeart = 0;
// A focus session runs: the dog sits at home, quiet, until it is over.
let focusing = false;
let focus: Focus | undefined;

// ---- hut and bowl, always at the bottom right ----

const CELL = BOX / GRID;

function makeProp(className: string, w: number, h: number): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.className = className;
  el.width = w;
  el.height = h;
  el.style.width = `${w * CELL}px`;
  el.style.height = `${h * CELL}px`;
  stageEl.insertBefore(el, botEl);
  return el;
}

type Put = (x: number, y: number, w: number, h: number, color: string) => void;

/** Paints a small pixel prop with a dark outline around it. */
function drawProp(el: HTMLCanvasElement, draw: (put: Put) => void) {
  const w = el.width;
  const h = el.height;
  const cells: (string | null)[] = new Array(w * h).fill(null);
  draw((x, y, rw, rh, color) => {
    for (let j = 0; j < rh; j++) {
      for (let i = 0; i < rw; i++) {
        const cx = x + i;
        const cy = y + j;
        if (cx >= 0 && cy >= 0 && cx < w && cy < h) cells[cy * w + cx] = color;
      }
    }
  });
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h ? cells[y * w + x] : null;
  const edgeCells: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cells[y * w + x]) continue;
      if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) {
        edgeCells.push(y * w + x);
      }
    }
  }
  for (const i of edgeCells) cells[i] = "#3b2314";
  const c = el.getContext("2d") as CanvasRenderingContext2D;
  c.clearRect(0, 0, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const color = cells[y * w + x];
      if (!color) continue;
      c.fillStyle = color;
      c.fillRect(x, y, 1, 1);
    }
  }
}

const hutEl = makeProp("bot-hut", 34, 32);
const bowlEl = makeProp("bot-bowl", 14, 9);

function drawHut() {
  drawProp(hutEl, (put) => {
    // Roof.
    for (let y = 0; y < 12; y++) {
      const half = 2 + Math.round(y * 1.25);
      put(17 - half, 1 + y, half * 2, 1, y === 11 ? "#7d2f27" : "#b5483a");
    }
    // Plank walls.
    put(4, 13, 26, 18, "#d9a066");
    for (const y of [17, 21, 25, 29]) put(4, y, 26, 1, "#b97a45");
    // Arched entrance.
    put(13, 17, 8, 1, "#2a1b14");
    put(12, 18, 10, 1, "#2a1b14");
    put(11, 19, 12, 12, "#2a1b14");
    if (mode === "sleep") {
      // The dog asleep inside, head on its paws.
      put(12, 25, 10, 6, PALETTE.g);
      put(12, 25, 2, 4, PALETTE.d);
      put(15, 28, 6, 3, PALETTE.l);
      put(17, 28, 2, 1, PALETTE.k);
      put(14, 27, 2, 1, PALETTE.o);
      put(19, 27, 2, 1, PALETTE.o);
    }
  });
}

function drawBowl() {
  drawProp(bowlEl, (put) => {
    if (wantFood) {
      put(4, 1, 6, 1, "#8a5a2b");
      put(3, 2, 8, 2, "#8a5a2b");
      put(5, 2, 1, 1, "#a8743a");
      put(8, 3, 1, 1, "#a8743a");
    }
    put(1, 4, 12, 1, "#e8574e");
    put(2, 5, 10, 2, "#c63d35");
    put(3, 7, 8, 1, "#a32f29");
  });
}

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

function renderWalk(eating: boolean) {
  const step = eating ? 0 : frame % 4;
  const wag = frame % 2 === 1;
  // Eating, the head goes down to the bowl and bobs there.
  const hy = eating ? 3 + (frame % 2) : step % 2 === 1 ? 1 : 0;
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
  if (breed === "berner") {
    for (const [x, y, ch] of BERNER_SIDE) {
      set(SX + x, SY + y + (y < SIDE_HEAD_ROWS ? hy : 0), PALETTE[ch]);
    }
  }
  // Tongue hanging out in front of the chest, flapping a little.
  if (!eating) rect(SX + 20, SY + 8 + hy, 2, frame % 4 < 2 ? 2 : 1, PALETTE.p);
}

function render() {
  grid.fill(null);
  // Side view for walking and eating, front view for everything else.
  const walking = mode === "walk" || mode === "eat";
  const wagging =
    mode === "think" || mode === "chew" || (mode === "listen" && level > 0.06);
  const wag = wagging && frame % 2 === 1 ? -1 : 0;
  const eyesShut = mode === "think" || performance.now() < blinkUntil;

  if (walking) {
    renderWalk(mode === "eat");
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
    if (breed === "berner") {
      for (const [x, y, ch] of BERNER_FRONT) {
        // Not where the pricked-up ear has left the cheek bare.
        if (mode === "listen" && x <= 4 && y >= 4 && y <= 7) continue;
        if (eyesShut && y === 3) continue;
        set(OX + x, OY + y, PALETTE[ch]);
      }
    }
  }

  if (mode === "chew") {
    // A bone across the mouth, worked up and down.
    const by = OY + 9 + (frame % 2);
    rect(OX + 6, by, 9, 1, WAVE);
    for (const x of [OX + 5, OX + 15]) {
      set(x, by - 1, WAVE);
      set(x, by + 1, WAVE);
    }
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
  sleep: 700,
  chew: 300,
  eat: 220,
};

function tick() {
  frame++;
  level *= 0.8;
  if (mode === "stand" && Math.random() < 0.15) {
    blinkUntil = performance.now() + 400;
  }
  render();
  updateClickable();
  const now = performance.now();
  if (
    hoverSince > 0 &&
    mode !== "sleep" &&
    now - hoverSince > 2000 &&
    now - lastHeart > 450
  ) {
    // Stroked for a couple of seconds: hearts.
    lastHeart = now;
    heart();
  }
  if (mode === "sleep" && frame % 3 === 0) {
    const s = stageEl.getBoundingClientRect();
    const h = hutEl.getBoundingClientRect();
    floatUp(
      "z",
      h.left - s.left + h.width * 0.7,
      h.top - s.top + 6,
      "#ffffff",
      0,
      -1,
    );
  }
  tickTimer = window.setTimeout(tick, TICK_MS[mode]);
}

function setMode(next: Mode) {
  const sleepChanged = (mode === "sleep") !== (next === "sleep");
  mode = next;
  // Asleep, the dog is inside the hut and drawn there.
  botEl.style.visibility = mode === "sleep" ? "hidden" : "visible";
  if (sleepChanged) drawHut();
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
  window.clearTimeout(homeTimer);
  t = currentDistance();
  place(t, 0);
}

/** The dog's place at home: bottom right, in front of bowl and hut. */
function parkingSpot(): number {
  return Math.max(0, edgeLength(0) - 120);
}

/** Parked for good, on a visit to the hut, or called to a full bowl. */
function needHome(): boolean {
  return parked || visiting || wantFood || focusing;
}

function arriveHome() {
  place(t, 0);
  if (wantFood) {
    // Face the bowl and eat it empty, then hearts.
    dir = 1;
    setMode("eat");
    homeTimer = window.setTimeout(() => {
      wantFood = false;
      drawBowl();
      setMode("stand");
      for (let i = 0; i < 4; i++) window.setTimeout(heart, i * 260);
      homeTimer = window.setTimeout(nextAtHome, 2600);
    }, 5000);
    return;
  }
  nextAtHome();
}

/** At home the dog sits, sleeps in the hut or chews a bone, in turns. */
function nextAtHome() {
  if (state !== "idle") return;
  if (focusing) {
    setMode("stand");
    return;
  }
  if (!parked && !visiting) {
    walk();
    return;
  }
  let act: Mode;
  if (forcedAct) {
    act = forcedAct;
    forcedAct = null;
  } else if (visiting) {
    act = Math.random() < 0.6 ? "sleep" : "chew";
  } else {
    const r = Math.random();
    act = r < 0.4 ? "stand" : r < 0.75 ? "sleep" : "chew";
  }
  const duration =
    act === "sleep"
      ? 40000 + Math.random() * 80000
      : act === "chew"
        ? 20000 + Math.random() * 20000
        : 10000 + Math.random() * 20000;
  setMode(act);
  homeTimer = window.setTimeout(() => {
    visiting = false;
    setMode("stand");
    nextAtHome();
  }, duration);
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
  if (needHome()) {
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
  window.clearTimeout(homeTimer);
  if (needHome()) {
    if (edge === 0 && Math.abs(t - parkingSpot()) < 1) {
      arriveHome();
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
  if (needHome()) {
    const spot = parkingSpot();
    target = edge === 0 && (spot - t) * dir > 0 ? spot : end;
  }
  walkFrom = t;
  walkTarget = target;
  walkDuration =
    (Math.abs(target - t) / (needHome() ? RUN_SPEED : speed)) * 1000;
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
  hideBubble(false);
  state = next;
  glow.setState(next);
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

// Now and then the dog says something kind to Gina in a small speech bubble.
const LINES = [
  "Gina, du bist die Beste. Wuff!",
  "Jos hat dich ganz doll lieb, Gina.",
  "Hab ich schon gesagt, wie toll du bist, Gina?",
  "Gina, mit dir ist jeder Tag schöner.",
  "Ich wedel nur für dich, Gina.",
  "Gina, du schaffst heute alles.",
  "Jos denkt gerade an dich, Gina.",
  "Du hast das schönste Lächeln, Gina.",
  "Gina, trink mal einen Schluck Wasser.",
  "Pfote drauf: Gina ist wunderbar.",
  "Gina, ich bin stolz auf dich.",
  "Kurze Pause, Gina? Du hast sie verdient.",
  "Jos kann sein Glück kaum fassen, Gina.",
  "Gina, du bist mein Lieblingsmensch.",
  "Schön, dass es dich gibt, Gina.",
  "Gina, du machst das richtig gut.",
  "Ein Herzchen für Gina! ♥",
  "Gina, mit dir gehe ich überall Gassi.",
  "Jos liebt dich, Gina. Ich auch. Wuff!",
  "Gina, du bist klüger, als du denkst.",
  "Gina, heute siehst du wieder toll aus.",
  "Für dich hole ich jedes Stöckchen, Gina.",
];
const bubbleEl = document.createElement("div");
bubbleEl.className = "bot-bubble";
stageEl.appendChild(bubbleEl);
let talking = false;
let lastLine = -1;
let sayTimer: number | undefined;
let hideTimer: number | undefined;

function hideBubble(resume: boolean) {
  window.clearTimeout(hideTimer);
  if (!talking) return;
  talking = false;
  bubbleEl.classList.remove("show");
  if (resume && state === "idle") planTimer = window.setTimeout(walk, 400);
}

/** Stops, sits down and shows one line next to the dog. False if busy. */
function say(): boolean {
  if (state !== "idle" || talking || focusing) return false;
  if (mode !== "walk" && mode !== "stand") return false;
  freeze();
  setMode("stand");
  let i = Math.floor(Math.random() * LINES.length);
  if (i === lastLine) i = (i + 1) % LINES.length;
  lastLine = i;
  bubbleEl.textContent = LINES[i];

  // Towards the inside of the screen, next to the dog, never off screen.
  const s = stageEl.getBoundingClientRect();
  const r = botEl.getBoundingClientRect();
  const bw = bubbleEl.offsetWidth;
  const bh = bubbleEl.offsetHeight;
  const gap = BOX * 0.66;
  const cx = r.left - s.left + r.width / 2;
  const cy = r.top - s.top + r.height / 2;
  let x = cx - bw / 2;
  let y = cy - bh / 2;
  if (edge === 0) y = s.height - gap - bh;
  else if (edge === 2) y = gap;
  else if (edge === 1) x = s.width - gap - bw;
  else x = gap;
  x = Math.max(6, Math.min(s.width - bw - 6, x));
  y = Math.max(6, Math.min(s.height - bh - 6, y));
  bubbleEl.style.left = `${Math.round(x)}px`;
  bubbleEl.style.top = `${Math.round(y)}px`;
  bubbleEl.classList.add("show");
  talking = true;
  hideTimer = window.setTimeout(() => hideBubble(true), 6500);
  return true;
}

function scheduleSay(min: number, max: number) {
  window.clearTimeout(sayTimer);
  sayTimer = window.setTimeout(
    () => {
      // Every 5 to 12 minutes; if the dog is busy, try again shortly.
      if (say()) scheduleSay(300000, 720000);
      else scheduleSay(30000, 60000);
    },
    min + Math.random() * (max - min),
  );
}

let reportBreed: ((value: Breed) => void) | undefined;

/** Shows the given dog, remembers it and tells the tray menu. */
function setBreed(next: Breed) {
  breed = next;
  PALETTE = PALETTES[breed];
  reportBreed?.(breed);
  try {
    window.localStorage.setItem(BREED_KEY, breed);
  } catch {
    // Not remembered then.
  }
  render();
  drawHut();
}

/** A right-click on the dog swaps golden retriever and Bernese mountain dog. */
function toggleBreed() {
  setBreed(breed === "golden" ? "berner" : "golden");
}

const INWARD = [
  [0, -1],
  [-1, 0],
  [0, 1],
  [1, 0],
];

/** A little glyph that drifts away from the screen edge and fades. */
function floatUp(
  text: string,
  x: number,
  y: number,
  color: string,
  dx: number,
  dy: number,
) {
  const el = document.createElement("span");
  el.className = "bot-float";
  el.textContent = text;
  el.style.color = color;
  el.style.left = `${Math.round(x - 7)}px`;
  el.style.top = `${Math.round(y - 9)}px`;
  stageEl.appendChild(el);
  el.animate(
    [
      { transform: "translate(0, 0) scale(0.6)", opacity: 0 },
      { opacity: 1, offset: 0.2 },
      {
        transform: `translate(${dx * 42}px, ${dy * 42}px) scale(1.15)`,
        opacity: 0,
      },
    ],
    { duration: 1500, easing: "ease-out" },
  );
  window.setTimeout(() => el.remove(), 1450);
}

function heart() {
  const s = stageEl.getBoundingClientRect();
  const r = botEl.getBoundingClientRect();
  const [dx, dy] = INWARD[edge];
  const spread = (Math.random() - 0.5) * 44;
  const x = r.left - s.left + r.width / 2 + dx * 16 + (dy !== 0 ? spread : 0);
  const y = r.top - s.top + r.height / 2 + dy * 16 + (dx !== 0 ? spread : 0);
  floatUp("♥", x, y, "#ff5c8a", dx, dy);
}

/** Cursor resting on the dog: it holds still to be stroked. */
function setHover(on: boolean) {
  if (on === hoverSince > 0) return;
  if (on) {
    hoverSince = performance.now();
    if (state === "idle" && mode === "walk") {
      freeze();
      setMode("stand");
      pettingPause = true;
    }
    return;
  }
  hoverSince = 0;
  if (pettingPause) {
    pettingPause = false;
    if (state === "idle" && !talking && mode === "stand") {
      planTimer = window.setTimeout(walk, 600);
    }
  }
}

/** Off to the hut for a nap or a bone, then back to roaming. */
function visit(kind?: "sleep" | "chew") {
  forcedAct = kind ?? null;
  visiting = true;
  if (state !== "idle" || talking) return;
  freeze();
  walk();
}

function scheduleVisit() {
  window.clearTimeout(visitTimer);
  visitTimer = window.setTimeout(
    () => {
      if (
        !parked &&
        !focusing &&
        state === "idle" &&
        !talking &&
        mode === "walk"
      ) {
        visit();
      }
      scheduleVisit();
    },
    360000 + Math.random() * 480000,
  );
}

/** A click on the bowl fills it; the dog comes running and eats. */
function feed() {
  if (wantFood) return;
  wantFood = true;
  drawBowl();
  hideBubble(false);
  if (state !== "idle") return;
  freeze();
  walk();
}

/** A click on the dog or its hut keeps it at home, the next one frees it. */
function togglePark() {
  parked = !parked;
  try {
    window.localStorage.setItem(PARK_KEY, parked ? "1" : "0");
  } catch {
    // Not remembered then.
  }
  hideBubble(false);
  if (state !== "idle") return;
  freeze();
  walk();
}

/** Focus on: home and sit still. Off: back to the usual life. */
function setFocusing(on: boolean) {
  if (on === focusing) return;
  focusing = on;
  visiting = false;
  forcedAct = null;
  hideBubble(false);
  if (state !== "idle") return;
  freeze();
  walk();
}

/** Time is up: the dog gets up once, then the quiet time is over. */
function focusDone() {
  if (state !== "idle" || mode === "walk" || mode === "sleep") {
    setFocusing(false);
    return;
  }
  window.clearTimeout(homeTimer);
  // Up on all fours (the side view), trotting on the spot for a moment.
  setMode("walk");
  window.setTimeout(() => {
    if (mode === "walk") setMode("stand");
    setFocusing(false);
  }, 1400);
}

/**
 * The window lets every click through. Only while the cursor is on the dog,
 * its hut or its bowl does it take clicks itself, so those can be clicked and
 * nothing else is ever blocked.
 */
function updateClickable() {
  let dogHit = false;
  let hit = false;
  if (cursor) {
    const [x, y] = cursor;
    const inside = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    dogHit = mode !== "sleep" && inside(botEl);
    hit =
      dogHit || inside(hutEl) || inside(bowlEl) || (focus?.hit(x, y) ?? false);
  }
  // In the app the cursor comes from the backend; in a browser from the DOM.
  if (setClickThrough) setHover(dogHit);
  if (hit === clickable) return;
  clickable = hit;
  setClickThrough?.(!hit);
}

function setLevel(value: number) {
  glow.setLevel(value);
  if (Number.isFinite(value)) level = Math.max(level, Math.min(1, value));
}

function fromBackend(value: string): BotState {
  if (value === "recording" || value === "streaming") return "listen";
  if (value === "transcribing" || value === "processing") return "think";
  return "idle";
}

window.addEventListener("resize", () => {
  hideBubble(false);
  if (mode === "walk") {
    freeze();
    setMode("stand");
    if (state === "idle") planTimer = window.setTimeout(walk, 300);
  } else {
    t = Math.min(t, edgeLength(edge));
    place(t, 0);
    if (needHome() && state === "idle") {
      planTimer = window.setTimeout(walk, 300);
    }
  }
});

botEl.addEventListener("click", togglePark);
hutEl.addEventListener("click", () => focus?.open());
bowlEl.addEventListener("click", feed);
botEl.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  toggleBreed();
});

async function start() {
  t = Math.random() * edgeLength(0);
  place(t, 0);
  setMode("stand");
  planTimer = window.setTimeout(walk, 800);
  scheduleSay(60000, 120000);
  scheduleVisit();
  drawHut();
  drawBowl();
  focus = initFocus({
    stage: stageEl,
    onActiveChange: setFocusing,
    onFinish: focusDone,
    onLayoutChange: updateClickable,
  });

  if ("__TAURI_INTERNALS__" in window) {
    const { listen, emit } = await import("@tauri-apps/api/event");
    reportBreed = (value) => {
      void emit("bot-breed-current", value);
    };
    reportBreed(breed);
    await listen<string>("bot-breed", (event) => {
      if (event.payload === "golden" || event.payload === "berner") {
        if (event.payload !== breed) setBreed(event.payload);
      }
    });
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

  // Browser preview: the DOM tells when the cursor is on the dog.
  botEl.addEventListener("mouseenter", () => setHover(true));
  botEl.addEventListener("mouseleave", () => setHover(false));

  // Buttons for the states and a made-up voice level.
  const api = {
    setState,
    setLevel,
    toggleBreed,
    say,
    visit,
    feed,
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
