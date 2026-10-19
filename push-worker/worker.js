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
//
// 資料（PDF・写真）の置き場所（任意）：R2 のバケットを「FILES」という名前でつなぐと、
//   /file/... で資料を出し入れできる（入れる・消すのは管理者、見るのはそのページの参加者と管理者）。
//   つないでいなければ、アプリは今までどおり Firestore に保存する。
//
// 自動リマインド（任意）：FIREBASE_SERVICE_ACCOUNT（シークレット）にサービスアカウントの JSON を入れ、
//   「トリガー → Cron」で 1時間ごと（0 * * * *）に動かす。APP_URL（任意）は通知を押したときに開く場所。

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
// ログインの証明書を確かめる（管理者かどうかは問わない）
async function verifyUser(token, env) {
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
  return claims;
}
const isAdminClaims = (claims, env) => String(env.ADMIN_EMAILS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).includes(String(claims.email || "").toLowerCase());
async function verifyIdToken(token, env) {
  const claims = await verifyUser(token, env);
  if (!isAdminClaims(claims, env)) throw new Error("管理者だけが送れます");
  return claims;
}
// そのページの参加者か（本人のログインで、自分の参加者データが読めるかを Firestore に聞く。結果は10分覚えておく）
const memberCache = new Map();
async function isPageMember(token, uid, page, env) {
  const k = `${uid}|${page}`;
  const hit = memberCache.get(k);
  if (hit && Date.now() - hit.at < 600e3) return hit.ok;
  const path = page === "root" ? `members/${uid}` : `profiles/${encodeURIComponent(page)}/members/${uid}`;
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const ok = res.ok;
  if (memberCache.size > 2000) memberCache.clear();
  memberCache.set(k, { ok, at: Date.now() });
  return ok;
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

// ---- 自動リマインド（1時間ごとの定期実行 / 管理者の「今すぐ確かめる」）
// 締切が近いアンケートに未回答の人・期限が近い集金で未入金（報告もまだ）の人に、通知を送る。
// Firestore はサービスアカウント（FIREBASE_SERVICE_ACCOUNT に JSON を丸ごと入れる）で読む。
// 設定はアプリの管理者画面から profiles/root の reminders に保存される：
//   { on, poll24, poll3, payEve, payDay }   … 締切の24時間前・3時間前／期限の前日20時・当日9時
// 送ったら、そのアンケート・集金に reminded.{h24|h3|eve|day} を書いて、二度送らない（送った枠は時刻、飛ばした枠は false）。
const JST = 9 * 3600e3;
const SLOT_LABEL = { h24: "締切まであと24時間です", h3: "締切まであと3時間です", eve: "期限は明日です", day: "期限は今日です" };

let gToken = { at: 0, token: null };
async function googleToken(env) {
  if (env.FIRESTORE_EMULATOR) return "owner"; // テスト用（Firestore エミュレータ）
  if (gToken.token && Date.now() - gToken.at < 50 * 60e3) return gToken.token;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (!sa.client_email || !sa.private_key) throw new Error("FIREBASE_SERVICE_ACCOUNT が設定されていません");
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", b64u.dec(pem.replace(/\+/g, "-").replace(/\//g, "_")), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = b64u.enc(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64u.enc(enc.encode(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })));
  const sig = b64u.enc(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`)));
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${head}.${body}.${sig}` });
  const j = await res.json();
  if (!j.access_token) throw new Error(`サービスアカウントでログインできませんでした（${j.error_description || j.error || res.status}）`);
  gToken = { at: Date.now(), token: j.access_token };
  return j.access_token;
}
const fsBase = (env) => `${env.FIRESTORE_EMULATOR || "https://firestore.googleapis.com"}/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
// Firestore の REST の値 ⇔ ふつうの値
function fromValue(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(fromValue);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, fromValue(x)]));
  return null;
}
const fromDoc = (d) => ({ id: d.name.split("/").pop(), _name: d.name, ...Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, fromValue(v)])) });
async function fsList(env, path) {
  const token = await googleToken(env);
  const out = [];
  let page = "";
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${fsBase(env)}/${path}?pageSize=300${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) return out;
    const j = await res.json();
    if (!res.ok) throw new Error(`Firestore を読めませんでした（${path}：${j.error?.message ?? res.status}）`);
    out.push(...(j.documents ?? []).map(fromDoc));
    if (!j.nextPageToken) break;
    page = j.nextPageToken;
  }
  return out;
}
async function fsGet(env, path) {
  const res = await fetch(`${fsBase(env)}/${path}`, { headers: { Authorization: `Bearer ${await googleToken(env)}` } });
  return res.ok ? fromDoc(await res.json()) : null;
}
// 1つの欄だけ書く（reminded.h24 など）
async function fsSetField(env, docName, fieldPath, value) {
  const parts = fieldPath.split(".");
  let fields = { [parts.at(-1)]: value };
  for (let i = parts.length - 2; i >= 0; i--) fields = { [parts[i]]: { mapValue: { fields } } };
  const res = await fetch(`${env.FIRESTORE_EMULATOR || "https://firestore.googleapis.com"}/v1/${docName}?updateMask.fieldPaths=${encodeURIComponent(fieldPath)}`, {
    method: "PATCH", headers: { Authorization: `Bearer ${await googleToken(env)}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Firestore に書けませんでした（${res.status}）`);
}
async function fsDelete(env, docName) {
  await fetch(`${env.FIRESTORE_EMULATOR || "https://firestore.googleapis.com"}/v1/${docName}`, { method: "DELETE", headers: { Authorization: `Bearer ${await googleToken(env)}` } }).catch(() => {});
}
const pagePath = (pid, coll) => (pid === "root" ? coll : `profiles/${pid}/${coll}`);
// "2027-03-01T18:00"（日本時間）→ ミリ秒
const jstMs = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(s ?? "")); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) - JST : NaN; };
const fmtJst = (ms) => { const d = new Date(ms + JST); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

// いまの時点で送る枠（まだ送っていない・作られたあとに来た枠のうち、締切にいちばん近いもの）。それより前の枠は「送った」扱いにする
function dueSlot(slots, now, createdAt, reminded) {
  const passed = slots.filter((s) => now >= s.at && now < s.until);
  if (!passed.length) return null;
  const last = passed.reduce((a, b) => (b.at > a.at ? b : a));
  if (reminded && last.key in reminded) return null;
  if (createdAt && last.at < createdAt - 60e3) return { skip: passed.map((s) => s.key) }; // 作った時点ですでに過ぎていた枠は送らない
  return { slot: last, mark: passed.map((s) => s.key) };
}

export async function runReminders(env, { dry = false, now = Date.now() } = {}) {
  const root = await fsGet(env, "profiles/root");
  const cfg = root?.reminders ?? {};
  if (!cfg.on && !dry) return { skipped: "自動リマインドがオフです" };
  const pages = (await fsList(env, "profiles")).map((p) => p.id);
  if (!pages.includes("root")) pages.unshift("root");
  const lobby = new Map((pages.includes("lobby") ? await fsList(env, "profiles/lobby/members") : []).map((m) => [m.id, m]));
  // 通知の宛先（全ページ分を集めて、同じ端末は1つに）
  const subs = [];
  for (const pid of pages) for (const d of await fsList(env, pagePath(pid, "pushSubs"))) if (d.sub?.endpoint) subs.push(d);
  subs.sort((a, b) => (b.at || 0) - (a.at || 0)); // 同じ端末が何か所にもあるときは、新しく置き直したほうを使う
  const subsOf = (uids) => { const want = new Set(uids); const seen = new Set(); return subs.filter((d) => want.has(d.uid) && !seen.has(d.sub.endpoint) && seen.add(d.sub.endpoint)); };
  const appUrl = env.APP_URL || `${env.ALLOWED_ORIGIN || "https://shashikata.github.io"}/from27trip-portal/`;
  const plan = [];
  for (const pid of pages) {
    const members = (await fsList(env, pagePath(pid, "members")))
      // 確定前ページに入っていて、この旅行がまだ確定していない人は、この旅行のページを開けないので送らない
      .filter((m) => pid === "lobby" || !lobby.has(m.id) || lobby.get(m.id).trips?.[pid] === true)
      .map((m) => m.id);
    if (!members.length) continue;
    const inPage = new Set(members);
    const targetsOf = (x) => (x.targets ? x.targets.filter((u) => inPage.has(u)) : members);
    if (cfg.poll24 !== false || cfg.poll3 !== false || dry) {
      const polls = (await fsList(env, pagePath(pid, "polls"))).filter((p) => p.open !== false && p.deadline && !p.noRemind);
      const votes = polls.length ? new Set((await fsList(env, pagePath(pid, "votes"))).map((v) => v.id)) : new Set();
      for (const p of polls) {
        const end = jstMs(p.deadline);
        const slots = [cfg.poll24 !== false && { key: "h24", at: end - 24 * 3600e3, until: end }, cfg.poll3 !== false && { key: "h3", at: end - 3 * 3600e3, until: end }].filter(Boolean);
        const due = dueSlot(slots, now, p.createdAt, p.reminded);
        if (!due) continue;
        const who = due.slot ? targetsOf(p).filter((u) => !votes.has(`${p.id}_${u}`)) : [];
        plan.push({ pid, kind: "poll", doc: p._name, title: `アンケート：${p.question}`, body: due.slot ? `${SLOT_LABEL[due.slot.key]}（${fmtJst(end)}締切）。まだ回答していません` : "", slot: due.slot?.key, mark: due.mark ?? due.skip, uids: who });
      }
    }
    if (cfg.payEve !== false || cfg.payDay !== false || dry) {
      const pays = (await fsList(env, pagePath(pid, "payments"))).filter((p) => p.due && !p.noRemind);
      const reports = pays.length ? new Set((await fsList(env, pagePath(pid, "payReports"))).map((r) => r.id)) : new Set();
      for (const p of pays) {
        const day = jstMs(p.due);
        const slots = [cfg.payEve !== false && { key: "eve", at: day - 4 * 3600e3, until: day + 24 * 3600e3 }, cfg.payDay !== false && { key: "day", at: day + 9 * 3600e3, until: day + 24 * 3600e3 }].filter(Boolean);
        const due = dueSlot(slots, now, p.createdAt, p.reminded);
        if (!due) continue;
        const status = (u) => p.records?.[u]?.status ?? "unpaid";
        const who = due.slot ? targetsOf(p).filter((u) => status(u) === "unpaid" && !reports.has(`${p.id}_${u}`)) : [];
        const amt = (u) => Number(p.records?.[u]?.amount ?? p.amount) || 0;
        plan.push({ pid, kind: "pay", doc: p._name, title: `集金：${p.title}`, body: due.slot ? `${SLOT_LABEL[due.slot.key]}（${p.due.replaceAll("-", "/")}）。まだ入金の報告がありません` : "", slot: due.slot?.key, mark: due.mark ?? due.skip, uids: who, amt });
      }
    }
  }
  const result = [];
  for (const x of plan) {
    const ss = subsOf(x.uids);
    const row = { page: x.pid, kind: x.kind, title: x.title, slot: x.slot ?? null, people: x.uids.length, devices: ss.length, sent: 0, gone: 0 };
    if (!dry) {
      if (x.slot && ss.length) {
        const payload = JSON.stringify({ title: x.title.slice(0, 120), body: x.body.slice(0, 400), url: appUrl, tag: `remind-${x.doc.split("/").pop()}` });
        const rs = await Promise.all(ss.map((d) => sendOne(d.sub, payload, env)));
        for (const [i, r] of rs.entries()) {
          if (r.status >= 200 && r.status < 300) row.sent++;
          else if (r.status === 404 || r.status === 410) { row.gone++; await fsDelete(env, ss[i]._name); }
        }
      }
      for (const k of x.mark) await fsSetField(env, x.doc, `reminded.${k}`, k === x.slot ? { timestampValue: new Date(now).toISOString() } : { booleanValue: false });
    }
    result.push(row);
  }
  const summary = { at: new Date(now).toISOString(), dry, items: result.filter((r) => r.slot) };
  if (!dry) await fsSetField(env, root?._name ?? `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/profiles/root`, "reminderLast", {
    mapValue: { fields: { at: { timestampValue: summary.at }, items: { integerValue: String(summary.items.length) }, sent: { integerValue: String(result.reduce((n, r) => n + r.sent, 0)) } } },
  }).catch(() => {});
  return summary;
}

function cors(env, res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN || "*");
  h.set("Access-Control-Allow-Headers", "authorization, content-type");
  h.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  h.set("Access-Control-Expose-Headers", "content-length");
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
    // このWorkerでできること（アプリが資料の置き場所を決めるのに使う）
    if (url.pathname === "/info") return cors(env, json({ push: !!env.VAPID_PUBLIC_KEY, files: !!env.FILES, remind: !!(env.FIREBASE_SERVICE_ACCOUNT || env.FIRESTORE_EMULATOR) }));
    // 資料：/file/{ページ}/{名前}
    if (url.pathname.startsWith("/file/")) {
      try {
        if (!env.FILES) return cors(env, json({ error: "資料の置き場所（R2）がつながっていません" }, 501));
        const key = decodeURIComponent(url.pathname.slice(6));
        const m = /^([A-Za-z0-9_-]{1,60})\/([A-Za-z0-9_-]{8,80})$/.exec(key);
        if (!m) return cors(env, json({ error: "資料の場所が正しくありません" }, 400));
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        const claims = await verifyUser(token, env);
        const admin = isAdminClaims(claims, env);
        if (request.method === "GET") {
          if (!admin && !(await isPageMember(token, claims.user_id || claims.sub, m[1], env))) return cors(env, json({ error: "このページの参加者だけが見られます" }, 403));
          const obj = await env.FILES.get(key);
          if (!obj) return cors(env, json({ error: "資料が見つかりません" }, 404));
          return cors(env, new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream", "Cache-Control": "private, max-age=86400" } }));
        }
        if (!admin) return cors(env, json({ error: "資料を入れたり消したりできるのは管理者だけです" }, 403));
        if (request.method === "PUT") {
          const type = request.headers.get("Content-Type") || "application/octet-stream";
          if (!/^(application\/pdf|image\/jpeg)$/.test(type)) return cors(env, json({ error: "PDF か写真だけ入れられます" }, 415));
          const size = Number(request.headers.get("Content-Length") || 0);
          if (size > 95 * 1048576) return cors(env, json({ error: "大きすぎます（95MB まで）" }, 413));
          await env.FILES.put(key, request.body, { httpMetadata: { contentType: type } });
          return cors(env, json({ ok: true, key }));
        }
        if (request.method === "DELETE") {
          await env.FILES.delete(key);
          return cors(env, json({ ok: true }));
        }
        return cors(env, json({ error: "使えない方法です" }, 405));
      } catch (e) {
        return cors(env, json({ error: String(e?.message ?? e) }, 401));
      }
    }
    // 自動リマインドを今すぐ（管理者）。dry なら送らずに、送る予定だけ返す
    if (url.pathname === "/remind" && request.method === "POST") {
      try {
        await verifyIdToken((request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""), env);
        const { dry = true } = await request.json().catch(() => ({}));
        return cors(env, json(await runReminders(env, { dry: !!dry })));
      } catch (e) {
        return cors(env, json({ error: String(e?.message ?? e) }, 400));
      }
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
  // 定期実行（Cloudflare の「トリガー → Cron」で 1時間ごとに）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env).catch((e) => console.error("remind", e)));
  },
};
