const SERVICE = "https://room-player-sync.cydpixl7.workers.dev/api";
const API = SERVICE + "/rooms";
const CODE = /^[A-HJ-NP-Z2-9]{10}$/;
const $ = id => document.getElementById(id);
const video = $("video");
const player = $("player");
const seek = $("seek");
const timeline = $("timeline");
const controls = $("controls");
const captionPanel = $("captionPanel");
const clock = () => performance.now();

let roomCode = "";
let state;
let socket;
let connected = false;
let syncTimer;
let pingTimer;
let samples = [];
let offset;
let videoId;
let captionId;
let track;
let appliedJump;
let reconnectTimer;
let reconnectDelay = 400;
let joined = false;
let joining = false;
let scrubbing = false;
let scrubPointer = null;
let uploadingCaption = false;
let autoplayBlocked = false;
let starting = false;
let warming = false;
let hasPlayed = false;
let prepared;
let prepareTimer;
let resyncSince;
let rateChangedAt = -Infinity;
let hideTimer;
const previewImages = new Map();
let previewSheet;
const hover = matchMedia("(hover: hover)");

function status(id, text = "") {
  const element = $(id);
  element.hidden = !text;
  if (element.textContent !== text) element.textContent = text;
}

function setIcon(id, symbol, label, pressed) {
  const element = $(id);
  element.querySelector("use").setAttribute("href", "#" + symbol);
  element.setAttribute("aria-label", label);
  element.title = label;
  if (pressed !== undefined) element.setAttribute("aria-pressed", String(pressed));
}

async function request(path = "", options = {}) {
  const response = await fetch(API + path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || "Connection failed. Try again.");
  return data;
}

const roomPath = route => "/" + roomCode + "/" + route;
const fileUrl = (type, id) => API + roomPath("media/" + type + "/" + id);

async function enter(code) {
  const info = await request("/" + code + "/info");
  roomCode = code;
  $("roomCode").textContent = code.slice(0, 5) + "-" + code.slice(5);
  $("lobby").hidden = true;
  $("room").hidden = false;
  const url = new URL(location.href);
  url.searchParams.set("room", code);
  history.replaceState(null, "", url);
  joined = true;
  receiveState(info);
  connect();
}

async function openRoom(create) {
  if (joining) return;
  const code = $("code").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!create && !CODE.test(code)) {
    status("lobbyMessage", "Enter a 10-character room code.");
    return;
  }
  joining = true;
  $("host").disabled = true;
  $("joinForm").querySelector("[type=submit]").disabled = true;
  status("lobbyMessage");
  try {
    if (create) {
      const created = await request("", { method: "POST", body: $("hostFilm").value });
      await enter(created.code);
    } else {
      await enter(code);
    }
  } catch (error) {
    status("lobbyMessage", error.message);
  } finally {
    joining = false;
    $("host").disabled = false;
    $("joinForm").querySelector("[type=submit]").disabled = false;
  }
}

async function loadFilmChoices() {
  try {
    const response = await fetch(SERVICE + "/films");
    if (!response.ok) return;
    const films = await response.json();
    if (films.length < 2) return;
    $("hostFilm").replaceChildren(...films.map(({ name, slug }) => new Option(name, slug)));
    $("filmChoice").hidden = false;
  } catch {
    // The lobby can still host Rise if the catalog request fails.
  }
}

$("joinForm").addEventListener("submit", event => {
  event.preventDefault();
  void openRoom(false);
});
$("host").addEventListener("click", () => void openRoom(true));
$("leave").addEventListener("click", () => { location.href = "./"; });
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    $("copy").title = "Copied";
    $("copy").setAttribute("aria-label", "Room code copied");
    window.setTimeout(() => {
      $("copy").title = "Copy room code";
      $("copy").setAttribute("aria-label", "Copy room code");
    }, 1500);
  } catch {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents($("roomCode"));
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

function connect() {
  if (!joined) return;
  const connection = new WebSocket((API + roomPath("socket")).replace(/^http/, "ws"));
  socket = connection;
  connection.addEventListener("open", () => {
    if (socket !== connection) return;
    connected = true;
    prepared = undefined;
    reconnectDelay = 400;
    samples = [];
    status("playerMessage");
    ping();
    for (const wait of [130, 290, 470, 700]) setTimeout(() => {
      if (socket === connection) ping();
    }, wait);
    pingTimer = setInterval(ping, 20_000);
    render();
  });
  connection.addEventListener("message", event => {
    if (socket !== connection) return;
    const message = JSON.parse(event.data);
    if (message.type === "state") receiveState(message.state);
    if (message.type === "clock") {
      const arrived = clock();
      samples.push({ latency: arrived - message.sent, offset: message.server - (message.sent + arrived) / 2 });
      samples = samples.slice(-6);
      offset = samples.reduce((best, sample) => sample.latency < best.latency ? sample : best).offset;
      reconcile();
    }
  });
  connection.addEventListener("close", async event => {
    if (socket !== connection || !joined) return;
    connected = false;
    clearInterval(pingTimer);
    clearInterval(prepareTimer);
    prepareTimer = undefined;
    video.pause();
    render();
    status("playerMessage", "Reconnecting…");
    if (event.code === 4004) {
      status("playerMessage", "Room expired.");
      return;
    }
    reconnectTimer = setTimeout(async () => {
      try {
        const response = await fetch(API + roomPath("info"));
        if (response.status === 404) {
          status("playerMessage", "Room expired.");
          return;
        }
      } catch {
        // The socket retries when the network returns.
      }
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(5000, reconnectDelay * 2);
  });
}

function ping() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "clock", sent: clock() }));
}

function act(type, position) {
  if (socket?.readyState === WebSocket.OPEN && videoId) {
    socket.send(JSON.stringify({ type, position, video: videoId }));
  }
}

function receiveState(next) {
  if (state && next.revision < state.revision) return;
  state = next;
  if (state.prepare && !prepareTimer) prepareTimer = setInterval(ping, 800);
  if (!state.prepare && prepareTimer) {
    clearInterval(prepareTimer);
    prepareTimer = undefined;
  }
  if (state.video?.id !== videoId) {
    videoId = state.video?.id;
    if (state.video?.width && state.video?.height) {
      player.style.setProperty("--film-aspect", state.video.width + " / " + state.video.height);
    }
    appliedJump = undefined;
    autoplayBlocked = false;
    video.pause();
    video.playbackRate = 1;
    if (videoId) {
      video.src = fileUrl("video", videoId);
    } else {
      video.removeAttribute("src");
    }
    video.load();
  }
  if (state.caption?.id !== captionId) {
    captionId = state.caption?.id;
    track?.remove();
    track = null;
    if (captionId) {
      track = document.createElement("track");
      track.kind = "captions";
      track.label = "Captions";
      track.src = fileUrl("caption", captionId);
      video.append(track);
    }
  }
  if (track) track.track.mode = state.caption.enabled ? "showing" : "disabled";
  render();
  reconcile();
}

function nowPlaying() {
  if (!state) return null;
  return offset !== undefined && clock() + offset < state.playback.at && state.previous ? state.previous : state.playback;
}

function atEnd() {
  return video.ended || (Number.isFinite(video.duration) && video.currentTime >= video.duration - 0.05);
}

function render() {
  const loaded = Boolean(videoId);
  $("empty").hidden = loaded;
  $("filename").textContent = state?.video?.name || "";
  $("captionPick").disabled = !loaded || uploadingCaption;
  $("skipBack").disabled = !loaded || !connected;
  $("skipForward").disabled = !loaded || !connected;
  seek.disabled = !loaded || !connected || !Number.isFinite(video.duration);
  $("captions").disabled = !loaded;
  $("captionToggle").hidden = !state?.caption;
  $("captionToggle").disabled = !connected;
  $("captionToggle").textContent = state?.caption?.enabled ? "Turn captions off" : "Turn captions on";
  $("playToggle").disabled = !loaded || !connected;
  const needsGesture = state?.prepare && !hasPlayed && !warming && video.readyState < 3;
  $("enablePlayback").hidden = !needsGesture && (!autoplayBlocked || !nowPlaying()?.playing);
  const playing = (state?.prepare || nowPlaying()?.playing) && !atEnd() && !autoplayBlocked;
  setIcon("playToggle", playing ? "pause" : "play", playing ? "Pause" : "Play");
  $("captions").classList.toggle("active", Boolean(state?.caption?.enabled));
  status("syncNotice", state?.prepare ? "Syncing…" : "");
}

function roomTime(at = clock() + offset) {
  const current = nowPlaying();
  if (!current) return video.currentTime;
  return Math.min(video.duration || state.video?.duration || Infinity, current.position +
    (current.playing && Number.isFinite(at) ? Math.max(0, at - current.at) / 1000 : 0));
}

function reconcile() {
  clearTimeout(syncTimer);
  if (!connected || !videoId || offset === undefined || video.readyState < 1) return;
  const now = clock() + offset;
  const targetState = nowPlaying();
  const target = roomTime(now);
  const playing = targetState.playing && target < video.duration;
  const boundary = state.playback.at - now;
  syncTimer = setTimeout(reconcile, boundary > 0 ? Math.min(90, Math.max(5, boundary)) : 90);
  if (video.seeking) return;
  const delta = target - video.currentTime;
  const jump = appliedJump !== targetState.jump;
  appliedJump = targetState.jump;
  if (!playing) {
    if (warming) return;
    if (!video.paused) video.pause();
    if (video.playbackRate !== 1) video.playbackRate = 1;
    rateChangedAt = -Infinity;
    if (Math.abs(delta) > 0.04) video.currentTime = target;
    else if (state.prepare && prepared !== state.prepare && video.readyState >= 3) {
      prepared = state.prepare;
      act("prepared", prepared);
    }
    resyncSince = undefined;
  } else {
    const drift = Math.abs(delta);
    if (jump || drift > 2.2 || (video.paused && drift > 0.30 && !autoplayBlocked)) {
      if (drift > 0.06) video.currentTime = target;
      if (video.playbackRate !== 1) video.playbackRate = 1;
      rateChangedAt = -Infinity;
    } else if (video.readyState >= 3 && now - rateChangedAt >= 1100) {
      const rate = video.playbackRate;
      let nextRate = rate;
      if (rate === 1 && drift > 0.085) {
        nextRate = 1 + Math.sign(delta) * (drift > 0.16 ? 0.14 : 0.06);
      } else if (rate !== 1 && (drift < 0.045 || Math.sign(delta) !== Math.sign(rate - 1))) {
        nextRate = 1;
      }
      if (rate !== nextRate) {
        video.playbackRate = nextRate;
        rateChangedAt = now;
      }
    }
    if (drift > 0.60 && !autoplayBlocked && now - targetState.at > 2800) {
      resyncSince ??= now;
      if (now - resyncSince > 1000) {
        resyncSince = now;
        act("resync");
      }
    } else {
      resyncSince = undefined;
    }
    if (video.paused && !autoplayBlocked) void startPlayback();
  }
  render();
  updateTime();
}

async function startPlayback() {
  if (starting) return;
  starting = true;
  try {
    await video.play();
    hasPlayed = true;
    autoplayBlocked = false;
  } catch (error) {
    if (error.name === "NotAllowedError") autoplayBlocked = true;
  } finally {
    starting = false;
    render();
  }
}

function togglePlayback() {
  if (!videoId || !connected) return;
  const playing = Boolean(state.prepare) || (state.playback.playing && !atEnd());
  if (autoplayBlocked && state.playback.playing) {
    autoplayBlocked = false;
    void startPlayback();
  } else if (playing) {
    act("pause");
  } else {
    autoplayBlocked = false;
    if (!hasPlayed && video.readyState < 3) void warmPlayback();
    act("play");
  }
}

async function warmPlayback() {
  if (warming) return;
  warming = true;
  try {
    await video.play();
    hasPlayed = true;
  } catch (error) {
    if (error.name === "NotAllowedError") autoplayBlocked = true;
  } finally {
    if (!nowPlaying()?.playing) video.pause();
    warming = false;
    reconcile();
  }
}

function showTime(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(value / 60);
  const tail = String(value % 60).padStart(2, "0");
  return minutes < 60 ? minutes + ":" + tail : Math.floor(minutes / 60) + ":" + String(minutes % 60).padStart(2, "0") + ":" + tail;
}

function updateTime() {
  if (!scrubbing) seek.value = roomTime();
  const seconds = Number(seek.value);
  const time = showTime(seconds);
  $("elapsed").textContent = time;
  seek.setAttribute("aria-valuetext", time);
  timeline.style.setProperty("--played", 100 * seconds / Number(seek.max) + "%");
  let buffered = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) - 0.25 <= seconds && seconds <= video.buffered.end(i)) buffered = video.buffered.end(i);
  }
  timeline.style.setProperty("--buffered", Math.min(100, 100 * buffered / Number(seek.max)) + "%");
}

video.addEventListener("loadedmetadata", () => {
  seek.max = Number.isFinite(video.duration) ? video.duration : 1;
  $("duration").textContent = showTime(seek.max);
  status("playerMessage");
  render();
  reconcile();
});
video.addEventListener("timeupdate", updateTime);
video.addEventListener("seeked", reconcile);
video.addEventListener("canplay", reconcile);
video.addEventListener("ended", render);
video.addEventListener("error", () => {
  if (videoId) status("playerMessage", "This film could not play. Try an H.264 MP4.");
});
$("playToggle").addEventListener("click", togglePlayback);
$("enablePlayback").addEventListener("click", () => {
  if (state?.prepare) void warmPlayback();
  else togglePlayback();
});
video.addEventListener("click", () => { if (!player.classList.contains("full")) togglePlayback(); });
$("skipBack").addEventListener("click", () => act("skip", -10));
$("skipForward").addEventListener("click", () => act("skip", 10));
$("captions").addEventListener("click", () => setCaptionPanel(captionPanel.hidden));
$("captionToggle").addEventListener("click", () => act("captions"));
$("captionPick").addEventListener("click", () => $("captionFile").click());
$("mute").addEventListener("click", () => { video.muted = !video.muted; });
video.addEventListener("volumechange", () => setIcon("mute", video.muted ? "muted" : "volume", video.muted ? "Unmute" : "Mute", video.muted));
seek.addEventListener("input", () => {
  scrubbing = true;
  updateTime();
  showSeekPreview(Number(seek.value));
});
seek.addEventListener("change", () => {
  act("seek", Number(seek.value));
  scrubbing = false;
});

function showSeekPreview(seconds) {
  const popup = $("seekPreview");
  const frame = $("previewFrame");
  const frameNumber = Math.min(Math.floor(seconds / 12), Math.ceil(state.video.duration / 12) - 1);
  const sheet = Math.floor(frameNumber / 80) + 1;
  const cell = frameNumber % 80;
  $("previewTime").textContent = showTime(seconds);
  popup.hidden = false;
  const half = popup.offsetWidth / 2;
  const x = seconds / Number(seek.max) * timeline.clientWidth;
  timeline.style.setProperty("--preview-x", Math.max(half, Math.min(timeline.clientWidth - half, x)) + "px");
  previewSheet = sheet;
  const url = fileUrl("preview", sheet);
  frame.style.backgroundPosition = 100 * (cell % 10) / 9 + "% " + 100 * Math.floor(cell / 10) / 7 + "%";
  if (!previewImages.has(sheet)) {
    const image = new Image();
    image.src = url;
    const entry = { loaded: false };
    previewImages.set(sheet, entry);
    image.decode().then(() => {
      entry.loaded = true;
      if (previewSheet === sheet) {
        frame.style.backgroundImage = 'url("' + url + '")';
        frame.hidden = false;
      }
    }).catch(() => previewImages.delete(sheet));
  }
  frame.hidden = !previewImages.get(sheet)?.loaded;
  if (!frame.hidden) frame.style.backgroundImage = 'url("' + url + '")';
}

function seekAtPointer(event) {
  const bounds = timeline.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
  const time = fraction * Number(seek.max);
  if (scrubbing) {
    seek.value = time;
    updateTime();
  }
  showSeekPreview(time);
}

function hideSeekPreview() {
  $("seekPreview").hidden = true;
}

seek.addEventListener("pointerdown", event => {
  if (event.button !== 0 || scrubPointer !== null) return;
  event.preventDefault();
  seek.focus({ preventScroll: true });
  seek.setPointerCapture(event.pointerId);
  scrubPointer = event.pointerId;
  scrubbing = true;
  seekAtPointer(event);
});
seek.addEventListener("pointermove", event => {
  if (!seek.disabled && (event.pointerType === "mouse" || event.pointerId === scrubPointer)) seekAtPointer(event);
});
seek.addEventListener("pointerup", event => {
  if (event.pointerId !== scrubPointer) return;
  seekAtPointer(event);
  act("seek", Number(seek.value));
  scrubPointer = null;
  scrubbing = false;
  if (event.pointerType !== "mouse") hideSeekPreview();
});
seek.addEventListener("lostpointercapture", () => {
  if (scrubPointer === null) return;
  scrubPointer = null;
  scrubbing = false;
  hideSeekPreview();
  updateTime();
});
seek.addEventListener("pointerleave", () => {
  if (scrubPointer === null) hideSeekPreview();
});
seek.addEventListener("blur", hideSeekPreview);

function wakeControls() {
  if (!player.classList.contains("full")) return;
  player.classList.add("controls-visible");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!(hover.matches && controls.matches(":hover")) && !controls.querySelector(":focus-visible") &&
        scrubPointer === null && captionPanel.hidden) {
      player.classList.remove("controls-visible");
    }
  }, 1650);
}

function updateFullscreen() {
  const full = Boolean(document.fullscreenElement) || player.classList.contains("theater");
  player.classList.toggle("full", full);
  if (full) wakeControls();
  else {
    clearTimeout(hideTimer);
    player.classList.remove("controls-visible");
  }
  setIcon("fullscreen", full ? "minimize" : "expand", full ? "Exit full screen" : "Full screen");
}
player.addEventListener("pointermove", wakeControls);
player.addEventListener("pointerdown", wakeControls);
controls.addEventListener("pointerleave", wakeControls);
controls.addEventListener("focusin", wakeControls);
controls.addEventListener("focusout", wakeControls);
$("fullscreen").addEventListener("click", async () => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else if (player.classList.contains("theater")) {
    player.classList.remove("theater");
  } else {
    try {
      if (!player.requestFullscreen) throw new Error("Fullscreen unavailable");
      await player.requestFullscreen();
    } catch {
      player.classList.add("theater");
    }
  }
  updateFullscreen();
});
document.addEventListener("fullscreenchange", updateFullscreen);
document.addEventListener("keydown", event => {
  if (!joined || event.altKey || event.ctrlKey || event.metaKey) return;
  wakeControls();
  if (event.key === "Escape" && !captionPanel.hidden) {
    event.preventDefault();
    setCaptionPanel(false);
    $("captions").focus();
    return;
  }
  if (event.key === "Escape" && player.classList.contains("theater")) {
    player.classList.remove("theater");
    updateFullscreen();
  }
  if (event.target.closest("button, a, input") || !connected || !videoId) return;
  if ([" ", "ArrowLeft", "ArrowRight"].includes(event.key)) event.preventDefault();
  if (event.key === " ") togglePlayback();
  if (event.key === "ArrowLeft") act("skip", -10);
  if (event.key === "ArrowRight") act("skip", 10);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && joined) {
    ping();
    reconcile();
  }
});

function setCaptionPanel(open) {
  captionPanel.hidden = !open;
  $("captions").setAttribute("aria-expanded", String(open));
  wakeControls();
}
document.addEventListener("pointerdown", event => {
  if (!captionPanel.hidden && !event.target.closest(".caption-control")) setCaptionPanel(false);
});

$("captionFile").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !videoId || uploadingCaption) return;
  uploadingCaption = true;
  render();
  status("captionStatus", "Uploading captions…");
  try {
    if (file.size > 1024 * 1024) throw new Error("Choose an SRT or VTT captions file under 1 MB.");
    let text = (await file.text()).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trimStart();
    if (/\.srt$/i.test(file.name)) {
      text = "WEBVTT\n\n" + text.replace(/^(\d{2}:\d{2}:\d{2}),(\d{3})(\s+-->\s+\d{2}:\d{2}:\d{2}),(\d{3})/gm, "$1.$2$3.$4");
    } else if (!/\.vtt$/i.test(file.name) || !/^WEBVTT(?:\s|$)/.test(text)) {
      throw new Error("Choose a valid SRT or VTT captions file.");
    }
    receiveState(await request(roomPath("caption/" + videoId), {
      method: "PUT",
      headers: { "Content-Type": "text/vtt" },
      body: text
    }));
    status("captionStatus", "Captions uploaded.");
  } catch (error) {
    status("captionStatus", error.message);
  } finally {
    uploadingCaption = false;
    render();
  }
});

window.addEventListener("pagehide", event => {
  if (event.persisted) return;
  joined = false;
  clearTimeout(reconnectTimer);
  socket?.close();
});
const initialCode = new URLSearchParams(location.search).get("room");
if (initialCode && CODE.test(initialCode)) {
  $("code").value = initialCode;
  void openRoom(false);
}
void loadFilmChoices();
