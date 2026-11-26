import { DurableObject } from "cloudflare:workers";

const PART = 24 * 1024 * 1024;
const MAX = 3 * 1024 ** 3;
const LIFETIME = 7 * 86400_000;
const CODE = /^[A-HJ-NP-Z2-9]{10}$/;
const TYPES = new Map([["mp4", "video/mp4"], ["webm", "video/webm"]]);
const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const fail = (error, status = 400) => json({ error }, status);
const position = (playback, at) => playback.position + (playback.playing ? Math.max(0, at - playback.at) / 1000 : 0);

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
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
        "Access-Control-Max-Age": "7200"
      } });
    } else if (pathname === "/api/rooms" && request.method === "POST") {
      const key = request.headers.get("CF-Connecting-IP") || "local";
      if (!(await env.CREATE_LIMIT.limit({ key })).success) {
        response = fail("Room limit reached. Try again in a minute.", 429);
      } else {
        for (let attempt = 0; attempt < 3; attempt++) {
          const code = roomCode();
          response = await env.ROOMS.getByName(code).fetch("https://room/init", { method: "POST", body: code });
          if (response.status !== 409) break;
        }
      }
    } else {
      const [, api, rooms, code, route] = pathname.split("/");
      if (api === "api" && rooms === "rooms" && CODE.test(code) &&
          ["info", "socket", "upload", "caption", "media"].includes(route)) {
        response = await env.ROOMS.getByName(code).fetch(request);
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
      this.pending = await ctx.storage.get("pending");
    });
  }

  snapshot() {
    const { code, video, caption, playback, previous, revision } = this.room;
    return { code, video, caption, playback, previous, revision };
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
      const code = await request.text();
      const now = Date.now();
      const hostKey = crypto.randomUUID() + crypto.randomUUID();
      this.room = {
        code, hostKey, until: now + LIFETIME, video: null, caption: null, revision: 0,
        playback: { at: now, position: 0, playing: false, jump: 0 }
      };
      await this.ctx.storage.put("room", this.room);
      await this.ctx.storage.setAlarm(this.room.until);
      return json({ code, hostKey }, 201);
    }
    if (!this.room || this.room.until <= Date.now()) return fail("Room not found or expired.", 404);
    const [, , , , route, id, sub] = url.pathname.split("/");
    if (route === "info" && method === "GET") return json(this.snapshot());
    if (route === "socket" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (this.ctx.getWebSockets().length >= 12) return fail("Room is full.", 429);
      const [client, socket] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(socket);
      socket.send(JSON.stringify({ type: "state", state: this.snapshot() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (route === "media" && ["GET", "HEAD"].includes(method)) {
      return this.media(request, id, sub);
    }
    if (request.headers.get("Authorization") !== "Bearer " + this.room.hostKey) {
      return fail("Only the host can upload.", 403);
    }
    try {
      if (route === "upload") return await this.upload(request, id, sub);
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
      return;
    }
    const { video, caption, playback, previous } = this.room;
    if (!video || message.video !== video.id) return;
    if (message.type === "captions" && caption) {
      caption.enabled = !caption.enabled;
      await this.save();
      return;
    }
    if (!["play", "pause", "seek", "skip"].includes(message.type)) return;
    if (["seek", "skip"].includes(message.type) && !Number.isFinite(message.position)) return;
    const active = previous && now < playback.at ? previous : playback;
    const at = now + 300;
    let target = position(playback, at);
    if (message.type === "seek") target = message.position;
    if (message.type === "skip") target += Math.max(-30, Math.min(30, message.position));
    const playing = message.type === "play" || (message.type !== "pause" && playback.playing);
    if (playing && message.type === "play" && target >= video.duration - 0.08) target = 0;
    target = Math.min(video.duration, Math.max(0, target));
    this.room.previous = active;
    this.room.playback = {
      at, position: target, playing: playing && target < video.duration,
      jump: playback.jump + (Math.abs(target - position(playback, at)) > 0.01 ? 1 : 0)
    };
    await this.save();
  }

  webSocketClose(socket, code) {
    if (code !== 1006) socket.close(code);
  }

  key(id, type) {
    return this.ctx.id.toString() + "/" + type + "/" + id;
  }

  async upload(request, id, sub) {
    const bucket = this.env.MEDIA;
    const method = request.method;
    if (!id && method === "POST") {
      if (this.starting || this.pending) return fail("An upload is already in progress.", 409);
      const data = await readJSON(request, 1024);
      if (!data) return fail("Invalid video details.");
      const type = TYPES.get(String(data.name).split(".").at(-1).toLowerCase());
      if (!type || !Number.isInteger(data.size) || data.size < 8 || data.size > MAX ||
          !Number.isFinite(data.duration) || data.duration <= 0 || data.duration > 86400) {
        return fail("Choose an MP4 or WebM video under 3 GB.");
      }
      if (this.starting || this.pending) return fail("An upload is already in progress.", 409);
      this.starting = true;
      try {
        const newId = crypto.randomUUID();
        const key = this.key(newId, "video");
        const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: type } });
        this.pending = {
          uploadId: upload.uploadId, id: newId, key, type, size: data.size, duration: data.duration,
          name: String(data.name).slice(0, 180)
        };
        await this.ctx.storage.put("pending", this.pending);
        return json({ id: newId, partSize: PART }, 201);
      } finally {
        this.starting = false;
      }
    }
    if (!this.pending || id !== this.pending.id) return fail("Upload session expired.", 404);
    const pending = this.pending;
    const upload = bucket.resumeMultipartUpload(pending.key, pending.uploadId);
    if (method === "DELETE" && !sub) {
      if (this.completing) return fail("Upload is finishing.", 409);
      await upload.abort();
      if (this.pending === pending) {
        this.pending = null;
        await this.ctx.storage.delete("pending");
      }
      return json({ ok: true });
    }
    if (method === "PUT" && /^\d+$/.test(sub || "")) {
      const part = Number(sub);
      const size = Math.min(PART, pending.size - (part - 1) * PART);
      if (part < 1 || size <= 0 || Number(request.headers.get("Content-Length")) !== size || !request.body) {
        return fail("Invalid upload part.");
      }
      return json(await upload.uploadPart(part, request.body));
    }
    if (method === "POST" && sub === "complete") {
      const data = await readJSON(request, 16384);
      if (!Array.isArray(data?.parts) || data.parts.length !== Math.ceil(pending.size / PART) ||
          data.parts.some((part, i) => part?.partNumber !== i + 1 || typeof part.etag !== "string")) {
        return fail("Upload is incomplete.");
      }
      if (this.completing || this.pending !== pending) return fail("Upload is finishing.", 409);
      this.completing = true;
      try {
        const object = await upload.complete(data.parts);
        if (object.size !== pending.size) {
          await bucket.delete(pending.key);
          throw new Error("Unexpected uploaded file size");
        }
        const { video, caption } = this.room;
        this.room.video = { id, size: pending.size, duration: pending.duration, type: pending.type, name: pending.name };
        this.room.caption = null;
        this.room.playback = { at: Date.now(), position: 0, playing: false, jump: 0 };
        this.room.previous = null;
        this.pending = null;
        await this.ctx.storage.delete("pending");
        await this.save();
        const oldKeys = [video && this.key(video.id, "video"), caption && this.key(caption.id, "caption")].filter(Boolean);
        if (oldKeys.length) this.ctx.waitUntil(bucket.delete(oldKeys));
        return json(this.snapshot());
      } finally {
        this.completing = false;
      }
    }
    return fail("Upload action unavailable.", 405);
  }

  async caption(request, videoId) {
    if (videoId !== this.room.video?.id) return fail("Choose a film first.");
    const text = await readText(request, 1024 * 1024);
    if (!text || !/^WEBVTT(?:[\t \r\n]|$)/.test(text)) return fail("Choose a valid SRT or VTT captions file.");
    const id = crypto.randomUUID();
    const key = this.key(id, "caption");
    await this.env.MEDIA.put(key, text);
    if (videoId !== this.room.video?.id) {
      this.ctx.waitUntil(this.env.MEDIA.delete(key));
      return fail("The film changed. Upload the captions again.", 409);
    }
    const old = this.room.caption;
    this.room.caption = { id, enabled: true, size: new TextEncoder().encode(text).length };
    await this.save();
    if (old) this.ctx.waitUntil(this.env.MEDIA.delete(this.key(old.id, "caption")));
    return json(this.snapshot());
  }

  async media(request, type, id) {
    const asset = type === "video" ? this.room.video : type === "caption" ? this.room.caption : null;
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
    const object = await this.env.MEDIA.get(this.key(id, type), range ? { range } : {});
    if (!object) return fail("File unavailable.", 404);
    headers.set("ETag", object.httpEtag);
    return new Response(object.body, { status: range ? 206 : 200, headers });
  }

  async alarm() {
    if (this.pending) {
      const { key, uploadId } = this.pending;
      await this.env.MEDIA.resumeMultipartUpload(key, uploadId).abort();
    }
    const prefix = this.ctx.id.toString() + "/";
    let cursor;
    do {
      const page = await this.env.MEDIA.list({ prefix, cursor });
      if (page.objects.length) await this.env.MEDIA.delete(page.objects.map(item => item.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    for (const socket of this.ctx.getWebSockets()) socket.close(4004, "Room expired");
    await this.ctx.storage.deleteAll();
    this.room = null;
    this.pending = null;
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

async function readJSON(request, limit) {
  try {
    return JSON.parse(await readText(request, limit));
  } catch {
    return null;
  }
}
