const API = "https://room-player-sync.cydpixl7.workers.dev/api/rooms";
const CODE = /^[A-HJ-NP-Z2-9]{10}$/;
const $ = id => document.getElementById(id);
const video = $("video");
const player = $("player");
const seek = $("seek");
const clock = () => performance.now();

let roomCode = "";
let hostKey = "";
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
let uploading = false;
let autoplayBlocked = false;
let starting = false;
let gestureUntil = 0;

function status(id, text = "") {
  const element = $(id);
  element.hidden = !text;
  element.textContent = text;
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
  hostKey = localStorage.getItem("room-host-" + roomCode) || "";
  $("roomCode").textContent = code.slice(0, 5) + "-" + code.slice(5);
  $("uploads").hidden = !hostKey;
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
      const created = await request("", { method: "POST" });
      localStorage.setItem("room-host-" + created.code, created.hostKey);
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
  if (state.video?.id !== videoId) {
    videoId = state.video?.id;
    appliedJump = undefined;
    autoplayBlocked = false;
    gestureUntil = 0;
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

function render() {
  const loaded = Boolean(videoId);
  $("empty").hidden = loaded;
  $("emptyLabel").textContent = hostKey ? "Upload a film" : "Waiting for film";
  $("filename").textContent = state?.video?.name || "";
  $("captionFile").disabled = !loaded || uploading;
  $("filmFile").disabled = uploading;
  $("skipBack").disabled = !loaded || !connected;
  $("skipForward").disabled = !loaded || !connected;
  seek.disabled = !loaded || !connected || !Number.isFinite(video.duration);
  $("captions").disabled = !state?.caption || !connected;
  $("playToggle").disabled = !loaded || !connected;
  $("enablePlayback").hidden = !autoplayBlocked || !nowPlaying()?.playing;
  const playing = nowPlaying()?.playing && !video.ended && !autoplayBlocked;
  setIcon("playToggle", playing ? "pause" : "play", playing ? "Pause" : "Play");
  $("captions").setAttribute("aria-pressed", String(Boolean(state?.caption?.enabled)));
}

function reconcile() {
  clearTimeout(syncTimer);
  if (!connected || !videoId || offset === undefined || video.readyState < 1) return;
  const now = clock() + offset;
  const targetState = nowPlaying();
  const target = Math.min(video.duration, targetState.position + (targetState.playing ? Math.max(0, now - targetState.at) / 1000 : 0));
  const playing = targetState.playing && target < video.duration - 0.04;
  const boundary = state.playback.at - now;
  syncTimer = setTimeout(reconcile, boundary > 0 ? Math.min(160, Math.max(8, boundary)) : 160);
  if (video.seeking) return;
  const delta = target - video.currentTime;
  const jump = appliedJump !== targetState.jump;
  appliedJump = targetState.jump;
  if (!playing) {
    if (clock() < gestureUntil && !jump) return;
    if (!video.paused) video.pause();
    if (video.playbackRate !== 1) video.playbackRate = 1;
    if (Math.abs(delta) > 0.065) video.currentTime = target;
  } else {
    const drift = Math.abs(delta);
    if (jump || drift > 1.6 || (video.paused && drift > 0.17)) {
      if (drift > 0.06) video.currentTime = target;
      if (video.playbackRate !== 1) video.playbackRate = 1;
    } else if (video.readyState >= 3 && drift > 0.045) {
      video.playbackRate = 1 + Math.max(-0.045, Math.min(0.045, delta * 0.18));
    } else if (video.playbackRate !== 1) {
      video.playbackRate = 1;
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
  const playing = state.playback.playing && !video.ended;
  if (autoplayBlocked && playing) {
    autoplayBlocked = false;
    void startPlayback();
  } else if (playing) {
    act("pause");
  } else {
    autoplayBlocked = false;
    gestureUntil = clock() + 700;
    void startPlayback();
    act("play");
  }
}

function showTime(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(value / 60);
  const tail = String(value % 60).padStart(2, "0");
  return minutes < 60 ? minutes + ":" + tail : Math.floor(minutes / 60) + ":" + String(minutes % 60).padStart(2, "0") + ":" + tail;
}

function updateTime() {
  if (!scrubbing) seek.value = video.currentTime;
  $("elapsed").textContent = showTime(Number(seek.value));
  seek.setAttribute("aria-valuetext", showTime(Number(seek.value)));
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
$("enablePlayback").addEventListener("click", togglePlayback);
video.addEventListener("click", togglePlayback);
$("skipBack").addEventListener("click", () => act("skip", -10));
$("skipForward").addEventListener("click", () => act("skip", 10));
$("captions").addEventListener("click", () => act("captions"));
$("mute").addEventListener("click", () => { video.muted = !video.muted; });
video.addEventListener("volumechange", () => setIcon("mute", video.muted ? "muted" : "volume", video.muted ? "Unmute" : "Mute", video.muted));
seek.addEventListener("input", () => {
  scrubbing = true;
  updateTime();
});
seek.addEventListener("change", () => {
  act("seek", Number(seek.value));
  scrubbing = false;
});
seek.addEventListener("pointercancel", () => {
  scrubbing = false;
  updateTime();
});

function updateFullscreen() {
  const full = Boolean(document.fullscreenElement) || player.classList.contains("theater");
  setIcon("fullscreen", full ? "minimize" : "expand", full ? "Exit full screen" : "Full screen");
}
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

const authorized = () => ({ Authorization: "Bearer " + hostKey });

async function metadata(file) {
  const preview = document.createElement("video");
  const url = URL.createObjectURL(file);
  const signal = AbortSignal.timeout(12000);
  try {
    return await new Promise((resolve, reject) => {
      const unsupported = () => reject(new Error("Choose a browser-compatible MP4 or WebM film."));
      preview.onloadedmetadata = () => {
        if (Number.isFinite(preview.duration) && preview.duration > 0) resolve(preview.duration);
        else unsupported();
      };
      preview.onerror = unsupported;
      signal.addEventListener("abort", unsupported, { once: true });
      preview.preload = "metadata";
      preview.src = url;
    });
  } finally {
    preview.removeAttribute("src");
    preview.load();
    URL.revokeObjectURL(url);
  }
}

async function uploadPart(path, chunk) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request(path, { method: "PUT", headers: authorized(), body: chunk });
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
}

$("filmFile").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || uploading) return;
  uploading = true;
  render();
  let path;
  try {
    if (!/\.(mp4|webm)$/i.test(file.name) || file.size > 3 * 1024 ** 3) throw new Error("Choose an MP4 or WebM film under 3 GB.");
    status("roomMessage", "Checking film…");
    const duration = await metadata(file);
    const session = await request(roomPath("upload"), {
      method: "POST",
      headers: { ...authorized(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size, duration })
    });
    path = roomPath("upload/" + session.id);
    const parts = [];
    for (let i = 0; i < file.size; i += session.partSize) {
      const chunk = file.slice(i, i + session.partSize);
      status("roomMessage", "Uploading film… " + Math.floor(i / file.size * 100) + "%");
      parts.push(await uploadPart(path + "/" + (parts.length + 1), chunk));
    }
    status("roomMessage", "Finishing upload…");
    receiveState(await request(path + "/complete", {
      method: "POST",
      headers: { ...authorized(), "Content-Type": "application/json" },
      body: JSON.stringify({ parts })
    }));
    status("roomMessage");
  } catch (error) {
    if (path) await request(path, { method: "DELETE", headers: authorized() }).catch(() => {});
    status("roomMessage", error.message);
  } finally {
    uploading = false;
    render();
  }
});

$("captionFile").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !videoId || uploading) return;
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
      headers: { ...authorized(), "Content-Type": "text/vtt" },
      body: text
    }));
    status("roomMessage");
  } catch (error) {
    status("roomMessage", error.message);
  }
});

window.addEventListener("beforeunload", event => {
  if (uploading) event.preventDefault();
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
