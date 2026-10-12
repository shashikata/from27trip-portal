import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, initializeAuth, inMemoryPersistence, connectAuthEmulator,
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, updatePassword, EmailAuthProvider, reauthenticateWithCredential,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  collection, doc, query, where, onSnapshot, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, APP_TITLE, EMAIL_DOMAIN, ADMIN_IDS, USE_EMULATOR } from "./config.js";

// ---------------------------------------------------------------- Firebase

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
// 一度受信したデータを端末に保存し、電波がなくても表示できるようにする
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
if (USE_EMULATOR) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// 参加者アカウント作成用。管理者のログイン状態を保ったまま別アカウントを作るため、別インスタンスを使う
let secondaryAuth = null;
function getSecondaryAuth() {
  if (!secondaryAuth) {
    const app2 = initializeApp(firebaseConfig, "account-creator");
    secondaryAuth = initializeAuth(app2, { persistence: inMemoryPersistence });
    if (USE_EMULATOR) connectAuthEmulator(secondaryAuth, "http://127.0.0.1:9099", { disableWarnings: true });
  }
  return secondaryAuth;
}

const idToEmail = (id) => (id.includes("@") ? id : `${id}@${EMAIL_DOMAIN}`).toLowerCase();
const emailToId = (email) => (email || "").replace(`@${EMAIL_DOMAIN}`, "");
const isAdminEmail = (email) => ADMIN_IDS.map(idToEmail).includes((email || "").toLowerCase());

// ---------------------------------------------------------------- 状態

const S = {
  authReady: false,
  user: null,
  isAdmin: false,
  me: undefined,             // members/{uid}（undefined = 読み込み中, null = 存在しない）
  config: { teamsPublished: false, title: APP_TITLE },
  members: new Map(),
  teams: new Map(),
  assignments: new Map(),
  annSrc: {},                // クエリごとのお知らせ（後で合成）
  logSrc: {},                // クエリごとのポイント履歴（後で合成）
  meta: {},                  // クエリごとの fromCache / hasPendingWrites
  subTeamId: null,
  tab: "home",
};

const subs = new Map();
if (USE_EMULATOR) window.__S = S; // テスト用

function listen(key, ref, onData) {
  if (subs.has(key)) return;
  const unsub = onSnapshot(
    ref,
    { includeMetadataChanges: true },
    (snap) => {
      S.meta[key] = { cache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites };
      onData(snap);
      scheduleRender();
    },
    (err) => {
      console.warn(`[${key}]`, err.code, err.message);
      onData(null, err);
      scheduleRender();
    },
  );
  subs.set(key, unsub);
}

function unlisten(key) {
  subs.get(key)?.();
  subs.delete(key);
  delete S.meta[key];
}

function unlistenAll() {
  for (const key of [...subs.keys()]) unlisten(key);
}

const toMap = (snap) => {
  const m = new Map();
  snap?.forEach((d) => m.set(d.id, { id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
  return m;
};

const merged = (src) => {
  const m = new Map();
  for (const part of Object.values(src)) for (const [k, v] of part) m.set(k, v);
  return [...m.values()];
};

// ---------------------------------------------------------------- データ購読

function startAdmin() {
  getDoc(doc(db, "config", "app"))
    .then((d) => { if (!d.exists()) return setDoc(doc(db, "config", "app"), { teamsPublished: false, title: APP_TITLE }); })
    .catch((e) => console.warn(e));
  listen("config", doc(db, "config", "app"), (s) => { if (s?.exists()) S.config = { ...S.config, ...s.data() }; });
  listen("members", collection(db, "members"), (s) => { S.members = toMap(s); });
  listen("teams", collection(db, "teams"), (s) => { S.teams = toMap(s); });
  listen("assignments", collection(db, "assignments"), (s) => { S.assignments = toMap(s); });
  listen("ann", collection(db, "announcements"), (s) => { S.annSrc.all = toMap(s); });
  listen("logs", collection(db, "pointLogs"), (s) => { S.logSrc.all = toMap(s); });
}

function startMember(uid) {
  listen("me", doc(db, "members", uid), (s, err) => {
    S.me = err ? null : (s.exists() ? s.data() : null);
    if (S.me) startMemberData(uid);
  });
}

function startMemberData(uid) {
  const ann = collection(db, "announcements");
  const logs = collection(db, "pointLogs");
  listen("config", doc(db, "config", "app"), (s) => {
    if (s?.exists()) S.config = { ...S.config, ...s.data() };
    refreshTeamListeners(uid);
  });
  listen("members", collection(db, "members"), (s) => { if (s) S.members = toMap(s); });
  // セキュリティルールは「フィルタ」ではないので、読める範囲に合わせてクエリを分ける
  listen("annAll", query(ann, where("scope", "==", "all")), (s) => { S.annSrc.all = toMap(s); });
  listen("annUser", query(ann, where("scope", "==", "user"), where("target", "==", uid)), (s) => { S.annSrc.user = toMap(s); });
  listen("logPublic", query(logs, where("visibility", "==", "public")), (s) => { S.logSrc.pub = toMap(s); });
  listen("logPrivate", query(logs, where("visibility", "==", "private"), where("target", "==", uid)), (s) => { S.logSrc.priv = toMap(s); });
}

function refreshTeamListeners(uid) {
  if (S.config.teamsPublished) {
    listen("teams", collection(db, "teams"), (s) => { S.teams = toMap(s); });
    listen("assignments", collection(db, "assignments"), (s) => {
      S.assignments = toMap(s);
      refreshTeamListeners(uid);
    });
  } else {
    unlisten("teams");
    unlisten("assignments");
    S.teams = new Map();
    S.assignments = new Map();
  }
  const teamId = S.config.teamsPublished ? S.assignments.get(uid)?.teamId ?? null : null;
  if (teamId === S.subTeamId) return;
  unlisten("annTeam");
  unlisten("logTeam");
  delete S.annSrc.team;
  delete S.logSrc.team;
  S.subTeamId = teamId;
  if (!teamId) return;
  listen("annTeam", query(collection(db, "announcements"), where("scope", "==", "team"), where("target", "==", teamId)),
    (s) => { S.annSrc.team = toMap(s); });
  listen("logTeam", query(collection(db, "pointLogs"), where("visibility", "==", "team"), where("teamId", "==", teamId)),
    (s) => { S.logSrc.team = toMap(s); });
}

onAuthStateChanged(auth, (user) => {
  unlistenAll();
  Object.assign(S, {
    authReady: true, user, isAdmin: !!user && isAdminEmail(user.email), me: undefined,
    config: { teamsPublished: false, title: APP_TITLE },
    members: new Map(), teams: new Map(), assignments: new Map(),
    annSrc: {}, logSrc: {}, meta: {}, subTeamId: null, tab: "home",
  });
  shell = null;
  currentView = null;
  if (user) (S.isAdmin ? startAdmin() : startMember(user.uid));
  scheduleRender();
});

window.addEventListener("online", () => scheduleRender());
window.addEventListener("offline", () => scheduleRender());

// ---------------------------------------------------------------- 部品

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "value") value = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (typeof v === "boolean") el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  if (value !== undefined) el.value = value;
  return el;
}

// SF Symbols 風の線アイコン（24×24、currentColor で着色）
const ICONS = {
  megaphone: '<path d="M4 10v4a1 1 0 0 0 1 1h2l5 4V5L7 9H5a1 1 0 0 0-1 1Z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14c2.4 0 4 1.5 4.5 4"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4ZM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  pin: '<path d="M9 4h6l-1 5 3 3H7l3-3-1-5ZM12 12v8"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  photo: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4"/>',
  shuffle: '<path d="M4 7h3.5c4.5 0 4.5 10 9 10H20M4 17h3.5c1.7 0 2.7-1.4 3.4-3M13.1 10c.7-1.6 1.7-3 3.4-3H20M17.5 4.5 20 7l-2.5 2.5M17.5 14.5 20 17l-2.5 2.5"/>',
  wifiOff: '<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.6M14.5 10.5A10 10 0 0 1 19 13M2 9.5a15 15 0 0 1 4-2.4M10 6.1a15 15 0 0 1 12 3.4"/><circle cx="12" cy="20" r=".8" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  xmark: '<path d="M7 7l10 10M17 7 7 17"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
};

function icon(name, cls = "") {
  const span = document.createElement("span");
  span.className = `icon ${cls}`;
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

const byNatural = (a, b) => String(a).localeCompare(String(b), "ja", { numeric: true });
const sortedMembers = () => [...S.members.entries()].map(([id, m]) => ({ id, ...m })).sort((a, b) => byNatural(a.loginId, b.loginId));
const sortedTeams = () => [...S.teams.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || byNatural(a.name, b.name));
const memberName = (uid) => S.members.get(uid)?.name ?? "（削除済み）";
const teamOf = (uid) => S.assignments.get(uid)?.teamId ?? null;
const ts = (x) => (x?.toMillis ? x.toMillis() : 0);
const fmtDate = (x) => {
  if (!x?.toDate) return "送信中…";
  const d = x.toDate();
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const sum = (logs) => logs.reduce((a, l) => a + (Number(l.delta) || 0), 0);

// iOS のシステムカラー
const TEAM_COLORS = [
  { value: "#FF3B30", label: "レッド" }, { value: "#007AFF", label: "ブルー" },
  { value: "#34C759", label: "グリーン" }, { value: "#FF9500", label: "オレンジ" },
  { value: "#AF52DE", label: "パープル" }, { value: "#30B0C7", label: "ティール" },
  { value: "#FF2D55", label: "ピンク" }, { value: "#5856D6", label: "インディゴ" },
];

const VIS_LABEL = { public: "全員に公開", team: "チーム内のみ", private: "本人のみ" };

const dot = (color) => h("span", { class: "dot", style: `--c:${color || "#8E8E93"}` });

function teamLabel(team) {
  if (!team) return h("span", { class: "secondary" }, "未所属");
  return h("span", { class: "team-label" }, dot(team.color), team.name);
}

function toast(msg, isError = false) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: `toast${isError ? " error" : ""}`, role: "status" }, msg);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2800);
}

function errMsg(e) {
  const map = {
    "auth/invalid-credential": "IDまたはパスワードが違います",
    "auth/wrong-password": "IDまたはパスワードが違います",
    "auth/user-not-found": "IDまたはパスワードが違います",
    "auth/invalid-email": "IDの形式が正しくありません",
    "auth/too-many-requests": "試行回数が多すぎます。しばらく待ってください",
    "auth/network-request-failed": "通信できません。電波を確認してください",
    "auth/email-already-in-use": "そのIDは既に使われています",
    "auth/weak-password": "パスワードは6文字以上にしてください",
    "auth/requires-recent-login": "安全のため、一度ログアウトして再ログインしてください",
    "permission-denied": "権限がありません",
  };
  return map[e?.code] || e?.message || String(e);
}

async function guard(btn, fn) {
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { console.error(e); toast(errMsg(e), true); } finally { if (btn) btn.disabled = false; }
}

// 書き込みは電波がないと完了を待ち続けるので、送信を待たずに「送信予約」として扱う
function fire(promise, okMsg) {
  const online = navigator.onLine;
  promise.then(() => { if (okMsg && online) toast(okMsg); }).catch((e) => { console.error(e); toast(errMsg(e), true); });
  if (!online) toast("オフラインです。電波が戻ったら自動で送信されます");
}

function fillSelect(sel, options, placeholder) {
  if (document.activeElement === sel) return; // 選択中のプルダウンを閉じさせない
  const cur = sel.value;
  sel.replaceChildren(
    ...(placeholder ? [h("option", { value: "" }, placeholder)] : []),
    ...options.map((o) => h("option", { value: o.value }, o.label)),
  );
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function randomPassword(len = 8) {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return [...buf].map((n) => chars[n % chars.length]).join("");
}

// 画像は Firestore の 1 ドキュメント 1MiB 制限に収まるよう、端末側で縮小・圧縮する
const MAX_IMAGE_BYTES = 180 * 1024;
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("画像を読み込めませんでした（HEIC の場合は JPEG で保存し直してください）"));
      i.src = url;
    });
    let maxSide = 1280;
    let quality = 0.8;
    for (let attempt = 0; attempt < 12; attempt++) {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL("image/jpeg", quality);
      if ((data.length - 23) * 0.75 <= MAX_IMAGE_BYTES) return data;
      if (quality > 0.5) quality -= 0.1;
      else maxSide = Math.round(maxSide * 0.8);
    }
    throw new Error("画像を十分に小さくできませんでした");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function openLightbox(src) {
  const box = h("div", { class: "lightbox", onclick: () => box.remove() }, h("img", { src, alt: "" }));
  document.body.append(box);
}

// 入力欄を含む一覧用。行を作り直さずに中身だけ更新するので、入力途中の文字が消えない
function keyedList(container, items, create, patch) {
  container._rows ??= new Map();
  const rows = container._rows;
  const alive = new Set();
  const order = items.map((item) => {
    alive.add(item.id);
    let row = rows.get(item.id);
    if (!row) { row = create(item); rows.set(item.id, row); }
    patch(row, item);
    return row.el;
  });
  for (const [id, row] of rows) if (!alive.has(id)) { row.el.remove(); rows.delete(id); }
  order.forEach((el, i) => { if (container.children[i] !== el) container.insertBefore(el, container.children[i] ?? null); });
}

// ユーザーが触った入力欄は、保存するまでサーバーの値で上書きしない
function editableInput(attrs = {}) {
  const el = h("input", { type: "text", ...attrs });
  el.addEventListener("input", () => { el.dataset.dirty = "1"; });
  el.sync = (v) => { if (!el.dataset.dirty && document.activeElement !== el) el.value = v; };
  el.saved = () => { delete el.dataset.dirty; };
  return el;
}

// iOS のセグメンテッドコントロール。value の読み書きと change イベントは <select> と同じ感覚で使える
function segmented(options, initial) {
  const el = h("div", { class: "seg", role: "tablist" });
  let value = initial ?? options[0]?.value;
  const paint = () => { for (const b of el.children) b.setAttribute("aria-selected", String(b.dataset.value === value)); };
  el.setOptions = (opts) => {
    el.replaceChildren(...opts.map((o) => h("button", {
      type: "button", role: "tab", "data-value": o.value,
      onclick: () => { if (value === o.value) return; value = o.value; paint(); el.dispatchEvent(new Event("change")); },
    }, o.label)));
    if (!opts.some((o) => o.value === value)) value = opts[0]?.value;
    paint();
  };
  Object.defineProperty(el, "value", { get: () => value, set: (v) => { value = v; paint(); } });
  el.setOptions(options);
  return el;
}

function toggle(checked = false) {
  return h("input", { type: "checkbox", class: "switch", role: "switch", checked });
}

// iOS の「インセットグループ」リスト
function group(header, body, footer) {
  return h("section", { class: "group" },
    header ? h("div", { class: "group-header" }, header) : null,
    h("div", { class: "group-body" }, body),
    footer ? h("div", { class: "group-footer" }, footer) : null,
  );
}

function cell(main, detail, { cls = "" } = {}) {
  return h("div", { class: `cell ${cls}` }, h("div", { class: "cell-main" }, main), detail != null ? h("div", { class: "cell-detail" }, detail) : null);
}

// 左にラベル、右に入力欄を置く行
function field(label, control) {
  return h("label", { class: "cell field" }, h("span", { class: "field-label" }, label), control);
}

function emptyState(iconName, title, text) {
  return h("div", { class: "empty" }, icon(iconName, "empty-icon"), h("div", { class: "empty-title" }, title), text ? h("div", { class: "empty-text" }, text) : null);
}

function largeTitle(text) {
  return h("h1", { class: "large-title" }, text);
}

function announcementCard(a, { admin = false } = {}) {
  let scope = "全員";
  if (a.scope === "team") scope = admin ? `${S.teams.get(a.target)?.name ?? "?"} のみ` : "チーム限定";
  if (a.scope === "user") scope = admin ? `${memberName(a.target)} のみ` : "あなた宛て";
  return h("article", { class: `card ann${a.pinned ? " pinned" : ""}` },
    h("div", { class: "ann-meta" },
      a.pinned ? h("span", { class: "ann-pin" }, icon("pin"), "固定") : null,
      h("span", { class: `ann-scope scope-${a.scope}` }, scope),
      h("span", null, fmtDate(a.createdAt)),
    ),
    h("h2", { class: "ann-title" }, a.title),
    a.body ? h("p", { class: "ann-body" }, a.body) : null,
    a.images?.length
      ? h("div", { class: `ann-images n${a.images.length}` }, a.images.map((src) => h("img", { src, alt: "", loading: "lazy", onclick: () => openLightbox(src) })))
      : null,
    admin ? h("div", { class: "ann-actions" },
      h("button", { class: "text-btn", onclick: () => fire(updateDoc(doc(db, "announcements", a.id), { pinned: !a.pinned })) }, a.pinned ? "固定を解除" : "固定"),
      h("button", { class: "text-btn destructive", onclick: () => { if (confirm(`「${a.title}」を削除しますか？`)) fire(deleteDoc(doc(db, "announcements", a.id)), "削除しました"); } }, "削除"),
    ) : null,
  );
}

const sortAnnouncements = (list) => list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || ts(b.createdAt) - ts(a.createdAt));

function logCell(l, { showTarget = true, admin = false } = {}) {
  const target = l.kind === "team" ? S.teams.get(l.target)?.name ?? "（チーム）" : memberName(l.target);
  return h("div", { class: "cell log" },
    h("div", { class: "cell-main" },
      h("div", null, showTarget ? h("span", { class: "log-target" }, target) : null, l.reason || "（理由なし）"),
      h("div", { class: "cell-sub" }, `${fmtDate(l.createdAt)} · ${VIS_LABEL[l.visibility]}`),
    ),
    h("div", { class: `delta ${l.delta >= 0 ? "plus" : "minus"}` }, signed(l.delta)),
    admin ? h("button", {
      class: "icon-btn", "aria-label": "取り消す", title: "取り消す",
      onclick: () => { if (confirm(`「${target} ${signed(l.delta)}（${l.reason || "理由なし"}）」を取り消しますか？`)) fire(deleteDoc(doc(db, "pointLogs", l.id)), "取り消しました"); },
    }, icon("xmark")) : null,
  );
}

function rankingCells(rows) {
  if (!rows.length) return cell(h("span", { class: "secondary" }, "まだありません"));
  rows.sort((a, b) => b.value - a.value);
  let rank = 0, prev = null;
  return rows.map((r, i) => {
    if (r.value !== prev) { rank = i + 1; prev = r.value; }
    return h("div", { class: `cell rank-cell${r.highlight ? " me" : ""}` },
      h("span", { class: `rank r${rank}` }, rank),
      h("div", { class: "cell-main" }, r.color ? dot(r.color) : null, r.label),
      h("div", { class: "rank-value" }, r.value, h("small", null, " pt")),
    );
  });
}

function statCard(label, total, parts, color) {
  return h("div", { class: "stat", style: color ? `--c:${color}` : null },
    h("div", { class: "stat-label" }, color ? dot(color) : null, label),
    h("div", { class: "stat-value" }, total, h("small", null, "pt")),
    h("div", { class: "stat-parts" }, parts.map(([k, v]) => h("div", null, h("div", { class: "stat-part-value" }, v), h("div", { class: "stat-part-label" }, k)))),
  );
}

// ---------------------------------------------------------------- 画面：ログイン

function loginView() {
  const id = h("input", { type: "text", autocomplete: "username", autocapitalize: "none", autocorrect: "off", spellcheck: "false", placeholder: "user01", required: true });
  const pw = h("input", { type: "password", autocomplete: "current-password", placeholder: "必須", required: true });
  const btn = h("button", { class: "btn-filled", type: "submit" }, "ログイン");
  return h("div", { class: "login" },
    h("img", { class: "app-icon", src: "icon-192.png", alt: "" }),
    h("h1", null, S.config.title || APP_TITLE),
    h("p", { class: "secondary" }, "配られたIDとパスワードでログインしてください。"),
    h("form", {
      onsubmit: (e) => {
        e.preventDefault();
        guard(btn, () => signInWithEmailAndPassword(auth, idToEmail(id.value.trim()), pw.value));
      },
    },
      h("div", { class: "group-body" }, field("ID", id), field("パスワード", pw)),
      btn,
    ),
  );
}

// ---------------------------------------------------------------- 画面：参加者

function memberHome() {
  const list = h("div", { class: "stack" });
  const el = h("div", null, largeTitle("お知らせ"), list);
  return {
    el,
    update() {
      const items = sortAnnouncements(merged(S.annSrc));
      list.replaceChildren(...(items.length
        ? items.map((a) => announcementCard(a))
        : [emptyState("megaphone", "お知らせはありません", "新しいお知らせが届くとここに表示されます。")]));
    },
  };
}

function memberTeam() {
  const body = h("div");
  const el = h("div", null, largeTitle("チーム"), body);
  return {
    el,
    update() {
      if (!S.config.teamsPublished) {
        body.replaceChildren(emptyState("lock", "チーム発表はまだです", "発表されるとここに表示されます。"));
        return;
      }
      const uid = S.user.uid;
      const myId = teamOf(uid);
      const membersOf = (tid) => sortedMembers().filter((m) => teamOf(m.id) === tid);
      const my = S.teams.get(myId);
      const teamGroup = (t, header) => group(header, membersOf(t.id).map((m) =>
        cell(m.name, m.id === uid ? h("span", { class: "tint" }, "あなた") : null)));
      body.replaceChildren(
        my
          ? h("div", { class: "hero", style: `--c:${my.color}` },
              h("div", { class: "hero-label" }, "あなたのチーム"),
              h("div", { class: "hero-title" }, my.name),
              h("div", { class: "hero-sub" }, `${membersOf(myId).length}人`))
          : emptyState("flag", "まだチームに入っていません"),
        ...sortedTeams().map((t) => teamGroup(t, h("span", { class: "team-label" }, dot(t.color), t.name))),
      );
    },
  };
}

function memberPoints() {
  const body = h("div");
  const rankSeg = segmented([{ value: "team", label: "チーム" }, { value: "user", label: "個人" }]);
  rankSeg.addEventListener("change", () => scheduleRender());
  const el = h("div", null, largeTitle("ポイント"), body);
  return {
    el,
    update() {
      const uid = S.user.uid;
      const logs = merged(S.logSrc).sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
      const mine = logs.filter((l) => l.kind === "user" && l.target === uid);
      const myTeamId = S.config.teamsPublished ? teamOf(uid) : null;
      const myTeam = S.teams.get(myTeamId);
      const teamLogs = myTeamId ? logs.filter((l) => l.kind === "team" && l.target === myTeamId) : [];
      const byVis = (arr, v) => sum(arr.filter((l) => l.visibility === v));

      const parts = [
        statCard("あなた", sum(mine), [["全員に公開", byVis(mine, "public")], ["チーム内", byVis(mine, "team")], ["本人のみ", byVis(mine, "private")]]),
      ];
      if (myTeam) {
        parts.push(statCard(myTeam.name, sum(teamLogs), [["全員に公開", byVis(teamLogs, "public")], ["チーム内のみ", byVis(teamLogs, "team")]], myTeam.color));
      }
      parts.push(group("あなたの履歴", mine.length ? mine.map((l) => logCell(l, { showTarget: false })) : cell(h("span", { class: "secondary" }, "まだありません"))));
      if (myTeam) {
        parts.push(group("チームの履歴", teamLogs.length ? teamLogs.map((l) => logCell(l, { showTarget: false })) : cell(h("span", { class: "secondary" }, "まだありません"))));
        parts.push(group("チームメンバー", rankingCells(sortedMembers().filter((m) => teamOf(m.id) === myTeamId).map((m) => ({
          label: m.name, value: sum(logs.filter((l) => l.kind === "user" && l.target === m.id)), highlight: m.id === uid,
        }))), "あなたに見える範囲のポイントで集計しています。"));
      }
      const pub = logs.filter((l) => l.visibility === "public");
      if (!S.config.teamsPublished && rankSeg.value === "team") rankSeg.value = "user";
      const rows = rankSeg.value === "team" && S.config.teamsPublished
        ? sortedTeams().map((t) => ({ label: t.name, color: t.color, value: sum(pub.filter((l) => l.kind === "team" && l.target === t.id)), highlight: t.id === myTeamId }))
        : sortedMembers().map((m) => ({ label: m.name, value: sum(pub.filter((l) => l.kind === "user" && l.target === m.id)), highlight: m.id === uid }));
      parts.push(h("div", { class: "group-header standalone" }, "ランキング"));
      if (S.config.teamsPublished) parts.push(h("div", { class: "seg-wrap" }, rankSeg));
      parts.push(group(null, rankingCells(rows), "「全員に公開」のポイントだけで集計しています。"));
      body.replaceChildren(...parts);
    },
  };
}

function settingsView() {
  const cur = h("input", { type: "password", autocomplete: "current-password", placeholder: "必須", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", minlength: "6", placeholder: "6文字以上", required: true });
  const btn = h("button", { class: "cell cell-button", type: "submit" }, "パスワードを変更");
  const adminBox = h("div");
  const el = h("div", null,
    largeTitle("設定"),
    group(null, [
      cell("ID", emailToId(S.user.email)),
      cell("名前", S.isAdmin ? "管理者" : S.me?.name ?? ""),
    ]),
    adminBox,
    h("form", {
      onsubmit: (e) => {
        e.preventDefault();
        guard(btn, async () => {
          await reauthenticateWithCredential(S.user, EmailAuthProvider.credential(S.user.email, cur.value));
          await updatePassword(S.user, next.value);
          cur.value = next.value = "";
          toast("パスワードを変更しました");
        });
      },
    }, group("パスワード", [field("現在", cur), field("新規", next), btn], "変更したパスワードは管理者にもわかりません。忘れないようにしてください。")),
    group(null, h("button", { class: "cell cell-button destructive", onclick: () => { if (confirm("ログアウトしますか？")) signOut(auth); } }, "ログアウト")),
  );
  let built = false;
  return {
    el,
    update() {
      if (!S.isAdmin || built) return;
      built = true;
      const titleInput = h("input", { type: "text", value: S.config.title ?? APP_TITLE });
      adminBox.replaceChildren(group("企画", [
        field("タイトル", titleInput),
        h("button", { class: "cell cell-button", onclick: () => fire(updateDoc(doc(db, "config", "app"), { title: titleInput.value.trim() || APP_TITLE }), "保存しました") }, "タイトルを保存"),
      ]));
    },
  };
}

// ---------------------------------------------------------------- 画面：管理者

function adminAnnouncements() {
  const title = h("input", { type: "text", maxlength: "100", placeholder: "タイトル", required: true, class: "plain title-input" });
  const body = h("textarea", { rows: "4", placeholder: "本文", class: "plain" });
  const scope = segmented([{ value: "all", label: "全員" }, { value: "team", label: "チーム" }, { value: "user", label: "個人" }]);
  const target = h("select");
  const targetCell = field("宛先", target);
  const pinned = toggle();
  const fileInput = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
  const preview = h("div", { class: "thumbs" });
  const images = [];
  const btn = h("button", { class: "btn-filled", type: "submit" }, "投稿");
  const list = h("div", { class: "stack" });

  const renderPreview = () => {
    preview.hidden = images.length === 0;
    preview.replaceChildren(...images.map((src, i) =>
      h("div", { class: "thumb" }, h("img", { src, alt: "" }),
        h("button", { type: "button", class: "thumb-x", "aria-label": "画像を外す", onclick: () => { images.splice(i, 1); renderPreview(); } }, icon("xmark")))));
  };
  renderPreview();

  const refreshTarget = () => {
    targetCell.hidden = scope.value === "all";
    if (scope.value === "team") fillSelect(target, sortedTeams().map((t) => ({ value: t.id, label: t.name })), "選択");
    if (scope.value === "user") fillSelect(target, sortedMembers().map((m) => ({ value: m.id, label: m.name })), "選択");
  };
  scope.addEventListener("change", () => { target.value = ""; refreshTarget(); });

  fileInput.addEventListener("change", () => guard(null, async () => {
    for (const f of fileInput.files) {
      if (images.length >= 3) { toast("画像は3枚までです", true); break; }
      images.push(await compressImage(f));
    }
    fileInput.value = "";
    renderPreview();
  }));

  const form = h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      if (scope.value !== "all" && !target.value) return toast("宛先を選んでください", true);
      fire(addDoc(collection(db, "announcements"), {
        title: title.value.trim(),
        body: body.value.trim(),
        scope: scope.value,
        target: scope.value === "all" ? null : target.value,
        images: [...images],
        pinned: pinned.checked,
        createdAt: serverTimestamp(),
        author: emailToId(S.user.email),
      }), "投稿しました");
      title.value = body.value = "";
      pinned.checked = false;
      images.length = 0;
      renderPreview();
    },
  },
    group("新規", [h("div", { class: "cell" }, title), h("div", { class: "cell" }, body), preview,
      h("label", { class: "cell cell-button" }, icon("photo"), "写真を追加", fileInput)], "写真は3枚まで。自動で縮小されます。"),
    group("公開範囲", [h("div", { class: "cell" }, scope), targetCell, field("一番上に固定", pinned)]),
    btn,
  );

  const el = h("div", null, largeTitle("お知らせ"), form, h("div", { class: "group-header standalone" }, "投稿済み"), list);
  return {
    el,
    update() {
      refreshTarget();
      const items = sortAnnouncements(merged(S.annSrc));
      list.replaceChildren(...(items.length ? items.map((a) => announcementCard(a, { admin: true })) : [emptyState("megaphone", "まだありません")]));
    },
  };
}

function adminMembers() {
  const id = h("input", { type: "text", placeholder: "user17", autocapitalize: "none", autocorrect: "off", pattern: "[a-z0-9_\\-]+", required: true });
  const name = h("input", { type: "text", placeholder: "たろう", required: true });
  const pw = h("input", { type: "text", placeholder: "空欄なら自動生成", minlength: "6", autocapitalize: "none" });
  const addBtn = h("button", { class: "cell cell-button", type: "submit" }, "追加");
  const prefix = h("input", { type: "text", value: "user", autocapitalize: "none", autocorrect: "off" });
  const from = h("input", { type: "number", value: "1", min: "1", inputmode: "numeric" });
  const to = h("input", { type: "number", value: "16", min: "1", inputmode: "numeric" });
  const bulkBtn = h("button", { class: "cell cell-button", type: "submit" }, "まとめて作成");
  const result = h("div");
  const listBody = h("div", { class: "group-body" });
  const listEmpty = emptyState("people", "まだ参加者がいません");
  const listGroup = h("section", { class: "group" }, h("div", { class: "group-header" }, "参加者"), listBody,
    h("div", { class: "group-footer" }, "名前を書き換えたら「保存」を押してください。"));
  const created = [];

  async function createAccount(loginId, displayName, password) {
    const a2 = getSecondaryAuth();
    const cred = await createUserWithEmailAndPassword(a2, idToEmail(loginId), password);
    await setDoc(doc(db, "members", cred.user.uid), { loginId, name: displayName, createdAt: serverTimestamp() });
    await signOut(a2);
    created.push({ loginId, name: displayName, password });
    renderResult();
  }

  function renderResult() {
    if (!created.length) return result.replaceChildren();
    const text = created.map((c) => `${c.name}\tID: ${c.loginId}\tパスワード: ${c.password}`).join("\n");
    result.replaceChildren(group("作成したアカウント", [
      ...created.map((c) => h("div", { class: "cell cred" },
        h("div", { class: "cell-main" }, c.name, h("div", { class: "cell-sub" }, c.loginId)),
        h("div", { class: "mono" }, c.password))),
      h("button", { class: "cell cell-button", onclick: () => navigator.clipboard.writeText(text).then(() => toast("コピーしました")) }, icon("copy"), "すべてコピー"),
      h("button", { class: "cell cell-button secondary-btn", onclick: () => { if (confirm("パスワードを保存しましたか？表示を消します。")) { created.length = 0; renderResult(); } } }, "表示を消す"),
    ], h("span", { class: "warn" }, "パスワードはこの画面でしか表示されません。必ずコピーして保存してください。")));
  }

  const el = h("div", null,
    largeTitle("参加者"),
    h("form", {
      onsubmit: (e) => {
        e.preventDefault();
        if (!navigator.onLine) return toast("アカウント作成は電波のある場所で行ってください", true);
        const a = Number(from.value), b = Number(to.value);
        const width = Math.max(2, String(b).length);
        const ids = [];
        for (let n = a; n <= b; n++) ids.push(`${prefix.value.trim().toLowerCase()}${String(n).padStart(width, "0")}`);
        const existing = new Set(sortedMembers().map((m) => m.loginId));
        const todo = ids.filter((x) => !existing.has(x));
        if (!todo.length) return toast("作成するアカウントはありません（全員作成済み）", true);
        if (!confirm(`${todo[0]} 〜 ${todo[todo.length - 1]} の ${todo.length} 人分を作成します。`)) return;
        guard(bulkBtn, async () => {
          for (const loginId of todo) await createAccount(loginId, loginId, randomPassword());
          toast(`${todo.length}人分を作成しました`);
        });
      },
    }, group("まとめて作成", [field("IDの頭", prefix), field("開始番号", from), field("終了番号", to), bulkBtn],
      "例：user・1・16 で user01〜user16 を作成します。名前はあとで変更できます。")),
    result,
    h("form", {
      onsubmit: (e) => {
        e.preventDefault();
        if (!navigator.onLine) return toast("アカウント作成は電波のある場所で行ってください", true);
        guard(addBtn, async () => {
          await createAccount(id.value.trim().toLowerCase(), name.value.trim(), pw.value || randomPassword());
          id.value = name.value = pw.value = "";
          toast("追加しました");
        });
      },
    }, group("1人ずつ追加", [field("ID", id), field("名前", name), field("パスワード", pw), addBtn])),
    listEmpty,
    listGroup,
  );

  return {
    el,
    update() {
      const ms = sortedMembers();
      listEmpty.hidden = ms.length > 0;
      listGroup.hidden = ms.length === 0;
      keyedList(listBody, ms, (m) => {
        const nm = editableInput({ class: "plain", "aria-label": `${m.loginId} の名前` });
        const team = h("span", { class: "cell-sub" });
        const el = h("div", { class: "cell member-row" },
          h("div", { class: "cell-main" }, nm, h("div", { class: "cell-sub" }, m.loginId, " · ", team)),
          h("button", {
            class: "text-btn",
            onclick: () => { fire(updateDoc(doc(db, "members", m.id), { name: nm.value.trim() || m.loginId }), "保存しました"); nm.saved(); },
          }, "保存"),
          h("button", {
            class: "text-btn destructive",
            onclick: () => {
              const cur = S.members.get(m.id);
              if (!confirm(`${cur?.name}（${m.loginId}）を削除しますか？\nこの人は何も見られなくなります。`)) return;
              const b = writeBatch(db);
              b.delete(doc(db, "members", m.id));
              b.delete(doc(db, "assignments", m.id));
              fire(b.commit(), "削除しました");
            },
          }, "削除"),
        );
        return { el, nm, team };
      }, (row, m) => {
        row.nm.sync(m.name);
        row.team.replaceChildren(teamLabel(S.teams.get(teamOf(m.id))));
      });
    },
  };
}

function adminTeams() {
  const name = h("input", { type: "text", placeholder: "Aチーム", required: true });
  const color = h("select", null, TEAM_COLORS.map((c) => h("option", { value: c.value }, c.label)));
  const colorDot = dot(TEAM_COLORS[0].value);
  color.addEventListener("change", () => colorDot.style.setProperty("--c", color.value));
  const publish = toggle();
  const publishFooter = h("span");
  const teamBody = h("div", { class: "group-body" });
  const assignBody = h("div", { class: "group-body" });
  const assignEmpty = emptyState("people", "まだ参加者がいません");

  publish.addEventListener("change", () => {
    const next = publish.checked;
    if (!confirm(next ? "チームを発表しますか？参加者全員に表示されます。" : "発表を取り消して、チームを非公開に戻しますか？")) {
      publish.checked = !next;
      return;
    }
    fire(updateDoc(doc(db, "config", "app"), { teamsPublished: next }), next ? "チームを発表しました" : "非公開に戻しました");
  });

  function randomAssign() {
    const teams = sortedTeams();
    const ms = sortedMembers();
    if (!teams.length || !ms.length) return toast("チームと参加者を先に作ってください", true);
    if (!confirm(`${ms.length}人を${teams.length}チームにランダムで振り分けます。今の振り分けは上書きされます。`)) return;
    const shuffled = [...ms];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const b = writeBatch(db);
    shuffled.forEach((m, i) => b.set(doc(db, "assignments", m.id), { teamId: teams[i % teams.length].id }));
    fire(b.commit(), "振り分けました");
  }

  const el = h("div", null,
    largeTitle("チーム"),
    group(null, field("参加者に発表", publish), publishFooter),
    h("form", {
      onsubmit: (e) => {
        e.preventDefault();
        fire(addDoc(collection(db, "teams"), { name: name.value.trim(), color: color.value, order: Date.now() }), "作成しました");
        name.value = "";
        color.selectedIndex = (color.selectedIndex + 1) % TEAM_COLORS.length;
        colorDot.style.setProperty("--c", color.value);
      },
    }, group("新しいチーム", [field("名前", name), field(h("span", { class: "team-label" }, colorDot, "色"), color),
      h("button", { class: "cell cell-button", type: "submit" }, "チームを作成")])),
    h("section", { class: "group" }, h("div", { class: "group-header" }, "チーム"), teamBody),
    h("div", { class: "group-header standalone with-action" }, "振り分け",
      h("button", { class: "text-btn", onclick: () => randomAssign() }, icon("shuffle"), "ランダム")),
    assignEmpty,
    h("section", { class: "group" }, assignBody),
  );

  return {
    el,
    update() {
      const published = !!S.config.teamsPublished;
      publish.checked = published;
      publishFooter.textContent = published
        ? "発表済みです。参加者は自分のチームと全チームの顔ぶれを見られます。"
        : "オフの間、参加者にはチームが一切見えません。振り分けが終わったらオンにしてください。";

      const teams = sortedTeams();
      const ms = sortedMembers();
      keyedList(teamBody, teams, (t) => {
        const nm = editableInput({ class: "plain", "aria-label": "チーム名" });
        const d = dot(t.color);
        const count = h("span", { class: "cell-sub" });
        const el = h("div", { class: "cell team-row" },
          d,
          h("div", { class: "cell-main" }, nm, count),
          h("button", {
            class: "text-btn",
            onclick: () => { fire(updateDoc(doc(db, "teams", t.id), { name: nm.value.trim() || t.name }), "保存しました"); nm.saved(); },
          }, "保存"),
          h("button", {
            class: "text-btn destructive",
            onclick: () => {
              const cur = S.teams.get(t.id);
              if (!confirm(`チーム「${cur?.name}」を削除しますか？所属メンバーは未所属になります。`)) return;
              const b = writeBatch(db);
              b.delete(doc(db, "teams", t.id));
              sortedMembers().filter((m) => teamOf(m.id) === t.id).forEach((m) => b.delete(doc(db, "assignments", m.id)));
              fire(b.commit(), "削除しました");
            },
          }, "削除"),
        );
        return { el, nm, d, count };
      }, (row, t) => {
        row.d.style.setProperty("--c", t.color);
        row.nm.sync(t.name);
        row.count.textContent = `${ms.filter((m) => teamOf(m.id) === t.id).length}人`;
      });
      teamBody.parentElement.hidden = teams.length === 0;

      assignEmpty.hidden = ms.length > 0;
      assignBody.parentElement.hidden = ms.length === 0;
      const teamOptions = teams.map((t) => ({ value: t.id, label: t.name }));
      keyedList(assignBody, ms, (m) => {
        const label = h("div", { class: "cell-main" });
        const sel = h("select", {
          class: "inline-select",
          "aria-label": "所属チーム",
          onchange: () => fire(sel.value
            ? setDoc(doc(db, "assignments", m.id), { teamId: sel.value })
            : deleteDoc(doc(db, "assignments", m.id))),
        });
        return { el: h("div", { class: "cell" }, label, sel), label, sel };
      }, (row, m) => {
        const t = S.teams.get(teamOf(m.id));
        row.label.replaceChildren(dot(t?.color), m.name);
        if (document.activeElement !== row.sel) {
          fillSelect(row.sel, teamOptions, "未所属");
          row.sel.value = teamOf(m.id) ?? "";
        }
      });
    },
  };
}

function adminPoints() {
  const kind = segmented([{ value: "team", label: "チーム" }, { value: "user", label: "個人" }]);
  const target = h("select", { "aria-label": "対象" });
  const delta = h("input", { type: "number", step: "any", value: "1", required: true, inputmode: "decimal", class: "delta-input" });
  const reason = h("input", { type: "text", maxlength: "200", placeholder: "ビーチフラッグ1位" });
  const visibility = segmented([]);
  const visFooter = h("span");
  const teamSummary = h("div", { class: "group-body" });
  const userSummary = h("div", { class: "group-body" });
  const list = h("div", { class: "group-body" });

  const VIS_HELP = {
    public: "全員のランキングに反映されます。",
    team: "そのチームのメンバーだけに見えます。",
    private: "本人だけに見えます。",
  };

  const refreshForm = () => {
    if (kind.value === "team") fillSelect(target, sortedTeams().map((t) => ({ value: t.id, label: t.name })), "選択");
    else fillSelect(target, sortedMembers().map((m) => ({ value: m.id, label: m.name })), "選択");
    visFooter.textContent = VIS_HELP[visibility.value] ?? "";
  };
  const refreshVis = () => {
    visibility.setOptions(kind.value === "team"
      ? [{ value: "public", label: "全員" }, { value: "team", label: "チーム内" }]
      : [{ value: "public", label: "全員" }, { value: "team", label: "チーム内" }, { value: "private", label: "本人のみ" }]);
  };
  refreshVis();
  kind.addEventListener("change", () => { target.value = ""; refreshVis(); refreshForm(); });
  visibility.addEventListener("change", refreshForm);

  const quick = h("div", { class: "quick" }, [1, 3, 5, 10, -1, -5].map((n) =>
    h("button", { type: "button", class: `pill${n < 0 ? " neg" : ""}`, onclick: () => { delta.value = n; } }, signed(n))));

  const form = h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      if (!target.value) return toast("対象を選んでください", true);
      const d = Number(delta.value);
      if (!Number.isFinite(d) || d === 0) return toast("0 以外の数値を入れてください", true);
      const teamId = kind.value === "team" ? target.value : teamOf(target.value);
      if (visibility.value === "team" && !teamId) return toast("この人はまだチームに入っていません", true);
      fire(addDoc(collection(db, "pointLogs"), {
        kind: kind.value,
        target: target.value,
        teamId: teamId ?? null,
        visibility: visibility.value,
        delta: d,
        reason: reason.value.trim(),
        createdAt: serverTimestamp(),
        author: emailToId(S.user.email),
      }), `${signed(d)} pt を付けました`);
      reason.value = "";
    },
  },
    group("対象", [h("div", { class: "cell" }, kind), field("名前", target)]),
    group("点数", [field("ポイント", delta), h("div", { class: "cell" }, quick), field("理由", reason)]),
    group("公開範囲", h("div", { class: "cell" }, visibility), visFooter),
    h("button", { class: "btn-filled", type: "submit" }, "ポイントを付ける"),
  );

  const el = h("div", null,
    largeTitle("ポイント"),
    form,
    h("section", { class: "group" }, h("div", { class: "group-header" }, "チーム集計"), teamSummary),
    h("section", { class: "group" }, h("div", { class: "group-header" }, "個人集計"), userSummary,
      h("div", { class: "group-footer" }, "集計は管理者にだけ表示されます。")),
    h("section", { class: "group" }, h("div", { class: "group-header" }, "履歴"), list),
  );

  const breakdown = (ls, keys) => keys.map((k) => `${{ public: "公開", team: "チーム内", private: "本人" }[k]} ${sum(ls.filter((l) => l.visibility === k))}`).join(" · ");

  return {
    el,
    update() {
      refreshForm();
      const logs = merged(S.logSrc).sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
      const teams = sortedTeams();
      teamSummary.replaceChildren(...(teams.length ? teams.map((t) => {
        const ls = logs.filter((l) => l.kind === "team" && l.target === t.id);
        return h("div", { class: "cell" },
          h("div", { class: "cell-main" }, h("span", { class: "team-label" }, dot(t.color), t.name), h("div", { class: "cell-sub" }, breakdown(ls, ["public", "team"]))),
          h("div", { class: "rank-value" }, sum(ls), h("small", null, " pt")));
      }) : [cell(h("span", { class: "secondary" }, "チームがありません"))]));
      const ms = sortedMembers();
      userSummary.replaceChildren(...(ms.length ? ms.map((m) => {
        const ls = logs.filter((l) => l.kind === "user" && l.target === m.id);
        return h("div", { class: "cell" },
          h("div", { class: "cell-main" }, m.name, h("div", { class: "cell-sub" }, breakdown(ls, ["public", "team", "private"]))),
          h("div", { class: "rank-value" }, sum(ls), h("small", null, " pt")));
      }) : [cell(h("span", { class: "secondary" }, "参加者がいません"))]));
      list.replaceChildren(...(logs.length
        ? logs.slice(0, 200).map((l) => logCell(l, { admin: true }))
        : [cell(h("span", { class: "secondary" }, "まだありません"))]));
    },
  };
}

// ---------------------------------------------------------------- 画面の組み立て

const MEMBER_TABS = [
  { key: "home", icon: "megaphone", label: "お知らせ", view: memberHome },
  { key: "team", icon: "flag", label: "チーム", view: memberTeam },
  { key: "points", icon: "trophy", label: "ポイント", view: memberPoints },
  { key: "settings", icon: "gear", label: "設定", view: settingsView },
];
const ADMIN_TABS = [
  { key: "home", icon: "megaphone", label: "お知らせ", view: adminAnnouncements },
  { key: "members", icon: "people", label: "参加者", view: adminMembers },
  { key: "team", icon: "flag", label: "チーム", view: adminTeams },
  { key: "points", icon: "trophy", label: "ポイント", view: adminPoints },
  { key: "settings", icon: "gear", label: "設定", view: settingsView },
];

let shell = null;
let currentView = null;
let renderQueued = false;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function buildShell(tabs) {
  const navTitle = h("div", { class: "nav-title" });
  const appName = h("div", { class: "app-name" });
  const status = h("div", { class: "status", hidden: true });
  const main = h("main");
  const nav = h("nav", { class: "tabbar" }, tabs.map((t) =>
    h("button", {
      "data-tab": t.key,
      onclick: () => {
        if (S.tab === t.key) return window.scrollTo({ top: 0, behavior: "smooth" });
        S.tab = t.key; currentView = null; scheduleRender(); window.scrollTo(0, 0);
      },
    }, icon(t.icon), h("span", null, t.label))));
  const header = h("header", { class: "navbar" }, navTitle, S.isAdmin ? h("span", { class: "badge" }, "管理者") : null);
  const root = h("div", { class: "shell" }, header, h("div", { class: "page" }, appName, status, main), nav);
  // 大きな見出しが隠れたら、ナビゲーションバーに小さい見出しを出す（iOS の Large Title と同じ動き）
  const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 44);
  window.addEventListener("scroll", onScroll, { passive: true });
  return { root, navTitle, appName, status, main, nav, tabs };
}

function render() {
  if (!S.authReady) return;
  if (!S.user) {
    shell = null;
    if (!document.querySelector(".login")) $app.replaceChildren(loginView());
    return;
  }
  if (!S.isAdmin) {
    if (S.me === undefined) return $app.replaceChildren(h("div", { class: "splash" }, h("div", { class: "spinner" })));
    if (S.me === null) {
      shell = null;
      return $app.replaceChildren(h("div", { class: "login" },
        emptyState("lock", "このアカウントは使えません", "管理者に確認してください。"),
        h("button", { class: "btn-filled", onclick: () => signOut(auth) }, "ログアウト")));
    }
  }
  const tabs = S.isAdmin ? ADMIN_TABS : MEMBER_TABS;
  if (!shell) {
    shell = buildShell(tabs);
    $app.replaceChildren(shell.root);
  }
  const title = S.config.title || APP_TITLE;
  shell.appName.textContent = title;
  document.title = title;

  const offline = !navigator.onLine || Object.values(S.meta).some((m) => m.cache);
  const pending = Object.values(S.meta).some((m) => m.pending);
  shell.status.hidden = !offline && !pending;
  shell.status.replaceChildren(
    icon(pending ? "clock" : "wifiOff"),
    pending ? "未送信の変更があります。電波が戻ると自動で送信されます。" : "オフライン — 最後に受信した内容を表示しています",
  );

  const tab = tabs.find((t) => t.key === S.tab) ?? tabs[0];
  shell.navTitle.textContent = tab.label;
  for (const b of shell.nav.children) {
    const active = b.dataset.tab === tab.key;
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  if (!currentView) {
    currentView = tab.view();
    shell.main.replaceChildren(currentView.el);
  }
  currentView.update();
}

const $app = document.getElementById("app");

if ("serviceWorker" in navigator && !USE_EMULATOR) {
  navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW", e));
}
