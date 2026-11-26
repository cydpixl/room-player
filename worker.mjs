import { DurableObject } from "cloudflare:workers";

const LIFETIME = 7 * 86400_000;
const CODE = /^[A-HJ-NP-Z2-9]{10}$/;
const RISE = {
  slug: "rise",
  id: "9392a7f4-5208-4620-a7fc-4388f25450b5",
  size: 1743148283,
  duration: 6296.540125,
  type: "video/mp4",
  width: 1920,
  height: 816,
  name: "Rise of the Planet of the Apes (2011)"
};
const DAWN_KEY = "films/dawn-2014-r1.mp4";
const DAWN_ID = "dawn-2014-r1";
const DAWN = {
  slug: "dawn", id: DAWN_ID, name: "Dawn of the Planet of the Apes (2014)",
  size: 2669627101, duration: 7824.277, type: "video/mp4", width: 1920, height: 1040
};
const previewNames = {
  rise: "rise-of-the-planet-of-the-apes",
  dawn: "dawn-of-the-planet-of-the-apes"
};
const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const fail = (error, status = 400) => json({ error }, status);
const position = (playback, at) => playback.position + (playback.playing ? Math.max(0, at - playback.at) / 1000 : 0);

async function findDawn(env) {
  const file = await env.MEDIA.head(DAWN_KEY);
  return file?.size === DAWN.size ? DAWN : null;
}

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), n => alphabet[n & 31]).join("");
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (origin && origin !== env.SITE_ORIGIN) return fail("Origin unavailable", 403);

    let response;
    if (request.method === "OPTIONS") {
      response = new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Range",
        "Access-Control-Max-Age": "7200"
      } });
    } else if (pathname === "/api/films" && request.method === "GET") {
      const films = [RISE, await findDawn(env)].filter(Boolean);
      response = json(films.map(({ slug, name }) => ({ slug, name })));
    } else if (pathname === "/api/rooms" && request.method === "POST") {
      const key = request.headers.get("CF-Connecting-IP") || "local";
      if (!(await env.CREATE_LIMIT.limit({ key })).success) {
        response = fail("Room limit reached. Try again in a minute.", 429);
      } else {
        const choice = request.body ? await readText(request, 32) : "";
        const video = choice === "" || choice === "rise" ? RISE : choice === "dawn" ? await findDawn(env) : null;
        response = fail("This film is unavailable.", 404);
        if (video) {
          for (let attempt = 0; attempt < 3; attempt++) {
            const code = roomCode();
            response = await env.ROOMS.getByName(code).fetch("https://room/init", {
              method: "POST", body: JSON.stringify({ code, video })
            });
            if (response.status !== 409) break;
          }
        }
      }
    } else {
      const [, api, rooms, code, route] = pathname.split("/");
      if (api === "api" && rooms === "rooms" && CODE.test(code) &&
          ["info", "socket", "caption", "media"].includes(route)) {
        const limited = route === "caption" && request.method === "PUT" &&
          !(await env.CAPTION_LIMIT.limit({ key: code })).success;
        response = limited ? fail("Too many caption uploads. Try again in a minute.", 429)
          : await env.ROOMS.getByName(code).fetch(request);
      } else {
        response = fail("Room not found.", 404);
      }
    }
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", env.SITE_ORIGIN);
    headers.set("Vary", "Origin");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range");
    return new Response(response.body, { status: response.status, headers });
  }
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.room = await ctx.storage.get("room");
      if (!this.room || [RISE.id, DAWN_ID].includes(this.room.video?.id)) return;
      this.room.video = RISE;
      this.room.caption = null;
      this.room.previous = null;
      this.room.playback = { at: Date.now(), position: 0, playing: false, jump: 0 };
      await this.save();
    });
  }

  get video() {
    return this.room.video?.id === DAWN_ID ? this.room.video : RISE;
  }

  snapshot() {
    const { code, caption, playback, previous, revision, pending } = this.room;
    return { code, video: this.video, caption, playback, previous, revision, prepare: pending?.id ?? null };
  }

  async save() {
    this.room.revision++;
    const message = JSON.stringify({ type: "state", state: this.snapshot() });
    await this.ctx.storage.put("room", this.room);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    if (url.pathname === "/init") {
      if (this.room) return fail("Code in use.", 409);
      const { code, video } = await request.json();
      const now = Date.now();
      this.room = {
        code, until: now + LIFETIME, video, caption: null, revision: 0,
        playback: { at: now, position: 0, playing: false, jump: 0 }
      };
      await this.ctx.storage.put("room", this.room);
      await this.ctx.storage.setAlarm(this.room.until);
      return json({ code }, 201);
    }
    if (!this.room || this.room.until <= Date.now()) return fail("Room not found or expired.", 404);
    const [, , , , route, id, sub] = url.pathname.split("/");
    if (route === "info" && method === "GET") return json(this.snapshot());
    if (route === "socket" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (this.ctx.getWebSockets().length >= 12) return fail("Room is full.", 429);
      const [client, socket] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(socket);
      socket.serializeAttachment({ id: crypto.randomUUID(), prepared: null });
      socket.send(JSON.stringify({ type: "state", state: this.snapshot() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (route === "media" && ["GET", "HEAD"].includes(method)) {
      return this.media(request, id, sub);
    }
    try {
      if (route === "caption" && method === "PUT") return await this.caption(request, id);
    } catch (error) {
      console.error("Room upload failed", error.message);
      return fail("Upload failed. Try again.", 503);
    }
    return fail("Action unavailable.", 405);
  }

  async webSocketMessage(socket, payload) {
    if (!this.room || this.room.until <= Date.now() || typeof payload !== "string" || payload.length > 512) return;
    let message;
    try { message = JSON.parse(payload); } catch { return; }
    if (!message || typeof message !== "object") return;
    const now = Date.now();
    if (message.type === "clock" && Number.isFinite(message.sent)) {
      socket.send(JSON.stringify({ type: "clock", sent: message.sent, server: now }));
      await this.resumeWhenReady(now);
      return;
    }
    const { caption, playback, previous } = this.room;
    const video = this.video;
    if (message.video !== video.id) return;
    if (message.type === "prepared" && this.room.pending?.id === message.position) {
      const attendee = socket.deserializeAttachment();
      if (attendee) {
        attendee.prepared = message.position;
        socket.serializeAttachment(attendee);
      }
      await this.resumeWhenReady(now);
      return;
    }
    if (message.type === "captions" && caption) {
      caption.enabled = !caption.enabled;
      await this.save();
      return;
    }
    if (!["play", "pause", "seek", "skip", "resync"].includes(message.type)) return;
    if (["seek", "skip"].includes(message.type) && !Number.isFinite(message.position)) return;
    const active = previous && now < playback.at ? previous : playback;
    const pending = this.room.pending;
    if (message.type === "resync" && (pending || !active.playing || now - active.at < 2800)) return;
    const at = message.type === "pause" && !pending ? now + 350 : now;
    let target = position(playback, at);
    if (message.type === "seek") target = message.position;
    if (message.type === "skip") target += Math.max(-30, Math.min(30, message.position));
    const playing = message.type === "play" || (message.type !== "pause" && (pending || playback.playing));
    if (playing && message.type === "play" && target >= video.duration - 0.08) target = 0;
    target = Math.min(video.duration, Math.max(0, target));
    const jump = playback.jump + (message.type === "pause" ? 0 : 1);
    this.room.previous = message.type === "pause" && !pending ? active : null;
    this.room.playback = { at, position: target, playing: false, jump };
    this.room.pending = playing && target < video.duration ? {
      id: this.room.revision + 1,
      deadline: now + 14000,
      attendees: this.ctx.getWebSockets().filter(client => client.readyState === WebSocket.OPEN).map(client => {
        let attendee = client.deserializeAttachment();
        if (!attendee) {
          attendee = { id: crypto.randomUUID(), prepared: null };
          client.serializeAttachment(attendee);
        }
        return attendee.id;
      })
    } : null;
    await this.save();
  }

  async resumeWhenReady(now, disconnected) {
    const pending = this.room?.pending;
    if (!pending) return;
    const attendees = this.ctx.getWebSockets()
      .filter(socket => socket !== disconnected && socket.readyState === WebSocket.OPEN)
      .map(socket => socket.deserializeAttachment())
      .filter(attendee => attendee && pending.attendees.includes(attendee.id));
    const allReady = attendees.length > 0 && attendees.every(attendee => attendee.prepared === pending.id);
    if (!allReady && attendees.length > 0 && now < pending.deadline) return;
    this.room.pending = null;
    if (allReady) {
      this.room.previous = this.room.playback;
      this.room.playback = { ...this.room.playback, at: now + 550, playing: true };
    }
    await this.save();
  }

  async webSocketClose(socket, code) {
    if (code !== 1006) socket.close(code);
    if (this.room?.until > Date.now()) await this.resumeWhenReady(Date.now(), socket);
  }

  key(id, type) {
    return this.ctx.id.toString() + "/" + type + "/" + id;
  }

  riseKey() {
    return this.env.ROOMS.idFromName(this.env.FILM_SOURCE_ROOM).toString() + "/video/" + RISE.id;
  }

  async caption(request, videoId) {
    if (videoId !== this.video.id) return fail("Film unavailable.", 404);
    const text = await readText(request, 1024 * 1024);
    if (!text || !/^WEBVTT(?:[\t \r\n]|$)/.test(text) ||
        !/^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}[ \t]+-->[ \t]+(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}/m.test(text)) {
      return fail("Choose an SRT or VTT file with timed captions.");
    }
    const id = crypto.randomUUID();
    const key = this.key(id, "caption");
    await this.env.MEDIA.put(key, text);
    const old = this.room.caption;
    this.room.caption = { id, enabled: true, size: new TextEncoder().encode(text).length };
    await this.save();
    if (old) this.ctx.waitUntil(this.env.MEDIA.delete(this.key(old.id, "caption")));
    return json(this.snapshot());
  }

  async media(request, type, id) {
    const film = this.video;
    if (type === "preview" && /^[1-9]\d?$/.test(id) && Number(id) <= Math.ceil(film.duration / 960)) {
      const key = "film-previews/" + previewNames[film.slug] + "-" + id + ".jpg";
      const isHead = request.method === "HEAD";
      const image = await (isHead ? this.env.MEDIA.head(key) : this.env.MEDIA.get(key));
      if (!image) return fail("Preview unavailable.", 404);
      return new Response(isHead ? null : image.body, { headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": image.size,
        "Cache-Control": "private, max-age=86400",
        ETag: image.httpEtag
      } });
    }
    const asset = type === "video" ? film : type === "caption" ? this.room.caption : null;
    if (!asset || id !== asset.id) return fail("File unavailable.", 404);
    const headers = new Headers({
      "Content-Type": type === "video" ? asset.type : "text/vtt; charset=utf-8",
      "Content-Length": asset.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600"
    });
    if (request.method === "HEAD") return new Response(null, { headers });
    let range;
    const value = request.headers.get("Range");
    if (value) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(value);
      if (match && (match[1] || match[2])) {
        const start = match[1] ? Number(match[1]) : Math.max(0, asset.size - Number(match[2]));
        const end = match[1] && match[2] ? Math.min(Number(match[2]), asset.size - 1) : asset.size - 1;
        if (start < asset.size && end >= start) {
          range = { offset: start, length: end - start + 1 };
          headers.set("Content-Range", "bytes " + start + "-" + end + "/" + asset.size);
          headers.set("Content-Length", range.length);
        }
      }
      if (!range) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + asset.size } });
    }
    const key = type === "video" ? (film.slug === "dawn" ? DAWN_KEY : this.riseKey()) : this.key(id, type);
    const object = await this.env.MEDIA.get(key, range ? { range } : {});
    if (!object) return fail("File unavailable.", 404);
    headers.set("ETag", object.httpEtag);
    return new Response(object.body, { status: range ? 206 : 200, headers });
  }

  async alarm() {
    const pending = await this.ctx.storage.get("pending");
    if (pending) {
      const { key, uploadId } = pending;
      await this.env.MEDIA.resumeMultipartUpload(key, uploadId).abort();
    }
    const prefix = this.ctx.id.toString() + "/";
    const filmKey = this.riseKey();
    let cursor;
    do {
      const page = await this.env.MEDIA.list({ prefix, cursor });
      const keys = page.objects.map(item => item.key).filter(key => key !== filmKey);
      if (keys.length) await this.env.MEDIA.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    for (const socket of this.ctx.getWebSockets()) socket.close(4004, "Room expired");
    await this.ctx.storage.deleteAll();
    this.room = null;
  }
}

async function readText(request, limit) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let count = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    count += value.byteLength;
    if (count > limit) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}
