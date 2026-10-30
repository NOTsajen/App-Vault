// Shelf backend. Runs on Netlify and keeps everything in Netlify Blobs (built in, no setup, no keys).
import { getStore } from "@netlify/blobs";

const store = (name) => getStore({ name, consistency: "strong" });
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const err = (m, s = 400) => json({ error: m }, s);
const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const UUID = /^[0-9a-f-]{36}$/;
const IMG = /^\/api\/img\/[0-9a-f-]{36}$/;
const total = (c) => c.reduce((a, b) => a + b, 0);
const avgOf = (c) => (total(c) ? Math.round((c.reduce((a, v, i) => a + v * (i + 1), 0) / total(c)) * 10) / 10 : 0);
const view = (a) => ({ ...a, n: total(a.cnt), avg: avgOf(a.cnt) });

// Simple per-visitor limits so nobody can flood the store.
async function limited(ip, kind, max) {
  const L = store("limits"), key = kind + ":" + String(ip).replace(/[^\w.:-]/g, "_"), now = Date.now();
  let r = await L.get(key, { type: "json" });
  if (!r || now - r.t > 3600e3) r = { t: now, c: 0 };
  if (r.c >= max) return true;
  r.c++;
  await L.setJSON(key, r);
  return false;
}

export default async (req, context) => {
  const parts = new URL(req.url).pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const m = req.method;
  const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "x";
  try {
    // ---- images ----
    if (parts[0] === "img") {
      if (m === "POST") {
        if (await limited(ip, "img", 40)) return err("Too many uploads. Try again later.", 429);
        const buf = await req.arrayBuffer(), b = new Uint8Array(buf);
        if (b.length < 100 || b.length > 1500000) return err("Image is too big.");
        if (!(b[0] === 0xff && b[1] === 0xd8)) return err("JPEG images only.");
        const id = crypto.randomUUID();
        await store("imgs").set(id, buf);
        return json({ url: "/api/img/" + id });
      }
      if (m === "GET" && UUID.test(parts[1] || "")) {
        const d = await store("imgs").get(parts[1], { type: "arrayBuffer" });
        if (!d) return err("Not found", 404);
        return new Response(d, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
      }
      return err("Not found", 404);
    }

    if (parts[0] !== "apps") return err("Not found", 404);
    const A = store("apps"), R = store("reviews");

    // ---- list / add ----
    if (!parts[1]) {
      if (m === "GET") {
        const { blobs } = await A.list();
        const all = (await Promise.all(blobs.map((b) => A.get(b.key, { type: "json" })))).filter(Boolean).map(view);
        all.sort((a, b) => b.created - a.created);
        return json({ apps: all.map((a) => ({ id: a.id, name: a.name, tagline: a.tagline, kind: a.kind, icon: a.icon, dev: a.dev, created: a.created, n: a.n, avg: a.avg })) });
      }
      if (m === "POST") {
        if (await limited(ip, "app", 6)) return err("Too many listings from you. Try again later.", 429);
        const b = await req.json().catch(() => ({}));
        const name = clip(b.name, 60), url = clip(b.url, 500);
        if (!name) return err("Add a name.");
        if (!/^https?:\/\/\S+$/i.test(url)) return err("The link must start with http:// or https://");
        const icon = IMG.test(b.icon || "") ? b.icon : null;
        const shots = (Array.isArray(b.shots) ? b.shots : []).filter((s) => IMG.test(s || "")).slice(0, 6);
        const a = {
          id: crypto.randomUUID(), name, url, icon, shots, created: Date.now(), cnt: [0, 0, 0, 0, 0],
          tagline: clip(b.tagline, 100) || null, description: clip(b.description, 2000) || null, dev: clip(b.dev, 40) || null,
          kind: ["app", "game", "website"].includes(b.kind) ? b.kind : "app"
        };
        await A.setJSON(a.id, a);
        return json({ id: a.id });
      }
      return err("Not found", 404);
    }

    const id = parts[1];
    if (!UUID.test(id)) return err("Not found", 404);

    // ---- one app ----
    if (!parts[2]) {
      if (m === "GET") {
        const a = await A.get(id, { type: "json" });
        if (!a) return err("Not found", 404);
        const { blobs } = await R.list({ prefix: "r:" + id + ":" });
        const rv = (await Promise.all(blobs.slice(0, 200).map((b) => R.get(b.key, { type: "json" })))).filter(Boolean);
        rv.sort((x, y) => y.at - x.at);
        return json({ app: view(a), reviews: rv.slice(0, 100).map((r) => ({ name: r.name, stars: r.stars, body: r.body, at: r.at })) });
      }
      if (m === "DELETE") {
        const key = process.env.ADMIN_KEY;
        if (!key || req.headers.get("x-admin-key") !== key) return err("Not allowed", 403);
        const a = await A.get(id, { type: "json" });
        if (a) for (const u of [a.icon, ...(a.shots || [])]) if (u && IMG.test(u)) await store("imgs").delete(u.split("/").pop());
        const { blobs } = await R.list({ prefix: "r:" + id + ":" });
        for (const b of blobs) await R.delete(b.key);
        await A.delete(id);
        return json({ ok: true });
      }
      return err("Not found", 404);
    }

    // ---- add a review ----
    if (parts[2] === "reviews" && m === "POST") {
      if (await limited(ip, "rev", 30)) return err("Too many reviews. Try again later.", 429);
      const b = await req.json().catch(() => ({}));
      const stars = Number(b.stars), device = String(b.device || "");
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) return err("Pick 1 to 5 stars.");
      if (!/^[\w-]{8,64}$/.test(device)) return err("Bad device id.");
      const a = await A.get(id, { type: "json" });
      if (!a) return err("Not found", 404);
      const key = "r:" + id + ":" + device;
      if (await R.get(key)) return err("You already reviewed this.", 409);
      await R.setJSON(key, { name: clip(b.name, 40) || null, stars, body: clip(b.body, 600) || null, at: Date.now() });
      a.cnt[stars - 1]++;
      await A.setJSON(id, a);
      return json({ ok: true });
    }
    return err("Not found", 404);
  } catch (e) {
    console.error(e);
    return err("Server error. Try again.", 500);
  }
};

export const config = { path: "/api/*" };
