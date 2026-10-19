// 旅行ポータル：プッシュ通知の中継（Cloudflare Workers に貼り付けて使う）
//
// アプリ（管理者の画面）から「この人たちにこの通知を送って」と頼まれたら、
// Web Push の決まり（RFC 8291 の暗号化・RFC 8292 の VAPID）に沿って Apple / Google の配信サーバーへ送る。
//
// 設定する値（Cloudflare の「設定 → 変数とシークレット」）
//   VAPID_PUBLIC_KEY   … アプリの管理者設定「通知用の鍵を作る」で出た「公開鍵」
//   VAPID_PRIVATE_KEY  … 同じく「秘密鍵」（種類は「シークレット」にする）
//   VAPID_SUBJECT      … 連絡先。mailto:自分のメールアドレス
//   FIREBASE_PROJECT_ID… island2027spring
//   ADMIN_EMAILS       … 送ってよい管理者。カンマ区切り（admin1@island.example.com,admin2@island.example.com,…）
//   ALLOWED_ORIGIN     … アプリの場所（https://shashikata.github.io）
//
// 送れるのは、Firebase にログインしている管理者だけ（ログインの証明書を毎回確かめる）。

const enc = new TextEncoder();
const b64u = {
  enc(buf) {
    let s = "";
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    const s = atob(String(str).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(str).length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ---- 管理者のログインを確かめる（Firebase の ID トークン）
let jwksCache = { at: 0, keys: null };
async function googleKeys() {
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600e3) return jwksCache.keys;
  const res = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  if (!res.ok) throw new Error("鍵の取得に失敗しました");
  const { keys } = await res.json();
  jwksCache = { at: Date.now(), keys };
  return keys;
}
async function verifyIdToken(token, env) {
  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) throw new Error("ログイン情報がありません");
  const header = JSON.parse(new TextDecoder().decode(b64u.dec(h)));
  const claims = JSON.parse(new TextDecoder().decode(b64u.dec(p)));
  if (header.alg !== "RS256") throw new Error("ログイン情報の形式が違います");
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("ログイン情報の鍵が見つかりません");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u.dec(s), enc.encode(`${h}.${p}`));
  const now = Math.floor(Date.now() / 1000);
  const pid = env.FIREBASE_PROJECT_ID;
  if (!ok || claims.aud !== pid || claims.iss !== `https://securetoken.google.com/${pid}` || !(claims.exp > now) || !(claims.iat <= now + 300)) {
    throw new Error("ログイン情報が正しくありません（もう一度ログインしてください）");
  }
  const admins = String(env.ADMIN_EMAILS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!admins.includes(String(claims.email || "").toLowerCase())) throw new Error("管理者だけが送れます");
  return claims;
}

// ---- VAPID（送り主の証明）
async function vapidHeader(endpoint, env) {
  const pub = b64u.dec(env.VAPID_PUBLIC_KEY); // 65 バイト（0x04 + x + y）
  const jwk = { kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE_KEY, x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.enc(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || "mailto:admin@example.com" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u.enc(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// ---- 通知の中身を、受け取る端末の鍵で暗号化する（aes128gcm）
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}
export async function encryptPayload(sub, payload) {
  const uaPublic = b64u.dec(sub.keys.p256dh);
  const auth = b64u.dec(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(enc.encode(payload), new Uint8Array([2])); // 2 = 最後の記録の印
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

async function sendOne(sub, payload, env) {
  try {
    const body = await encryptPayload(sub, payload);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        TTL: "86400", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
        Authorization: await vapidHeader(sub.endpoint, env),
      },
      body,
    });
    return { endpoint: sub.endpoint, status: res.status };
  } catch (e) {
    return { endpoint: sub.endpoint, status: 0, error: String(e?.message ?? e) };
  }
}

function cors(env, res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN || "*");
  h.set("Access-Control-Allow-Headers", "authorization, content-type");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(env, new Response(null, { status: 204 }));
    const url = new URL(request.url);
    // 公開鍵（アプリが通知の受け取りを始めるときに使う）
    if (url.pathname === "/key") {
      if (!env.VAPID_PUBLIC_KEY) return cors(env, json({ error: "VAPID_PUBLIC_KEY が設定されていません" }, 500));
      return cors(env, json({ key: env.VAPID_PUBLIC_KEY }));
    }
    if (url.pathname === "/send" && request.method === "POST") {
      try {
        if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new Error("鍵が設定されていません");
        await verifyIdToken((request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""), env);
        const { subs = [], title = "", body = "", url: link = "", tag = "" } = await request.json();
        if (!Array.isArray(subs) || subs.length > 45) throw new Error("一度に送れるのは45件までです");
        const payload = JSON.stringify({ title: String(title).slice(0, 120), body: String(body).slice(0, 400), url: String(link).slice(0, 500), tag: String(tag).slice(0, 80) });
        const results = await Promise.all(subs.filter((s) => s?.endpoint && s?.keys?.p256dh && s?.keys?.auth).map((s) => sendOne(s, payload, env)));
        return cors(env, json({ results }));
      } catch (e) {
        return cors(env, json({ error: String(e?.message ?? e) }, 400));
      }
    }
    return cors(env, json({ ok: true, name: "trip-push" }));
  },
};
