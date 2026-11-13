// Focus timer for the dog. A click on the hut opens a large panel in the
// middle of the screen: pick a duration, start, music on or off. Collapsed it
// is a small pill above the hut that keeps counting down; hidden, only a thin
// progress strip on the hut's roof shows it is running. While a session runs
// the dog sits at home and stays quiet (see bot.ts).
//
// The music is a local file the app never ships: it plays
// <app data dir>/focus/focus.m4a through the asset protocol, and the switch is
// greyed out when the file is missing.

type View = "open" | "pill" | "hidden";

interface Saved {
  duration: number; // ms
  endAt: number | null; // epoch ms while running
  remaining: number | null; // ms while paused
  view: View;
  music: boolean;
  volume: number; // 0..1
  musicPos: number; // s
}

export interface FocusHooks {
  stage: HTMLElement;
  /** Session started (true) or ended (false): the dog goes home and sits. */
  onActiveChange: (active: boolean) => void;
  /** Timer ran out. */
  onFinish: () => void;
  /** Something clickable appeared or went away. */
  onLayoutChange: () => void;
}

export interface Focus {
  open: () => void;
  hit: (x: number, y: number) => boolean;
  active: () => boolean;
}

const KEY = "handy-bot-focus";
const MIN = 60000;
const PRESETS = [15, 25, 50, 90];
const MUSIC_PATH = "focus/focus.m4a";

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  music:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17.5V6l10-2v11.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6.5" cy="17.5" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/></svg>',
  musicOff:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17.5V6l10-2v11.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6.5" cy="17.5" r="2.5" fill="currentColor"/><circle cx="16.5" cy="15.5" r="2.5" fill="currentColor"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  collapse:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  hide: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function load(): Saved {
  const fallback: Saved = {
    duration: 25 * MIN,
    endAt: null,
    remaining: null,
    view: "pill",
    music: true,
    volume: 0.5,
    musicPos: 0,
  };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<Saved>) };
  } catch {
    return fallback;
  }
}

function format(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  html = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

export function initFocus(hooks: FocusHooks): Focus {
  const s = load();
  // A session that ran out while the app was closed is simply over.
  if (s.endAt !== null && s.endAt <= Date.now()) {
    s.endAt = null;
    s.remaining = null;
  }
  let panelOpen = false;
  let doneUntil = 0;
  let tickTimer: number | undefined;
  let saveTimer = 0;
  // "yes" in the app with the file there, "no" without it, "preview" in a browser.
  let musicState: "yes" | "no" | "preview" | "unknown" = "unknown";
  let fading = false;

  const save = () => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      // Not remembered then.
    }
  };

  const running = () => s.endAt !== null;
  const sessionOn = () => s.endAt !== null || s.remaining !== null;
  const left = () =>
    s.endAt !== null
      ? Math.max(0, s.endAt - Date.now())
      : (s.remaining ?? s.duration);

  // ---- DOM ----

  const backdrop = el("div", "focus-backdrop");
  const panel = el("div", "focus-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Fokus-Timer");
  panel.innerHTML = `
    <div class="focus-head">
      <span class="focus-title">Fokus</span>
      <button class="focus-icon focus-collapse" type="button" aria-label="Einklappen" title="Einklappen">${ICONS.collapse}</button>
    </div>
    <div class="focus-clock">
      <button class="focus-step" type="button" data-step="-5" aria-label="5 Minuten weniger">−5</button>
      <span class="focus-time">25:00</span>
      <button class="focus-step" type="button" data-step="5" aria-label="5 Minuten mehr">+5</button>
    </div>
    <div class="focus-presets">${PRESETS.map(
      (m) =>
        `<button class="focus-chip" type="button" data-min="${m}">${m} Min</button>`,
    ).join("")}</div>
    <div class="focus-music">
      <button class="focus-switch" type="button" role="switch" aria-checked="true">
        <span class="focus-switch-track"><span class="focus-switch-knob"></span></span>
        <span class="focus-switch-label">Musik</span>
      </button>
      <input class="focus-volume" type="range" min="0" max="100" step="1" aria-label="Lautstärke" />
    </div>
    <p class="focus-hint"></p>
    <button class="focus-start" type="button">Start</button>
    <button class="focus-reset" type="button">Zurücksetzen</button>
  `;

  const pill = el("div", "focus-pill");
  pill.innerHTML = `
    <button class="focus-pill-time" type="button" aria-label="Timer öffnen" title="Timer öffnen">
      <svg class="focus-ring" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" class="focus-ring-bg"/>
        <circle cx="12" cy="12" r="9.5" class="focus-ring-fg"/>
      </svg>
      <span class="focus-pill-label">25:00</span>
    </button>
    <button class="focus-icon focus-pill-play" type="button" aria-label="Pause" title="Pause"></button>
    <button class="focus-icon focus-pill-music" type="button" aria-label="Musik" title="Musik"></button>
    <button class="focus-icon focus-pill-hide" type="button" aria-label="Ausblenden" title="Ausblenden">${ICONS.hide}</button>
  `;

  const strip = el(
    "div",
    "focus-strip",
    '<span class="focus-strip-fill"></span>',
  );

  hooks.stage.append(backdrop, panel, pill, strip);

  const q = <T extends Element>(root: Element, sel: string) =>
    root.querySelector(sel) as T;
  const timeEl = q<HTMLElement>(panel, ".focus-time");
  const startBtn = q<HTMLButtonElement>(panel, ".focus-start");
  const resetBtn = q<HTMLButtonElement>(panel, ".focus-reset");
  const switchBtn = q<HTMLButtonElement>(panel, ".focus-switch");
  const volume = q<HTMLInputElement>(panel, ".focus-volume");
  const hint = q<HTMLElement>(panel, ".focus-hint");
  const chips = Array.from(
    panel.querySelectorAll<HTMLButtonElement>(".focus-chip"),
  );
  const steps = Array.from(
    panel.querySelectorAll<HTMLButtonElement>(".focus-step"),
  );
  const pillLabel = q<HTMLElement>(pill, ".focus-pill-label");
  const pillPlay = q<HTMLButtonElement>(pill, ".focus-pill-play");
  const pillMusic = q<HTMLButtonElement>(pill, ".focus-pill-music");
  const ring = q<SVGCircleElement>(pill, ".focus-ring-fg");
  const stripFill = q<HTMLElement>(strip, ".focus-strip-fill");
  const RING = 2 * Math.PI * 9.5;
  ring.style.strokeDasharray = `${RING}`;

  // ---- music ----

  const audio = new Audio();
  audio.loop = true;
  audio.preload = "metadata";
  audio.volume = s.volume;

  audio.addEventListener("loadedmetadata", () => {
    musicState = "yes";
    if (s.musicPos > 0 && s.musicPos < audio.duration)
      audio.currentTime = s.musicPos;
    syncMusic();
    render();
  });
  audio.addEventListener("error", () => {
    if (musicState === "preview") return;
    musicState = "no";
    render();
  });

  async function findMusic() {
    if (!("__TAURI_INTERNALS__" in window)) {
      musicState = "preview";
      render();
      return;
    }
    try {
      const { appDataDir, join } = await import("@tauri-apps/api/path");
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      audio.src = convertFileSrc(await join(await appDataDir(), MUSIC_PATH));
      audio.load();
    } catch {
      musicState = "no";
      render();
    }
  }

  function rememberPosition() {
    if (musicState !== "yes") return;
    s.musicPos = audio.currentTime;
    save();
  }

  /** Plays while a session runs with the music on, pauses otherwise. */
  function syncMusic() {
    if (musicState !== "yes" || fading) return;
    const want = running() && s.music;
    if (want && audio.paused) {
      audio.volume = s.volume;
      audio.play().catch(() => {
        // WebKit may refuse to start without a click, e.g. after a restart.
        // The switch stays on; the next click on play starts it.
      });
    } else if (!want && !audio.paused) {
      audio.pause();
      rememberPosition();
    }
  }

  function fadeOut() {
    if (musicState !== "yes" || audio.paused) return;
    fading = true;
    const from = audio.volume;
    const started = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - started) / 4000);
      audio.volume = from * (1 - k);
      if (k < 1) {
        window.setTimeout(step, 80);
        return;
      }
      audio.pause();
      audio.volume = s.volume;
      fading = false;
      rememberPosition();
    };
    step();
  }

  // ---- timer ----

  function setActive(before: boolean) {
    const now = sessionOn();
    if (before !== now) hooks.onActiveChange(now);
  }

  function start() {
    const before = sessionOn();
    s.endAt = Date.now() + (s.remaining ?? s.duration);
    s.remaining = null;
    save();
    setActive(before);
    loop();
    syncMusic();
    render();
  }

  function pause() {
    if (s.endAt === null) return;
    s.remaining = Math.max(0, s.endAt - Date.now());
    s.endAt = null;
    save();
    syncMusic();
    render();
  }

  function reset() {
    const before = sessionOn();
    s.endAt = null;
    s.remaining = null;
    save();
    syncMusic();
    setActive(before);
    render();
  }

  function finish() {
    s.endAt = null;
    s.remaining = null;
    save();
    fadeOut();
    doneUntil = Date.now() + 6000;
    window.setTimeout(render, 6100);
    // The bot ends its quiet time itself, after the dog got up once.
    hooks.onFinish();
    render();
  }

  function loop() {
    window.clearTimeout(tickTimer);
    if (!running()) return;
    if (left() <= 0) {
      finish();
      return;
    }
    render();
    if (++saveTimer % 20 === 0) rememberPosition();
    tickTimer = window.setTimeout(loop, 250);
  }

  function setDuration(ms: number) {
    const clamped = Math.min(240 * MIN, Math.max(MIN, ms));
    if (s.endAt !== null) {
      // Running: move the end, never below one more minute.
      const shift = clamped - s.duration;
      s.endAt = Math.max(Date.now() + MIN, s.endAt + shift);
    } else if (s.remaining !== null) {
      s.remaining = Math.max(MIN, s.remaining + clamped - s.duration);
    }
    s.duration = clamped;
    save();
    render();
  }

  // ---- views ----

  function openPanel() {
    panelOpen = true;
    render();
    hooks.onLayoutChange();
  }

  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    if (s.view === "open" || s.view === "hidden") s.view = "pill";
    save();
    render();
    hooks.onLayoutChange();
  }

  function render() {
    const ms = left();
    const on = sessionOn();
    const run = running();
    const done = Date.now() < doneUntil;
    const total = s.duration;
    const progress = on
      ? Math.min(1, Math.max(0, 1 - ms / total))
      : done
        ? 1
        : 0;

    backdrop.classList.toggle("show", panelOpen);
    panel.classList.toggle("show", panelOpen);
    pill.classList.toggle(
      "show",
      !panelOpen && ((on && s.view !== "hidden") || done),
    );
    strip.classList.toggle("show", !panelOpen && on && s.view === "hidden");

    timeEl.textContent = done && !on ? "Fertig" : format(ms);
    timeEl.classList.toggle("done", done && !on);
    startBtn.textContent = run ? "Pause" : on ? "Weiter" : "Start";
    startBtn.classList.toggle("running", run);
    resetBtn.disabled = !on;
    for (const chip of chips) {
      const m = Number(chip.dataset.min);
      chip.classList.toggle("selected", s.duration === m * MIN);
      chip.disabled = on;
    }

    const musicUsable = musicState === "yes" || musicState === "preview";
    switchBtn.setAttribute("aria-checked", String(s.music && musicUsable));
    switchBtn.disabled = !musicUsable;
    volume.disabled = !musicUsable || !s.music;
    volume.value = String(Math.round(s.volume * 100));
    hint.textContent =
      musicState === "no"
        ? "Musik-Datei fehlt: focus/focus.m4a im Handy-Datenordner."
        : musicState === "preview"
          ? "Vorschau: Musik spielt nur in der App."
          : "";
    hint.hidden = hint.textContent === "";

    pillLabel.textContent = done && !on ? "Fertig" : format(ms);
    pill.classList.toggle("done", done && !on);
    pillPlay.innerHTML = run ? ICONS.pause : ICONS.play;
    pillPlay.setAttribute("aria-label", run ? "Pause" : "Weiter");
    pillPlay.title = run ? "Pause" : "Weiter";
    pillPlay.hidden = !on;
    pillMusic.innerHTML = s.music && musicUsable ? ICONS.music : ICONS.musicOff;
    pillMusic.disabled = !musicUsable;
    pillMusic.hidden = !on;
    q<HTMLElement>(pill, ".focus-pill-hide").hidden = !on;
    ring.style.strokeDashoffset = `${RING * (1 - progress)}`;
    stripFill.style.transform = `scaleX(${progress})`;
  }

  // ---- events ----

  backdrop.addEventListener("click", closePanel);
  q<HTMLButtonElement>(panel, ".focus-collapse").addEventListener(
    "click",
    closePanel,
  );
  startBtn.addEventListener("click", () => (running() ? pause() : start()));
  resetBtn.addEventListener("click", reset);
  for (const chip of chips) {
    chip.addEventListener("click", () =>
      setDuration(Number(chip.dataset.min) * MIN),
    );
  }
  for (const step of steps) {
    step.addEventListener("click", () =>
      setDuration(s.duration + Number(step.dataset.step) * MIN),
    );
  }
  const toggleMusic = () => {
    s.music = !s.music;
    save();
    syncMusic();
    render();
  };
  switchBtn.addEventListener("click", toggleMusic);
  pillMusic.addEventListener("click", toggleMusic);
  volume.addEventListener("input", () => {
    s.volume = Number(volume.value) / 100;
    if (!fading) audio.volume = s.volume;
    save();
  });
  q<HTMLButtonElement>(pill, ".focus-pill-time").addEventListener(
    "click",
    () => {
      if (sessionOn()) openPanel();
    },
  );
  pillPlay.addEventListener("click", () => (running() ? pause() : start()));
  q<HTMLButtonElement>(pill, ".focus-pill-hide").addEventListener(
    "click",
    () => {
      s.view = "hidden";
      save();
      render();
      hooks.onLayoutChange();
    },
  );
  strip.addEventListener("click", openPanel);
  window.addEventListener("beforeunload", rememberPosition);

  render();
  void findMusic();
  if (sessionOn()) {
    hooks.onActiveChange(true);
    loop();
  }

  const inside = (node: HTMLElement, x: number, y: number) => {
    if (!node.classList.contains("show")) return false;
    const r = node.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  return {
    open: openPanel,
    // While the panel is open the whole window takes clicks: a click beside
    // it closes it, like any centre peek.
    hit: (x, y) => panelOpen || inside(pill, x, y) || inside(strip, x, y),
    active: sessionOn,
  };
}
