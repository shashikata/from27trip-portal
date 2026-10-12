import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, initializeAuth, inMemoryPersistence, connectAuthEmulator,
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, updatePassword, EmailAuthProvider, reauthenticateWithCredential,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  collection, doc, query, where, onSnapshot, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
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
//
// データの形
//   teamSets/{setId}            { name, order, published }      チーム表（例：1日目の競技、料理班）
//   teams/{teamId}              { setId, name, color, order, published }
//   memberships/{teamId}_{uid}  { teamId, uid, setId, published } 誰がどのチームか
// published はチーム表を発表したときに、そのチーム表の teams / memberships にもまとめて書き込む。
// 参加者はセキュリティルールにより published == true のものしか読めない。

const S = {
  authReady: false,
  user: null,
  isAdmin: false,
  me: undefined,             // members/{uid}（undefined = 読み込み中, null = 存在しない）
  config: { title: APP_TITLE },
  members: new Map(),
  sets: new Map(),
  teams: new Map(),
  memberships: new Map(),
  memSrc: {},                // 参加者：所属のクエリごとの結果
  notes: new Map(),          // 表・メモ
  acks: new Map(),           // 「見ました」 acks/{annId}_{uid}（参加者は自分の分だけ）
  annSrc: {},                // クエリごとのお知らせ（後で合成）
  logSrc: {},                // クエリごとのポイント履歴（後で合成）
  meta: {},                  // クエリごとの fromCache / hasPendingWrites
  teamSubs: new Set(),       // 参加者：購読中の自チームID
  tab: "home",
  sheet: null,               // PC 版で開いている小窓 { key, title, view }
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
    .then((d) => { if (!d.exists()) return setDoc(doc(db, "config", "app"), { title: APP_TITLE }); })
    .then(migrateLegacyTeams)
    .catch((e) => console.warn(e));
  listen("config", doc(db, "config", "app"), (s) => { if (s?.exists()) S.config = { ...S.config, ...s.data() }; });
  listen("members", collection(db, "members"), (s) => { S.members = toMap(s); });
  listen("sets", collection(db, "teamSets"), (s) => { S.sets = toMap(s); });
  listen("teams", collection(db, "teams"), (s) => { S.teams = toMap(s); });
  listen("memberships", collection(db, "memberships"), (s) => { S.memberships = toMap(s); });
  listen("ann", collection(db, "announcements"), (s) => { S.annSrc.all = toMap(s); });
  listen("logs", collection(db, "pointLogs"), (s) => { S.logSrc.all = toMap(s); });
  listen("acks", collection(db, "acks"), (s) => { S.acks = toMap(s); });
  listen("notes", collection(db, "notes"), (s) => { S.notes = toMap(s); });
}

// 旧版（チーム表が1つだけ）で作ったチームと振り分けを「チーム表1」に移す
async function migrateLegacyTeams() {
  const [asg, teamsSnap, cfg] = await Promise.all([
    getDocs(collection(db, "assignments")),
    getDocs(collection(db, "teams")),
    getDoc(doc(db, "config", "app")),
  ]);
  const memSnap = await getDocs(collection(db, "memberships"));
  const noHidden = memSnap.docs.filter((d) => typeof d.data().hidden !== "boolean");
  if (noHidden.length) {
    const b0 = writeBatch(db);
    noHidden.forEach((d) => b0.update(d.ref, { hidden: false }));
    await b0.commit();
  }
  const legacy = teamsSnap.docs.filter((d) => !d.data().setId);
  if (!legacy.length && asg.empty) return;
  const published = !!cfg.data()?.teamsPublished;
  const setRef = doc(collection(db, "teamSets"));
  const legacyIds = new Set(legacy.map((d) => d.id));
  const b = writeBatch(db);
  if (legacy.length) b.set(setRef, { name: "チーム表1", order: Date.now(), published });
  legacy.forEach((t) => b.update(t.ref, { setId: setRef.id, published }));
  asg.forEach((a) => {
    const teamId = a.data().teamId;
    if (legacyIds.has(teamId)) b.set(doc(db, "memberships", `${teamId}_${a.id}`), { teamId, uid: a.id, setId: setRef.id, published, hidden: false });
    b.delete(a.ref);
  });
  await b.commit();
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
  const published = (name) => query(collection(db, name), where("published", "==", true));
  listen("config", doc(db, "config", "app"), (s) => { if (s?.exists()) S.config = { ...S.config, ...s.data() }; });
  listen("members", collection(db, "members"), (s) => { if (s) S.members = toMap(s); });
  // セキュリティルールは「フィルタ」ではないので、読める範囲に合わせてクエリを分ける
  listen("sets", published("teamSets"), (s) => { S.sets = toMap(s); });
  listen("teams", published("teams"), (s) => { S.teams = toMap(s); });
  const memRef = collection(db, "memberships");
  const memUpdate = () => { S.memberships = new Map([...(S.memSrc.vis ?? []), ...(S.memSrc.mine ?? [])]); refreshTeamListeners(uid); };
  listen("membershipsVisible", query(memRef, where("published", "==", true), where("hidden", "==", false)), (s) => { S.memSrc.vis = toMap(s); memUpdate(); });
  listen("membershipsMine", query(memRef, where("published", "==", true), where("uid", "==", uid)), (s) => { S.memSrc.mine = toMap(s); memUpdate(); });
  listen("acks", query(collection(db, "acks"), where("uid", "==", uid)), (s) => { if (s) S.acks = toMap(s); });
  listen("notes", query(collection(db, "notes"), where("shared", "==", true)), (s) => { if (s) S.notes = toMap(s); });
  listen("annAll", query(ann, where("scope", "==", "all")), (s) => { S.annSrc.all = toMap(s); });
  listen("annUser", query(ann, where("scope", "==", "user"), where("target", "==", uid)), (s) => { S.annSrc.user = toMap(s); });
  listen("logPublic", query(logs, where("visibility", "==", "public")), (s) => { S.logSrc.pub = toMap(s); });
  listen("logPrivate", query(logs, where("visibility", "==", "private"), where("target", "==", uid)), (s) => { S.logSrc.priv = toMap(s); });
}

// 自分が入っている（発表済みの）チームごとに、チーム宛てのお知らせとチーム内ポイントを購読する
function refreshTeamListeners(uid) {
  const now = new Set(myTeamIds(uid));
  for (const teamId of S.teamSubs) {
    if (now.has(teamId)) continue;
    unlisten(`annTeam:${teamId}`);
    unlisten(`logTeam:${teamId}`);
    delete S.annSrc[`team:${teamId}`];
    delete S.logSrc[`team:${teamId}`];
  }
  for (const teamId of now) {
    listen(`annTeam:${teamId}`, query(collection(db, "announcements"), where("scope", "==", "team"), where("target", "==", teamId)),
      (s) => { S.annSrc[`team:${teamId}`] = toMap(s); });
    listen(`logTeam:${teamId}`, query(collection(db, "pointLogs"), where("visibility", "==", "team"), where("teamId", "==", teamId)),
      (s) => { S.logSrc[`team:${teamId}`] = toMap(s); });
  }
  S.teamSubs = now;
}

onAuthStateChanged(auth, (user) => {
  unlistenAll();
  Object.assign(S, {
    authReady: true, user, isAdmin: !!user && isAdminEmail(user.email), me: undefined,
    config: { title: APP_TITLE },
    members: new Map(), sets: new Map(), teams: new Map(), memberships: new Map(), memSrc: {}, acks: new Map(), notes: new Map(),
    annSrc: {}, logSrc: {}, meta: {}, teamSubs: new Set(), tab: "home", sheet: null,
  });
  shell = null;
  if (user) (S.isAdmin ? startAdmin() : startMember(user.uid));
  scheduleRender();
});

window.addEventListener("online", () => scheduleRender());
window.addEventListener("offline", () => scheduleRender());

// ---------------------------------------------------------------- データの参照

// replaceChildren と同じだが、null / false は飛ばす（そのまま渡すと "null" という文字が出てしまう）
const setKids = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

const byNatural = (a, b) => String(a).localeCompare(String(b), "ja", { numeric: true });
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || byNatural(a.name, b.name);
const sortedMembers = () => [...S.members.entries()].map(([id, m]) => ({ id, ...m })).sort((a, b) => byNatural(a.loginId, b.loginId));
const sortedSets = () => [...S.sets.values()].sort(byOrder);
const teamsInSet = (setId) => [...S.teams.values()].filter((t) => t.setId === setId).sort(byOrder);
const membershipsOf = (pred) => [...S.memberships.values()].filter(pred);
// 表向きの所属（スパイなら参加先のチーム）
const teamOfIn = (uid, setId) => membershipsOf((m) => m.uid === uid && m.setId === setId && !m.hidden)[0]?.teamId ?? null;
// スパイの本当のチーム（本人と管理者にしか届かない）
const trueTeamOf = (uid, setId) => membershipsOf((m) => m.uid === uid && m.setId === setId && m.hidden)[0]?.teamId ?? null;
const membersOfTeam = (teamId, { includeHidden = false } = {}) => {
  const uids = new Set(membershipsOf((m) => m.teamId === teamId && (includeHidden || !m.hidden)).map((m) => m.uid));
  return sortedMembers().filter((m) => uids.has(m.id));
};
const myTeamIds = (uid) => membershipsOf((m) => m.uid === uid && S.teams.has(m.teamId)).map((m) => m.teamId);
const memberName = (uid) => S.members.get(uid)?.name ?? "（削除済み）";
const teamName = (teamId) => {
  const t = S.teams.get(teamId);
  if (!t) return "（チーム）";
  const set = S.sets.get(t.setId);
  return set ? `${set.name}・${t.name}` : t.name;
};
const teamOptions = () => sortedSets().flatMap((s) => teamsInSet(s.id).map((t) => ({ value: t.id, label: t.name, group: s.name })));

const ts = (x) => (x?.toMillis ? x.toMillis() : 0);
const fmtDate = (x) => {
  if (!x?.toDate) return "送信中…";
  const d = x.toDate();
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const sum = (logs) => logs.reduce((a, l) => a + (Number(l.delta) || 0), 0);

// ---------------------------------------------------------------- チーム表の操作（管理者）

function setPublished(setId, published) {
  const b = writeBatch(db);
  b.update(doc(db, "teamSets", setId), { published });
  teamsInSet(setId).forEach((t) => b.update(doc(db, "teams", t.id), { published }));
  membershipsOf((m) => m.setId === setId).forEach((m) => b.update(doc(db, "memberships", m.id), { published }));
  return b.commit();
}

// 表向きの所属を変える（スパイの本当のチームと同じになったら、スパイは解除される）
function assignMember(uid, setId, teamId) {
  const b = writeBatch(db);
  membershipsOf((m) => m.uid === uid && m.setId === setId && !m.hidden && m.teamId !== teamId)
    .forEach((m) => b.delete(doc(db, "memberships", m.id)));
  if (teamId) {
    b.set(doc(db, "memberships", `${teamId}_${uid}`), { teamId, uid, setId, published: !!S.sets.get(setId)?.published, hidden: false });
  }
  return b.commit();
}

// スパイ登録：参加先（表向き）と本当のチームを同時に書く
function setSpy(uid, setId, coverTeamId, trueTeamId) {
  const published = !!S.sets.get(setId)?.published;
  const b = writeBatch(db);
  membershipsOf((m) => m.uid === uid && m.setId === setId && m.teamId !== coverTeamId)
    .forEach((m) => b.delete(doc(db, "memberships", m.id)));
  b.set(doc(db, "memberships", `${coverTeamId}_${uid}`), { teamId: coverTeamId, uid, setId, published, hidden: false });
  b.set(doc(db, "memberships", `${trueTeamId}_${uid}`), { teamId: trueTeamId, uid, setId, published, hidden: true });
  return b.commit();
}

function clearSpy(uid, setId) {
  const b = writeBatch(db);
  membershipsOf((m) => m.uid === uid && m.setId === setId && m.hidden).forEach((m) => b.delete(doc(db, "memberships", m.id)));
  return b.commit();
}

function deleteSet(setId) {
  const b = writeBatch(db);
  b.delete(doc(db, "teamSets", setId));
  teamsInSet(setId).forEach((t) => b.delete(doc(db, "teams", t.id)));
  membershipsOf((m) => m.setId === setId).forEach((m) => b.delete(doc(db, "memberships", m.id)));
  return b.commit();
}

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
  plus: '<path d="M12 5v14M5 12h14"/>',
  spy: '<path d="M3 11h18M6 11l1.5-5.5h9L18 11"/><circle cx="7.5" cy="16" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/><path d="M10 16h4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  note: '<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
  table: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 10h17M3.5 14.5h17M9.5 5v14M15 5v14"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  map: '<path d="M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2-6-2Z"/><path d="M9 4.5v13M15 6.5v13"/>',
  locate: '<circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22"/>',
  arrows: '<path d="M4 8h15l-3.5-3.5M20 16H5l3.5 3.5"/>',
};

function icon(name, cls = "") {
  const span = document.createElement("span");
  span.className = `icon ${cls}`;
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

// iOS のシステムカラー
const TEAM_COLORS = [
  { value: "#FF3B30", label: "レッド" }, { value: "#007AFF", label: "ブルー" },
  { value: "#34C759", label: "グリーン" }, { value: "#FF9500", label: "オレンジ" },
  { value: "#AF52DE", label: "パープル" }, { value: "#30B0C7", label: "ティール" },
  { value: "#FF2D55", label: "ピンク" }, { value: "#5856D6", label: "インディゴ" },
];

const VIS_LABEL = { public: "全員に公開", team: "チーム内のみ", private: "本人のみ" };

const dot = (color) => h("span", { class: "dot", style: `--c:${color || "#8E8E93"}` });

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

// options: [{ value, label, group? }]。group があるものは <optgroup> にまとめる
function fillSelect(sel, options, placeholder) {
  if (document.activeElement === sel) return; // 選択中のプルダウンを閉じさせない
  const cur = sel.value;
  const nodes = placeholder != null ? [h("option", { value: "" }, placeholder)] : [];
  const groups = new Map();
  for (const o of options) {
    const opt = h("option", { value: o.value }, o.label);
    if (!o.group) { nodes.push(opt); continue; }
    if (!groups.has(o.group)) { groups.set(o.group, h("optgroup", { label: o.group })); nodes.push(groups.get(o.group)); }
    groups.get(o.group).append(opt);
  }
  sel.replaceChildren(...nodes);
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
  el.force = (v) => { delete el.dataset.dirty; el.value = v; };
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

// 押した回数だけ足されるボタン列（最後に「0に戻す」）
function quickButtons(input, steps) {
  const add = (n) => {
    const v = (Number(input.value) || 0) + n;
    input.value = Math.round(v * 100) / 100;
    input.dispatchEvent(new Event("input"));
  };
  return h("div", { class: "quick" },
    steps.map((n) => h("button", { type: "button", class: `pill${n < 0 ? " neg" : ""}`, onclick: () => add(n) }, signed(n))),
    h("button", { type: "button", class: "pill reset", onclick: () => { input.value = ""; input.dispatchEvent(new Event("input")); } }, "0に戻す"));
}

// 点数のプルダウン。値の本体は input（数値欄）で、プルダウン・加算ボタン・自由入力のどれから変えても同期する
function amountPicker(input, values, label = "ポイント") {
  const CUSTOM = "custom";
  const sel = h("select", { "aria-label": "点数" },
    h("option", { value: "" }, "選択"),
    values.map((v) => h("option", { value: String(v) }, `${signed(v)} pt`)),
    h("option", { value: CUSTOM }, "自由に入力"));
  const customCell = field("点数を入力", input);
  const sync = () => {
    const v = input.value === "" ? "" : String(Number(input.value));
    if (v === "") { if (sel.value !== CUSTOM) sel.value = ""; }
    else sel.value = values.map(String).includes(v) ? v : CUSTOM;
    customCell.hidden = sel.value !== CUSTOM;
  };
  sel.addEventListener("change", () => {
    if (sel.value !== CUSTOM) input.value = sel.value;
    customCell.hidden = sel.value !== CUSTOM;
    if (sel.value === CUSTOM) input.focus();
  });
  input.addEventListener("input", sync);
  input.addEventListener("change", sync);
  sync();
  return [field(label, sel), customCell];
}

// 見出しを押すと開閉する欄
function fold(title, content, open) {
  return h("details", { class: "fold", open }, h("summary", null, h("span", null, title), icon("chevron")), content);
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

const sectionTitle = (text, compact) => (compact ? h("h2", { class: "section-title" }, text) : largeTitle(text));

const none = (text = "まだありません") => cell(h("span", { class: "secondary" }, text));

// 「見ました」の対象者（宛先に合わせる）
function ackAudience(a) {
  if (a.scope === "team") return membersOfTeam(a.target, { includeHidden: true });
  if (a.scope === "user") return sortedMembers().filter((m) => m.id === a.target);
  return sortedMembers();
}

const openAckLists = new Set(); // 管理者が開いている「見た人」一覧（再描画しても閉じないように）

function ackBox(a, admin) {
  if (!a.ack) return null;
  if (!admin) {
    const uid = S.user.uid;
    const ackId = `${a.id}_${uid}`;
    const done = S.acks.has(ackId);
    return h("button", {
      class: `ack-btn${done ? " done" : ""}`, "aria-pressed": String(done),
      onclick: () => fire(done
        ? deleteDoc(doc(db, "acks", ackId))
        : setDoc(doc(db, "acks", ackId), { annId: a.id, uid, at: serverTimestamp() })),
    }, done ? [icon("check"), "見ました"] : "見ました");
  }
  const audience = ackAudience(a);
  const seen = audience.filter((m) => S.acks.has(`${a.id}_${m.id}`));
  const notYet = audience.filter((m) => !S.acks.has(`${a.id}_${m.id}`));
  const details = h("details", { class: "ack-list", open: openAckLists.has(a.id) },
    h("summary", null, icon("check"), `見た人 ${seen.length} / ${audience.length}人`),
    h("div", { class: "ack-names" },
      h("div", null, h("b", null, "見た："), seen.length ? seen.map((m) => m.name).join("・") : "まだいません"),
      h("div", null, h("b", null, "まだ："), notYet.length ? notYet.map((m) => m.name).join("・") : "全員見ました")));
  details.addEventListener("toggle", () => { if (details.open) openAckLists.add(a.id); else openAckLists.delete(a.id); });
  return details;
}

function deleteAnnouncement(a) {
  if (!confirm(`「${a.title}」を削除しますか？`)) return;
  const b = writeBatch(db);
  b.delete(doc(db, "announcements", a.id));
  [...S.acks.values()].filter((x) => x.annId === a.id).forEach((x) => b.delete(doc(db, "acks", x.id)));
  fire(b.commit(), "削除しました");
}

function announcementCard(a, { admin = false } = {}) {
  let scope = "全員";
  if (a.scope === "team") scope = admin ? `${teamName(a.target)} のみ` : `チーム限定（${teamName(a.target)}）`;
  if (a.scope === "user") scope = admin ? `${memberName(a.target)} のみ` : "あなた宛て";
  return h("article", { class: `card ann${a.pinned ? " pinned" : ""}`, "data-ann": a.id },
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
    ackBox(a, admin),
    admin ? h("div", { class: "ann-actions" },
      h("button", { class: "text-btn", onclick: () => fire(updateDoc(doc(db, "announcements", a.id), { pinned: !a.pinned })) }, a.pinned ? "固定を解除" : "固定"),
      h("button", { class: "text-btn destructive", onclick: () => deleteAnnouncement(a) }, "削除"),
    ) : null,
  );
}

const sortAnnouncements = (list) => list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || ts(b.createdAt) - ts(a.createdAt));

// ポイント交換の相手（「〇〇 へ」「〇〇 から」）
function transferText(l) {
  if (!l.transferId) return null;
  const name = l.counterKind === "team"
    ? (S.teams.has(l.counterId) ? teamName(l.counterId) : "相手チーム")
    : memberName(l.counterId);
  return l.delta < 0 ? `${name} へ` : `${name} から`;
}

// 交換は2件で1組なので、取り消すときは両方まとめて消す
function cancelLog(l) {
  const target = l.kind === "team" ? teamName(l.target) : memberName(l.target);
  if (l.transferId) {
    const pair = merged(S.logSrc).filter((x) => x.transferId === l.transferId);
    if (!confirm(`ポイント交換（${target} ${transferText(l)} ${Math.abs(l.delta)}pt）を取り消しますか？\n渡した側・受け取った側の両方が取り消されます。`)) return;
    const b = writeBatch(db);
    pair.forEach((x) => b.delete(doc(db, "pointLogs", x.id)));
    fire(b.commit(), "交換を取り消しました");
    return;
  }
  if (confirm(`「${target} ${signed(l.delta)}（${l.reason || "理由なし"}）」を取り消しますか？`)) fire(deleteDoc(doc(db, "pointLogs", l.id)), "取り消しました");
}

// 「〇〇の功績」。スパイが本当のチームに入れた分は、参加者には名前を出さない
function contributorText(l, admin) {
  if (!l.contributor) return null;
  if (l.contributorHidden && !admin) return null;
  return `${memberName(l.contributor)}の功績${admin && l.contributorHidden ? "（スパイ→本当のチーム）" : ""}`;
}

function logCell(l, { showTarget = true, admin = false } = {}) {
  const target = l.kind === "team" ? teamName(l.target) : memberName(l.target);
  const vis = l.visibility === "team" && l.kind === "user" ? `チーム内のみ（${teamName(l.teamId)}）` : VIS_LABEL[l.visibility];
  return h("div", { class: "cell log" },
    h("div", { class: "cell-main" },
      h("div", null,
        showTarget ? h("span", { class: "log-target" }, target) : null,
        l.transferId ? h("span", { class: "transfer" }, icon("arrows"), transferText(l)) : null,
        l.reason || (l.transferId ? "" : "（理由なし）")),
      h("div", { class: "cell-sub" }, [contributorText(l, admin), fmtDate(l.createdAt), vis].filter(Boolean).join(" · ")),
    ),
    h("div", { class: `delta ${l.delta >= 0 ? "plus" : "minus"}` }, signed(l.delta)),
    admin ? h("button", { class: "icon-btn", "aria-label": "取り消す", title: "取り消す", onclick: () => cancelLog(l) }, icon("xmark")) : null,
  );
}

function rankingCells(rows) {
  if (!rows.length) return none();
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

// ---------------------------------------------------------------- 表・メモ
//   notes/{id} { title, type: "memo" | "table", body, rows: [{ c: [セル...] }], shared, order }
//   （Firestore は配列の中に配列を入れられないので、表の各行は { c: [...] } にしている）

const sortedNotes = () => [...S.notes.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const tableRows = (n) => (n.rows?.length ? n.rows.map((r) => [...(r.c ?? [])]) : [["", ""], ["", ""]]);

function noteDisplay(n) {
  const rows = tableRows(n);
  const width = Math.max(...rows.map((r) => r.length));
  return h("article", { class: "card note", "data-note": n.id },
    h("div", { class: "note-head" }, icon(n.type === "table" ? "table" : "note"), h("h3", null, n.title || "（無題）")),
    n.type === "table"
      ? h("div", { class: "table-wrap" }, h("table", { class: "note-table" },
          h("thead", null, h("tr", null, Array.from({ length: width }, (_, i) => h("th", null, rows[0][i] ?? "")))),
          h("tbody", null, rows.slice(1).map((r) => h("tr", null, Array.from({ length: width }, (_, i) => h("td", null, r[i] ?? "")))))))
      : h("p", { class: "note-body" }, n.body || ""),
  );
}

// 管理者用の編集カード。保存を押すまで手元の下書きを保ち、他の端末からの更新で消えないようにする
function noteEditor(n) {
  let draft = null;
  let dirty = false;
  const title = h("input", { type: "text", class: "plain title-input", placeholder: "タイトル", "aria-label": "タイトル" });
  const shared = toggle();
  const body = h("textarea", { class: "plain", rows: "4", placeholder: "例：ビーチフラッグ 1位 +10 / 2位 +6 / 3位 +3" });
  const grid = h("div", { class: "table-wrap" });
  const saveBtn = h("button", { class: "text-btn", disabled: true }, "保存");
  const markDirty = () => { dirty = true; saveBtn.disabled = false; el.classList.add("dirty"); };
  title.addEventListener("input", markDirty);
  body.addEventListener("input", markDirty);
  shared.addEventListener("change", () => fire(updateDoc(doc(db, "notes", n.id), { shared: shared.checked }), shared.checked ? "参加者に公開しました" : "管理者だけにしました"));

  const paintGrid = () => {
    const width = Math.max(1, ...draft.map((r) => r.length));
    draft.forEach((r) => { while (r.length < width) r.push(""); });
    grid.replaceChildren(h("table", { class: "note-table edit" }, h("tbody", null, draft.map((r, ri) => h("tr", null, r.map((v, ci) => {
      const inp = h("input", { type: "text", value: v, "aria-label": `${ri + 1}行${ci + 1}列` });
      inp.addEventListener("input", () => { draft[ri][ci] = inp.value; markDirty(); });
      return h(ri === 0 ? "th" : "td", null, inp);
    }))))));
  };
  const edit = (fn) => { fn(); markDirty(); paintGrid(); };
  const tableTools = h("div", { class: "table-tools" },
    h("button", { class: "pill", type: "button", onclick: () => edit(() => draft.push(Array(draft[0].length).fill(""))) }, "＋ 行"),
    h("button", { class: "pill", type: "button", onclick: () => edit(() => draft.forEach((r) => r.push(""))) }, "＋ 列"),
    h("button", { class: "pill neg", type: "button", onclick: () => edit(() => { if (draft.length > 1) draft.pop(); }) }, "− 行"),
    h("button", { class: "pill neg", type: "button", onclick: () => edit(() => { if (draft[0].length > 1) draft.forEach((r) => r.pop()); }) }, "− 列"));

  saveBtn.addEventListener("click", () => {
    const data = { title: title.value.trim() };
    if (n.type === "table") data.rows = draft.map((r) => ({ c: [...r] }));
    else data.body = body.value;
    fire(updateDoc(doc(db, "notes", n.id), data), "保存しました");
    dirty = false; saveBtn.disabled = true; el.classList.remove("dirty");
  });

  const el = h("article", { class: "card note editor", "data-note": n.id },
    h("div", { class: "note-head" }, icon(n.type === "table" ? "table" : "note"), title),
    n.type === "table" ? [grid, tableTools] : body,
    h("div", { class: "note-foot" },
      h("label", { class: "note-share" }, shared, "参加者に公開"),
      h("div", { class: "note-actions" },
        saveBtn,
        h("button", { class: "text-btn destructive", onclick: () => { if (confirm(`「${n.title || "無題"}」を削除しますか？`)) fire(deleteDoc(doc(db, "notes", n.id)), "削除しました"); } }, "削除"))),
  );
  return {
    el,
    patch(next) {
      n = next;
      shared.checked = !!n.shared;
      el.classList.toggle("shared", !!n.shared);
      if (dirty) return;
      title.value = n.title ?? "";
      if (n.type === "table") { draft = tableRows(n); paintGrid(); } else body.value = n.body ?? "";
    },
  };
}

function notesView({ admin = false, compact = false, withTitle = true } = {}) {
  const list = h("div", { class: "stack" });
  const add = (type) => fire(addDoc(collection(db, "notes"), {
    title: type === "table" ? "新しい表" : "新しいメモ", type, body: "",
    rows: type === "table" ? [{ c: ["", "", ""] }, { c: ["", "", ""] }] : [],
    shared: false, order: Date.now(),
  }), type === "table" ? "表を追加しました" : "メモを追加しました");
  const el = h("div", null,
    withTitle ? sectionTitle("表・メモ", compact) : null,
    admin ? h("div", { class: "note-add" },
      h("button", { class: "pill", onclick: () => add("memo") }, icon("note"), "メモを追加"),
      h("button", { class: "pill", onclick: () => add("table") }, icon("table"), "表を追加")) : null,
    list);
  return {
    el,
    update() {
      const notes = sortedNotes();
      if (!notes.length) {
        list._rows?.clear();
        list.replaceChildren(emptyState("note", "まだありません", admin ? "ポイントの決め方やリーグ戦の表などを、自由に追加できます。" : null));
        return;
      }
      if (!admin) { list.replaceChildren(...notes.map(noteDisplay)); return; }
      if (list.querySelector(".empty")) list.replaceChildren();
      keyedList(list, notes, (n) => noteEditor(n), (row, n) => row.patch(n));
    },
  };
}

// 管理者 PC の4列目：表・メモ ＋ 参加者
function adminSide() {
  const notes = notesView({ admin: true });
  const members = adminMembers({ withTitle: true });
  return { el: h("div", null, notes.el, h("div", { class: "side-gap" }), members.el), update() { notes.update(); members.update(); } };
}

// ---------------------------------------------------------------- 地図（現在地）
// Leaflet（地図ライブラリ）と OpenStreetMap の地図を使う。ライブラリは地図を初めて開いたときに読み込む。
// 一度表示した地図の絵は sw.js がスマホに保存するので、電波のない島でも前に見た範囲は表示できる。

const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
const ISLAND_CENTER = [34.335, 136.70]; // 五ヶ所湾あたり（現在地が取れるまでの初期表示。目安の座標）
let leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletLoading ??= new Promise((resolve, reject) => {
    document.head.append(h("link", { rel: "stylesheet", href: `${LEAFLET}leaflet.min.css` }));
    const sc = h("script", { src: `${LEAFLET}leaflet.min.js` });
    sc.onload = () => resolve(window.L);
    sc.onerror = () => { leafletLoading = null; reject(new Error("地図を読み込めませんでした。電波のある場所で一度開いてください。")); };
    document.head.append(sc);
  });
  return leafletLoading;
}

const GEO_ERRORS = {
  1: "位置情報の利用が許可されていません。iPhone は「設定 › プライバシーとセキュリティ › 位置情報サービス › Safari」を「使用中のみ」に、Android は Chrome の位置情報を許可してください。",
  2: "現在地を取得できませんでした。空が見える場所で少し待ってください。",
  3: "現在地の取得に時間がかかっています。空が見える場所で少し待ってください。",
};

function mapView() {
  const box = h("div", { class: "map-box" });
  const status = h("div", { class: "map-status" }, "現在地を探しています…");
  const locateBtn = h("button", { class: "map-locate", "aria-label": "現在地に戻る", title: "現在地に戻る" }, icon("locate"));
  const el = h("div", { class: "map-view" }, h("div", { class: "map-wrap" }, box, locateBtn), status);
  let map = null, dot = null, ring = null, watchId = null, last = null, follow = true;

  const show = (pos) => {
    const { latitude, longitude, accuracy } = pos.coords;
    last = [latitude, longitude];
    if (!map) return;
    if (!dot) {
      ring = window.L.circle(last, { radius: accuracy, color: "#007AFF", weight: 1, fillOpacity: 0.12 }).addTo(map);
      dot = window.L.circleMarker(last, { radius: 8, color: "#fff", weight: 3, fillColor: "#007AFF", fillOpacity: 1 }).addTo(map);
      map.setView(last, 16);
    } else {
      dot.setLatLng(last);
      ring.setLatLng(last).setRadius(accuracy);
      if (follow) map.panTo(last);
    }
    const t = new Date(pos.timestamp);
    status.textContent = `現在地：誤差 約${Math.round(accuracy)}m ・ ${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")} 更新`;
  };

  locateBtn.addEventListener("click", () => {
    follow = true;
    if (map && last) map.setView(last, Math.max(map.getZoom(), 16));
  });

  let started = false;
  return {
    el,
    update() {
      if (started) { map?.invalidateSize(); return; }
      started = true;
      loadLeaflet().then((L) => {
        map = L.map(box, { zoomControl: true, attributionControl: true }).setView(ISLAND_CENTER, 13);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map);
        map.on("dragstart", () => { follow = false; });
        setTimeout(() => map.invalidateSize(), 50);
        if (!("geolocation" in navigator)) { status.textContent = "この端末では現在地を取得できません。"; return; }
        watchId = navigator.geolocation.watchPosition(show, (err) => { status.textContent = GEO_ERRORS[err.code] ?? err.message; },
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
        if (last) show({ coords: { latitude: last[0], longitude: last[1], accuracy: 30 }, timestamp: Date.now() });
      }).catch((e) => { status.textContent = e.message; });
    },
    // 小窓を閉じたら位置の取得を止める（電池のため）
    destroy() {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      map?.remove();
    },
  };
}

const mapAllowed = () => S.isAdmin || !!S.config.mapEnabled;

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

// お知らせ欄に流すポイントの加点・減点（加点は緑、減点は赤）
function pointNotice(l) {
  const uid = S.user.uid;
  const team = l.kind === "team" ? S.teams.get(l.target) : null;
  const who = l.kind === "team" ? teamName(l.target) : l.target === uid ? "あなた" : memberName(l.target);
  const scope = { public: "全員に公開", team: "チーム内のみ", private: "あなただけ" }[l.visibility];
  return h("article", { class: `card point-notice ${l.delta >= 0 ? "plus" : "minus"}` },
    h("div", { class: "pn-delta" }, signed(l.delta), h("small", null, "pt")),
    h("div", { class: "pn-main" },
      h("div", { class: "pn-who" }, team ? dot(team.color) : null, who),
      l.transferId ? h("div", { class: "pn-transfer" }, icon("arrows"), "ポイント交換：", transferText(l)) : null,
      l.reason || !l.transferId ? h("div", { class: "pn-reason" }, l.reason || "（理由なし）") : null,
      h("div", { class: "pn-meta" }, [contributorText(l, false), fmtDate(l.createdAt), scope].filter(Boolean).join(" · "))),
  );
}

function memberHome({ compact = false } = {}) {
  const filter = segmented([{ value: "all", label: "すべて" }, { value: "ann", label: "お知らせ" }, { value: "pt", label: "ポイント" }]);
  filter.addEventListener("change", () => scheduleRender());
  const list = h("div", { class: "stack" });
  const el = h("div", null, sectionTitle("お知らせ", compact), h("div", { class: "seg-wrap" }, filter), list);
  return {
    el,
    update() {
      const anns = filter.value === "pt" ? [] : merged(S.annSrc).map((a) => ({ type: "ann", at: ts(a.createdAt) || Date.now(), a }));
      const pts = filter.value === "ann" ? [] : merged(S.logSrc).map((l) => ({ type: "pt", at: ts(l.createdAt) || Date.now(), l }));
      const pinned = anns.filter((x) => x.a.pinned).sort((x, y) => y.at - x.at);
      const rest = [...anns.filter((x) => !x.a.pinned), ...pts].sort((x, y) => y.at - x.at);
      const items = [...pinned, ...rest];
      list.replaceChildren(...(items.length
        ? items.map((x) => (x.type === "ann" ? announcementCard(x.a) : pointNotice(x.l)))
        : [emptyState("megaphone", "まだありません", "新しいお知らせやポイントが届くとここに表示されます。")]));
    },
  };
}

function memberTeam({ compact = false } = {}) {
  const body = h("div");
  const el = h("div", null, sectionTitle("チーム", compact), body);
  return {
    el,
    update() {
      const sets = sortedSets();
      if (!sets.length) {
        body.replaceChildren(emptyState("lock", "チーム発表はまだです", "発表されるとここに表示されます。"));
        return;
      }
      const uid = S.user.uid;
      const mine = sets.map((s) => ({ set: s, team: S.teams.get(teamOfIn(uid, s.id)), real: S.teams.get(trueTeamOf(uid, s.id)) }));
      const isSpy = mine.some((x) => x.real);
      body.replaceChildren(
        group("あなたのチーム", mine.flatMap(({ set, team, real }) => [
          cell(set.name, team ? h("span", { class: "team-label strong" }, dot(team.color), team.name) : "未所属"),
          real ? h("div", { class: "cell spy-secret" },
            h("div", { class: "cell-main" }, h("div", { class: "spy-name" }, icon("spy"), "スパイ")),
            h("div", { class: "cell-detail" }, "本当は ", h("span", { class: "team-label strong" }, dot(real.color), real.name))) : null,
        ]), isSpy ? "スパイであることと本当のチームは、あなたにしか表示されていません。" : null),
        ...sets.map((s) => group(s.name, teamsInSet(s.id).map((t) => {
          const ms = membersOfTeam(t.id);
          const isMine = ms.some((m) => m.id === uid);
          return h("div", { class: `cell team-cell${isMine ? " me" : ""}` },
            h("div", { class: "cell-main" },
              h("div", { class: "team-label strong" }, dot(t.color), t.name, isMine ? h("span", { class: "tint you" }, "あなた") : null),
              h("div", { class: "cell-sub" }, ms.length ? ms.map((m) => m.name).join("・") : "メンバーなし")),
          );
        }))),
      );
    },
  };
}

function memberPoints({ compact = false } = {}) {
  const body = h("div");
  const rankSel = h("select", { class: "inline-select", "aria-label": "ランキングの種類" });
  rankSel.addEventListener("change", () => scheduleRender());
  const el = h("div", null, sectionTitle("ポイント", compact), body);
  return {
    el,
    update() {
      const uid = S.user.uid;
      const logs = merged(S.logSrc).sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
      const mine = logs.filter((l) => l.kind === "user" && l.target === uid);
      const byVis = (arr, v) => sum(arr.filter((l) => l.visibility === v));
      const myTeams = myTeamIds(uid).map((id) => S.teams.get(id)).filter(Boolean)
        .sort((a, b) => byOrder(S.sets.get(a.setId) ?? {}, S.sets.get(b.setId) ?? {}));

      const parts = compact ? [] : [
        statCard("あなた", sum(mine), [["全員に公開", byVis(mine, "public")], ["チーム内", byVis(mine, "team")], ["本人のみ", byVis(mine, "private")]]),
      ];
      for (const t of compact ? [] : myTeams) {
        const tl = logs.filter((l) => l.kind === "team" && l.target === t.id);
        const secret = trueTeamOf(uid, t.setId) === t.id;
        parts.push(statCard(`${teamName(t.id)}${secret ? "（本当のチーム）" : ""}`, sum(tl), [["全員に公開", byVis(tl, "public")], ["チーム内のみ", byVis(tl, "team")]], t.color));
      }
      parts.push(group("あなたの履歴", mine.length ? mine.map((l) => logCell(l, { showTarget: false })) : none()));
      const teamLogs = logs.filter((l) => l.kind === "team" && myTeams.some((t) => t.id === l.target));
      if (myTeams.length) parts.push(group("チームの履歴", teamLogs.length ? teamLogs.map((l) => logCell(l)) : none()));

      fillSelect(rankSel, [{ value: "user", label: "個人" }, ...sortedSets().map((s) => ({ value: s.id, label: `${s.name}（チーム）` }))]);
      const pub = logs.filter((l) => l.visibility === "public");
      const rows = rankSel.value === "user" || !S.sets.has(rankSel.value)
        ? sortedMembers().map((m) => ({ label: m.name, value: sum(pub.filter((l) => l.kind === "user" && l.target === m.id)), highlight: m.id === uid }))
        : teamsInSet(rankSel.value).map((t) => ({ label: t.name, color: t.color, value: sum(pub.filter((l) => l.kind === "team" && l.target === t.id)), highlight: myTeams.some((x) => x.id === t.id) }));
      parts.push(group("ランキング", [field("表示", rankSel), ...[rankingCells(rows)].flat()], "「全員に公開」のポイントだけで集計しています。"));
      body.replaceChildren(...parts);
    },
  };
}

// 所持ポイントと、所属チームごとのチームポイントを小さなタイルで並べる
function memberSummary() {
  const el = h("div", { class: "summary" });
  return {
    el,
    update() {
      const uid = S.user.uid;
      const logs = merged(S.logSrc);
      const tile = (label, value, color, sub) => h("div", { class: "tile", style: color ? `--c:${color}` : null },
        h("div", { class: "tile-label" }, color ? dot(color) : null, label),
        h("div", { class: "tile-value" }, value, h("small", null, "pt")),
        sub ? h("div", { class: "tile-sub" }, sub) : null);
      const teams = sortedSets().flatMap((s) => [
        { t: S.teams.get(teamOfIn(uid, s.id)), secret: false },
        { t: S.teams.get(trueTeamOf(uid, s.id)), secret: true },
      ]).filter((x) => x.t);
      el.replaceChildren(
        tile("あなた", sum(logs.filter((l) => l.kind === "user" && l.target === uid))),
        ...teams.map(({ t, secret }) => tile(t.name, sum(logs.filter((l) => l.kind === "team" && l.target === t.id)), t.color,
          secret ? "本当のチーム（あなただけ）" : S.sets.get(t.setId)?.name)),
      );
    },
  };
}

function settingsView({ withTitle = true } = {}) {
  const cur = h("input", { type: "password", autocomplete: "current-password", placeholder: "必須", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", minlength: "6", placeholder: "6文字以上", required: true });
  const btn = h("button", { class: "cell cell-button", type: "submit" }, "パスワードを変更");
  const adminBox = h("div");
  const el = h("div", null,
    withTitle ? largeTitle("設定") : null,
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
      const mapSwitch = toggle(!!S.config.mapEnabled);
      mapSwitch.addEventListener("change", () => fire(updateDoc(doc(db, "config", "app"), { mapEnabled: mapSwitch.checked }),
        mapSwitch.checked ? "参加者に地図を表示しました" : "参加者の地図を非表示にしました"));
      adminBox.replaceChildren(group("企画", [
        field("タイトル", titleInput),
        h("button", { class: "cell cell-button", onclick: () => fire(updateDoc(doc(db, "config", "app"), { title: titleInput.value.trim() || APP_TITLE }), "保存しました") }, "タイトルを保存"),
        field("参加者に地図を表示", mapSwitch),
      ], "地図（現在地表示）は管理者には常に表示されます。"));
    },
  };
}

// ---------------------------------------------------------------- 画面：管理者

function adminAnnouncements() {
  const title = h("input", { type: "text", maxlength: "100", placeholder: "タイトル", required: true, class: "plain title-input" });
  const body = h("textarea", { rows: "4", placeholder: "本文", class: "plain" });
  const scope = segmented([{ value: "all", label: "全員" }, { value: "team", label: "チーム" }, { value: "user", label: "個人" }]);
  const target = h("select", { "aria-label": "宛先" });
  const targetCell = field("宛先", target);
  const pinned = toggle();
  const ack = toggle();
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
    if (scope.value === "team") fillSelect(target, teamOptions(), "選択");
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
        ack: ack.checked,
        createdAt: serverTimestamp(),
        author: emailToId(S.user.email),
      }), "投稿しました");
      title.value = body.value = "";
      pinned.checked = false;
      ack.checked = false;
      images.length = 0;
      renderPreview();
    },
  },
    group("新規", [h("div", { class: "cell" }, title), h("div", { class: "cell" }, body), preview,
      h("label", { class: "cell cell-button" }, icon("photo"), "写真を追加", fileInput)], "写真は3枚まで。自動で縮小されます。"),
    group("公開範囲", [h("div", { class: "cell" }, scope), targetCell, field("一番上に固定", pinned), field("見ましたボタン", ack)],
      "「チーム」宛ては、そのチーム表を発表するまで届きません。"),
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

function adminMembers({ withTitle = true } = {}) {
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
    withTitle ? largeTitle("参加者") : null,
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
        const sub = h("div", { class: "cell-sub" });
        const el = h("div", { class: "cell member-row" },
          h("div", { class: "cell-main" }, nm, sub),
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
              membershipsOf((x) => x.uid === m.id).forEach((x) => b.delete(doc(db, "memberships", x.id)));
              fire(b.commit(), "削除しました");
            },
          }, "削除"),
        );
        return { el, nm, sub };
      }, (row, m) => {
        row.nm.sync(m.name);
        setKids(row.sub, m.loginId, ...sortedSets().flatMap((s) => {
          const t = S.teams.get(teamOfIn(m.id, s.id));
          const real = S.teams.get(trueTeamOf(m.id, s.id));
          if (!t) return [];
          return [" · ", h("span", { class: "team-label" }, dot(t.color), t.name), real ? h("span", { class: "spy-tag" }, icon("spy"), `本当は${real.name}`) : null];
        }));
      });
    },
  };
}

function adminTeams() {
  let setId = null;
  let justCreated = null; // 追加直後でまだ一覧に届いていないチーム表
  const setBar = h("div", { class: "set-bar", role: "tablist" });
  const noSets = emptyState("flag", "チーム表がありません", "「チーム表を追加」で作成してください。");
  const setName = editableInput({ "aria-label": "チーム表の名前" });
  const publish = toggle();
  const publishFooter = h("span");
  const name = h("input", { type: "text", placeholder: "Aチーム", required: true });
  const color = h("select", null, TEAM_COLORS.map((c) => h("option", { value: c.value }, c.label)));
  const colorDot = dot(TEAM_COLORS[0].value);
  color.addEventListener("change", () => colorDot.style.setProperty("--c", color.value));
  const teamBody = h("div", { class: "group-body" });
  const teamGroup = h("section", { class: "group" }, h("div", { class: "group-header" }, "チーム"), teamBody);
  const assignBody = h("div", { class: "group-body" });
  const assignEmpty = emptyState("people", "まだ参加者がいません");
  // スパイ
  const spyWho = h("select", { "aria-label": "スパイにする人" });
  const spyCover = h("select", { "aria-label": "参加先のチーム" });
  const spyTrue = h("select", { "aria-label": "本当のチーム" });
  const spyList = h("div", { class: "group-body" });
  // スパイにする人を選んだら、参加先にはその人の今のチームを入れておく
  spyWho.addEventListener("change", () => { spyCover.value = teamOfIn(spyWho.value, setId) ?? ""; });
  const spyListGroup = h("section", { class: "group" }, h("div", { class: "group-header" }, "登録中のスパイ"), spyList,
    h("div", { class: "group-footer" }, "本当のチームは、本人と管理者にしか見えません。"));

  publish.addEventListener("change", () => {
    const next = publish.checked;
    const set = S.sets.get(setId);
    if (!set || !confirm(next ? `「${set.name}」を発表しますか？参加者全員に表示されます。` : `「${set.name}」の発表を取り消して、非公開に戻しますか？`)) {
      publish.checked = !next;
      return;
    }
    fire(setPublished(setId, next), next ? `「${set.name}」を発表しました` : "非公開に戻しました");
  });

  function addSet() {
    const n = S.sets.size + 1;
    const ref = doc(collection(db, "teamSets"));
    fire(setDoc(ref, { name: `チーム表${n}`, order: Date.now(), published: false }), `チーム表${n} を追加しました`);
    setId = justCreated = ref.id;
    setName.force(`チーム表${n}`);
    scheduleRender();
  }

  function randomAssign() {
    const teams = teamsInSet(setId);
    const ms = sortedMembers();
    if (!teams.length || !ms.length) return toast("チームと参加者を先に作ってください", true);
    if (!confirm(`${ms.length}人を${teams.length}チームにランダムで振り分けます。このチーム表の今の振り分けとスパイ登録は上書きされます。`)) return;
    const shuffled = [...ms];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const published = !!S.sets.get(setId)?.published;
    const b = writeBatch(db);
    membershipsOf((m) => m.setId === setId).forEach((m) => b.delete(doc(db, "memberships", m.id)));
    shuffled.forEach((m, i) => {
      const teamId = teams[i % teams.length].id;
      b.set(doc(db, "memberships", `${teamId}_${m.id}`), { teamId, uid: m.id, setId, published, hidden: false });
    });
    fire(b.commit(), "振り分けました");
  }

  const detail = h("div", null,
    group("チーム表", [
      field("名前", setName),
      h("button", {
        class: "cell cell-button",
        onclick: () => { fire(updateDoc(doc(db, "teamSets", setId), { name: setName.value.trim() || "チーム表" }), "保存しました"); setName.saved(); },
      }, "名前を保存"),
      field("参加者に発表", publish),
    ], publishFooter),
    h("form", {
      onsubmit: (e) => {
        e.preventDefault();
        fire(addDoc(collection(db, "teams"), {
          setId, name: name.value.trim(), color: color.value, order: Date.now(), published: !!S.sets.get(setId)?.published,
        }), "作成しました");
        name.value = "";
        color.selectedIndex = (color.selectedIndex + 1) % TEAM_COLORS.length;
        colorDot.style.setProperty("--c", color.value);
      },
    }, group("新しいチーム", [field("名前", name), field(h("span", { class: "team-label" }, colorDot, "色"), color),
      h("button", { class: "cell cell-button", type: "submit" }, "チームを作成")])),
    teamGroup,
    h("div", { class: "group-header standalone with-action" }, "振り分け",
      h("button", { class: "text-btn", onclick: () => randomAssign() }, icon("shuffle"), "ランダム")),
    assignEmpty,
    h("section", { class: "group" }, assignBody),
    h("form", {
      onsubmit: (e) => {
        e.preventDefault();
        if (!spyWho.value || !spyCover.value || !spyTrue.value) return toast("スパイ・参加先・本当のチームを選んでください", true);
        if (spyCover.value === spyTrue.value) return toast("参加先と本当のチームが同じです", true);
        const nm = memberName(spyWho.value);
        fire(setSpy(spyWho.value, setId, spyCover.value, spyTrue.value),
          `${nm} を ${S.teams.get(spyCover.value)?.name} へのスパイとして登録しました（本当は ${S.teams.get(spyTrue.value)?.name}）`);
        spyWho.value = "";
      },
    }, group("スパイ", [
      field("スパイ", spyWho),
      field("参加先", spyCover),
      field("本当のチーム", spyTrue),
      h("button", { class: "cell cell-button", type: "submit" }, "スパイを登録"),
    ], "他の参加者には、参加先チームの普通のメンバーとして表示されます。本人には本当のチームも表示されます。")),
    spyListGroup,
    group(null, h("button", {
      class: "cell cell-button destructive",
      onclick: () => {
        const set = S.sets.get(setId);
        if (!set || !confirm(`「${set.name}」を削除しますか？\nこのチーム表のチームと振り分けもすべて消えます（ポイント履歴は残ります）。`)) return;
        fire(deleteSet(setId), "削除しました");
        setId = null;
      },
    }, "このチーム表を削除")),
  );

  const el = h("div", null, largeTitle("チーム"), setBar, noSets, detail);

  return {
    el,
    update() {
      const sets = sortedSets();
      if (S.sets.has(justCreated)) justCreated = null;
      if (!S.sets.has(setId) && !(justCreated && setId === justCreated)) {
        setId = sets[0]?.id ?? null;
        if (setId) setName.force(S.sets.get(setId).name);
      }
      setBar.replaceChildren(
        ...sets.map((s) => h("button", {
          type: "button", role: "tab", "aria-selected": String(s.id === setId), "data-set": s.id,
          class: s.published ? "published" : null,
          onclick: () => { setId = s.id; setName.force(s.name); scheduleRender(); },
        }, s.published ? null : icon("lock"), s.name)),
        h("button", { type: "button", class: "add", onclick: addSet }, icon("plus"), "チーム表を追加"),
      );
      noSets.hidden = sets.length > 0;
      detail.hidden = !S.sets.has(setId);
      if (!S.sets.has(setId)) return;

      const set = S.sets.get(setId);
      setName.sync(set.name);
      publish.checked = !!set.published;
      publishFooter.textContent = set.published
        ? "発表済みです。参加者はこのチーム表のチームと顔ぶれを見られます。"
        : "オフの間、参加者にはこのチーム表が一切見えません。振り分けが終わったらオンにしてください。";

      const teams = teamsInSet(setId);
      teamGroup.hidden = teams.length === 0;
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
              membershipsOf((m) => m.teamId === t.id).forEach((m) => b.delete(doc(db, "memberships", m.id)));
              fire(b.commit(), "削除しました");
            },
          }, "削除"),
        );
        return { el, nm, d, count };
      }, (row, t) => {
        row.d.style.setProperty("--c", t.color);
        row.nm.sync(t.name);
        row.count.textContent = `${membersOfTeam(t.id).length}人`;
      });

      const ms = sortedMembers();
      // スパイ
      fillSelect(spyWho, ms.map((m) => ({ value: m.id, label: m.name })), "選択");
      fillSelect(spyCover, teams.map((t) => ({ value: t.id, label: t.name })), "選択");
      fillSelect(spyTrue, teams.map((t) => ({ value: t.id, label: t.name })), "選択");
      const spies = ms.filter((m) => trueTeamOf(m.id, setId));
      spyListGroup.hidden = spies.length === 0;
      spyList.replaceChildren(...spies.map((m) => {
        const cover = S.teams.get(teamOfIn(m.id, setId));
        const real = S.teams.get(trueTeamOf(m.id, setId));
        return h("div", { class: "cell" },
          h("div", { class: "cell-main" }, h("div", { class: "spy-name" }, icon("spy"), m.name),
            h("div", { class: "cell-sub" }, "参加先 ", h("span", { class: "team-label" }, dot(cover?.color), cover?.name ?? "未所属"),
              " → 本当は ", h("span", { class: "team-label" }, dot(real?.color), real?.name))),
          h("button", { class: "text-btn destructive", onclick: () => { if (confirm(`${m.name} のスパイ登録を解除しますか？（参加先チームの普通のメンバーになります）`)) fire(clearSpy(m.id, setId), "解除しました"); } }, "解除"));
      }));
      assignEmpty.hidden = ms.length > 0;
      assignBody.parentElement.hidden = ms.length === 0;
      const options = teams.map((t) => ({ value: t.id, label: t.name }));
      keyedList(assignBody, ms, (m) => {
        const label = h("div", { class: "cell-main" });
        const sel = h("select", { class: "inline-select", "aria-label": "所属チーム" });
        sel.addEventListener("change", () => fire(assignMember(m.id, sel.dataset.set, sel.value)));
        return { el: h("div", { class: "cell" }, label, sel), label, sel };
      }, (row, m) => {
        const teamId = teamOfIn(m.id, setId);
        const real = trueTeamOf(m.id, setId);
        setKids(row.label, dot(S.teams.get(teamId)?.color), m.name,
          real ? h("span", { class: "spy-tag" }, icon("spy"), `本当は${S.teams.get(real)?.name ?? ""}`) : null);
        if (document.activeElement !== row.sel || row.sel.dataset.set !== setId) {
          row.sel.dataset.set = setId;
          row.sel.blur();
          fillSelect(row.sel, options, "未所属");
          row.sel.value = teamId ?? "";
        }
      });
    },
  };
}

function adminPoints() {
  const kind = segmented([{ value: "team", label: "チーム" }, { value: "user", label: "個人" }]);
  const target = h("select", { "aria-label": "対象" });
  const delta = h("input", { type: "number", step: "any", placeholder: "0", inputmode: "decimal", class: "delta-input" });
  const reason = h("input", { type: "text", maxlength: "200", placeholder: "ビーチフラッグ1位" });
  const contributor = h("select", { "aria-label": "誰の功績か" });
  const contributorCell = field("誰の功績", contributor);
  const spyDest = segmented([]);
  const spyDestCell = h("div", { class: "cell spy-dest" });
  const spyDestHelp = h("div", { class: "cell-sub" });
  spyDestCell.append(h("div", { class: "cell-main" }, h("div", { class: "spy-name" }, icon("spy"), "スパイの功績です。どちらに加算しますか？"), spyDest, spyDestHelp));
  const visibility = segmented([]);
  const visSet = h("select", { "aria-label": "どのチーム表のチーム内か" });
  const visSetCell = field("チーム表", visSet);
  const visFooter = h("span");
  const summary = h("div");
  const list = h("div", { class: "group-body" });

  const VIS_HELP = {
    public: "全員のランキングに反映されます。",
    team: "そのチームのメンバーだけに見えます（チーム表が発表されてから）。",
    private: "本人だけに見えます。",
  };

  // 選んだ功績者がこのチームに潜入中のスパイなら、本当のチームを返す
  const spyTrueTeam = () => {
    const t = S.teams.get(target.value);
    if (kind.value !== "team" || !t || !contributor.value) return null;
    return trueTeamOf(contributor.value, t.setId);
  };
  const refreshForm = () => {
    if (kind.value === "team") fillSelect(target, teamOptions(), "選択");
    else fillSelect(target, sortedMembers().map((m) => ({ value: m.id, label: m.name })), "選択");
    contributorCell.hidden = kind.value !== "team" || !target.value;
    if (!contributorCell.hidden) {
      fillSelect(contributor, membersOfTeam(target.value).map((m) => ({
        value: m.id, label: trueTeamOf(m.id, S.teams.get(target.value)?.setId) ? `${m.name}（スパイ）` : m.name,
      })), "チーム全体");
    }
    const real = spyTrueTeam();
    spyDestCell.hidden = !real;
    if (real) {
      const cover = S.teams.get(target.value);
      const prev = spyDest.value;
      spyDest.setOptions([{ value: "cover", label: `参加先（${cover.name}）` }, { value: "true", label: `本当（${S.teams.get(real)?.name}）` }]);
      if (prev) spyDest.value = prev;
      spyDestHelp.textContent = spyDest.value === "true"
        ? `${S.teams.get(real)?.name} に加算します。参加者には功績者の名前を出しません（スパイだと気づかれないように）。`
        : `${cover.name} に加算します。`;
    }
    visSetCell.hidden = !(kind.value === "user" && visibility.value === "team");
    fillSelect(visSet, sortedSets().map((s) => ({ value: s.id, label: s.name })));
    visFooter.textContent = VIS_HELP[visibility.value] ?? "";
  };
  const refreshVis = () => {
    visibility.setOptions(kind.value === "team"
      ? [{ value: "public", label: "全員" }, { value: "team", label: "チーム内" }]
      : [{ value: "public", label: "全員" }, { value: "team", label: "チーム内" }, { value: "private", label: "本人のみ" }]);
  };
  refreshVis();
  kind.addEventListener("change", () => { target.value = ""; contributor.value = ""; refreshVis(); refreshForm(); });
  target.addEventListener("change", () => { contributor.value = ""; refreshForm(); });
  contributor.addEventListener("change", () => { spyDest.value = "cover"; refreshForm(); });
  spyDest.addEventListener("change", refreshForm);
  visibility.addEventListener("change", refreshForm);

  // ボタンは押した回数だけ足される（+5 を2回で 10）
  const quick = quickButtons(delta, [1, 3, 5, 10, -1, -5]);

  const form = h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      if (!target.value) return toast("対象を選んでください", true);
      const d = Number(delta.value);
      if (!Number.isFinite(d) || d === 0) return toast("点数を入れてください（ボタンを押すか、数字を入力）", true);
      let teamId = null;
      let finalTarget = target.value;
      const who = kind.value === "team" ? contributor.value || null : null;
      const real = spyTrueTeam();
      const toTrue = !!real && spyDest.value === "true";
      if (toTrue) finalTarget = real;
      if (kind.value === "team") teamId = finalTarget;
      else if (visibility.value === "team") {
        teamId = teamOfIn(target.value, visSet.value);
        if (!teamId) return toast(`この人は「${S.sets.get(visSet.value)?.name ?? "そのチーム表"}」でチームに入っていません`, true);
      }
      fire(addDoc(collection(db, "pointLogs"), {
        kind: kind.value,
        target: finalTarget,
        teamId,
        visibility: visibility.value,
        delta: d,
        reason: reason.value.trim(),
        createdAt: serverTimestamp(),
        author: emailToId(S.user.email),
        contributor: who,
        contributorHidden: toTrue,
      }), `${signed(d)} pt を付けました${toTrue ? `（本当のチーム ${S.teams.get(real)?.name} へ）` : ""}`);
      contributor.value = "";
      reason.value = "";
      delta.value = "";
      delta.dispatchEvent(new Event("input"));
    },
  },
    group("対象", [h("div", { class: "cell" }, kind), field("名前", target), contributorCell, spyDestCell],
      "チームに付けるときは、誰の功績かを選べます（選ばなければチーム全体）。"),
    group("点数", [...amountPicker(delta, [1, 2, 3, 5, 10, 15, 20, 30, 50, 100, -1, -2, -3, -5, -10, -20]), h("div", { class: "cell" }, quick), field("理由", reason)],
      "プルダウンで選ぶか、下のボタンを押した回数だけ足せます。"),
    group("公開範囲", [h("div", { class: "cell" }, visibility), visSetCell], visFooter),
    h("button", { class: "btn-filled", type: "submit" }, "ポイントを付ける"),
  );

  // ---- ポイント交換（渡す側 −N、受け取る側 +N を1組で記録する）
  const xKind = segmented([{ value: "user", label: "個人間" }, { value: "team", label: "チーム間" }]);
  const xFrom = h("select", { "aria-label": "渡す側" });
  const xTo = h("select", { "aria-label": "受け取る側" });
  const xAmount = h("input", { type: "number", step: "any", min: "0", placeholder: "0", inputmode: "decimal", class: "delta-input" });
  const xReason = h("input", { type: "text", maxlength: "200", placeholder: "食料と交換" });
  const xVis = segmented([]);
  const xSet = h("select", { "aria-label": "どのチーム表のチーム内か" });
  const xSetCell = field("チーム表", xSet);
  const xFooter = h("span");

  const refreshTransfer = () => {
    const opts = xKind.value === "team" ? teamOptions() : sortedMembers().map((m) => ({ value: m.id, label: m.name }));
    fillSelect(xFrom, opts, "選択");
    fillSelect(xTo, opts, "選択");
    xSetCell.hidden = !(xKind.value === "user" && xVis.value === "team");
    fillSelect(xSet, sortedSets().map((s) => ({ value: s.id, label: s.name })));
    xFooter.textContent = {
      public: "やり取りが全員に見えます。",
      team: "それぞれのチームに、自分たちの側の記録だけが見えます。",
      private: "渡した人・受け取った人の本人だけに見えます。",
    }[xVis.value] ?? "";
  };
  const refreshXVis = () => {
    xVis.setOptions(xKind.value === "team"
      ? [{ value: "public", label: "全員" }, { value: "team", label: "チーム内" }]
      : [{ value: "public", label: "全員" }, { value: "team", label: "チーム内" }, { value: "private", label: "本人のみ" }]);
  };
  refreshXVis();
  xKind.addEventListener("change", () => { xFrom.value = xTo.value = ""; refreshXVis(); refreshTransfer(); });
  xVis.addEventListener("change", refreshTransfer);

  const transferForm = h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      const kindV = xKind.value;
      const from = xFrom.value, to = xTo.value;
      if (!from || !to) return toast("渡す側と受け取る側を選んでください", true);
      if (from === to) return toast("同じ相手には渡せません", true);
      const n = Number(xAmount.value);
      if (!Number.isFinite(n) || n <= 0) return toast("1以上の数値を入れてください", true);
      if (kindV === "team" && S.teams.get(from)?.setId !== S.teams.get(to)?.setId
        && !confirm("別々のチーム表のチーム同士です。このまま登録しますか？")) return;

      const vis = xVis.value;
      const teamIdOf = (id) => {
        if (kindV === "team") return id;
        return vis === "team" ? teamOfIn(id, xSet.value) : null;
      };
      const fromTeam = teamIdOf(from), toTeam = teamIdOf(to);
      if (vis === "team" && (!fromTeam || !toTeam)) {
        return toast(`「${S.sets.get(xSet.value)?.name ?? "そのチーム表"}」でチームに入っていない人がいます`, true);
      }
      const name = (id) => (kindV === "team" ? teamName(id) : memberName(id));
      const balance = sum(merged(S.logSrc).filter((l) => l.kind === kindV && l.target === from));
      if (balance - n < 0 && !confirm(`${name(from)} の残りは ${balance}pt です。渡すとマイナスになりますが、登録しますか？`)) return;

      const transferId = doc(collection(db, "pointLogs")).id;
      const base = { kind: kindV, visibility: vis, reason: xReason.value.trim(), createdAt: serverTimestamp(), author: emailToId(S.user.email), transferId, counterKind: kindV };
      const b = writeBatch(db);
      b.set(doc(collection(db, "pointLogs")), { ...base, target: from, teamId: fromTeam, delta: -n, counterId: to });
      b.set(doc(collection(db, "pointLogs")), { ...base, target: to, teamId: toTeam, delta: n, counterId: from });
      fire(b.commit(), `${name(from)} → ${name(to)} に ${n}pt 移しました`);
      xReason.value = "";
      xAmount.value = "";
      xAmount.dispatchEvent(new Event("input"));
    },
  },
    group("ポイント交換", [
      h("div", { class: "cell" }, xKind),
      field("渡す側", xFrom),
      field("受け取る側", xTo),
      ...amountPicker(xAmount, [1, 2, 3, 5, 10, 15, 20, 30, 50, 100]),
      h("div", { class: "cell" }, quickButtons(xAmount, [1, 3, 5, 10])),
      field("理由", xReason),
    ], "渡す側から引いて、受け取る側に同じだけ足します。取り消すと両方まとめて元に戻ります。"),
    group("交換の公開範囲", [h("div", { class: "cell" }, xVis), xSetCell], xFooter),
    h("button", { class: "btn-filled", type: "submit" }, icon("arrows"), "交換を登録"),
  );

  const el = h("div", null,
    largeTitle("ポイント"),
    fold("ポイントを付ける", form, true),
    fold("ポイント交換", transferForm, false),
    summary,
    h("section", { class: "group" }, h("div", { class: "group-header" }, "履歴"), list),
  );

  const breakdown = (ls, keys) => keys.map((k) => `${{ public: "公開", team: "チーム内", private: "本人" }[k]} ${sum(ls.filter((l) => l.visibility === k))}`).join(" · ");
  const totalCell = (labelEl, ls, keys) => h("div", { class: "cell" },
    h("div", { class: "cell-main" }, labelEl, h("div", { class: "cell-sub" }, breakdown(ls, keys))),
    h("div", { class: "rank-value" }, sum(ls), h("small", null, " pt")));

  return {
    el,
    update() {
      refreshForm();
      refreshTransfer();
      const logs = merged(S.logSrc).sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
      const setGroups = sortedSets().map((s) => {
        const teams = teamsInSet(s.id);
        return group(`${s.name} の集計`, teams.length
          ? teams.map((t) => totalCell(h("span", { class: "team-label" }, dot(t.color), t.name), logs.filter((l) => l.kind === "team" && l.target === t.id), ["public", "team"]))
          : none("チームがありません"));
      });
      const ms = sortedMembers();
      summary.replaceChildren(
        ...setGroups,
        group("個人の集計", ms.length
          ? ms.map((m) => totalCell(m.name, logs.filter((l) => l.kind === "user" && l.target === m.id), ["public", "team", "private"]))
          : none("参加者がいません"), "集計は管理者にだけ表示されます。"),
      );
      list.replaceChildren(...(logs.length ? logs.slice(0, 200).map((l) => logCell(l, { admin: true })) : [none()]));
    },
  };
}

// ---------------------------------------------------------------- 画面の組み立て
//
// スマホ：下のタブで画面を切り替える
// PC（幅 1100px 以上）：お知らせ・チーム・ポイントを横に並べた1画面のダッシュボード。参加者と設定は小窓で開く

// sheet: 小窓で開く / desktopOnly: PC の列だけ / mobileOnly: スマホのタブだけ
const MEMBER_TABS = [
  { key: "home", icon: "megaphone", label: "お知らせ", view: memberHome },
  { key: "team", icon: "flag", label: "チーム", view: memberTeam },
  { key: "points", icon: "trophy", label: "ポイント", view: memberPoints },
  { key: "notes", icon: "note", label: "表・メモ", view: () => notesView() },
  { key: "map", icon: "map", label: "地図", view: mapView, sheet: true },
  { key: "settings", icon: "gear", label: "設定", view: settingsView, sheet: true },
];
const ADMIN_TABS = [
  { key: "home", icon: "megaphone", label: "お知らせ", view: adminAnnouncements },
  { key: "team", icon: "flag", label: "チーム", view: adminTeams },
  { key: "points", icon: "trophy", label: "ポイント", view: adminPoints },
  { key: "side", icon: "note", label: "表・メモ", view: adminSide, desktopOnly: true },
  { key: "notes", icon: "note", label: "表・メモ", view: () => notesView({ admin: true }), mobileOnly: true },
  { key: "members", icon: "people", label: "参加者", view: adminMembers, mobileOnly: true },
  { key: "map", icon: "map", label: "地図", view: mapView, sheet: true },
  { key: "settings", icon: "gear", label: "設定", view: settingsView, sheet: true },
];

const desktopQuery = window.matchMedia("(min-width: 1100px)");
desktopQuery.addEventListener("change", () => { shell = null; S.sheet = null; scheduleRender(); });

let shell = null;
let renderQueued = false;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

// 参加者用：所属チームと所持ポイントを右上に常に表示する
function meChip() {
  const el = h("div", { class: "me-chip", "aria-label": "あなたの所属チームとポイント" });
  el.paint = () => {
    const uid = S.user.uid;
    const teams = sortedSets().map((s) => S.teams.get(teamOfIn(uid, s.id))).filter(Boolean);
    const points = sum(merged(S.logSrc).filter((l) => l.kind === "user" && l.target === uid));
    el.replaceChildren(
      ...teams.map((t) => h("span", { class: "me-team", title: teamName(t.id) }, dot(t.color), t.name)),
      h("span", { class: "me-points" }, points, h("small", null, "pt")),
    );
  };
  return el;
}

function statusBar() {
  return h("div", { class: "status", hidden: true });
}

function paintStatus(status) {
  const offline = !navigator.onLine || Object.values(S.meta).some((m) => m.cache);
  const pending = Object.values(S.meta).some((m) => m.pending);
  status.hidden = !offline && !pending;
  status.replaceChildren(
    icon(pending ? "clock" : "wifiOff"),
    pending ? "未送信の変更があります。電波が戻ると自動で送信されます。" : "オフライン — 最後に受信した内容を表示しています",
  );
}

function buildMobileShell(allTabs) {
  const tabs = allTabs.filter((t) => !t.sheet && !t.desktopOnly);
  const sheetTabs = allTabs.filter((t) => t.sheet);
  const navTitle = h("div", { class: "nav-title" });
  const appName = h("div", { class: "app-name" });
  const status = statusBar();
  const main = h("main");
  const nav = h("nav", { class: "tabbar" }, tabs.map((t) =>
    h("button", {
      "data-tab": t.key,
      onclick: () => {
        if (S.tab === t.key) return window.scrollTo({ top: 0, behavior: "smooth" });
        S.tab = t.key; shell.view = null; scheduleRender(); window.scrollTo(0, 0);
      },
    }, icon(t.icon), h("span", null, t.label))));
  const chip = S.isAdmin ? null : meChip();
  const gears = h("div", { class: "nav-left" }, sheetTabs.map((t) => h("button", { class: "nav-gear", "data-sheet": t.key, "aria-label": t.label, onclick: () => openSheet(t) }, icon(t.icon))));
  const header = h("header", { class: "navbar" }, gears, navTitle, S.isAdmin ? h("span", { class: "badge" }, "管理者") : chip);
  const root = h("div", { class: "shell" }, header, h("div", { class: "page" }, appName, status, main), nav);
  // 大きな見出しが隠れたら、ナビゲーションバーに小さい見出しを出す（iOS の Large Title と同じ動き）
  const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 44);
  window.addEventListener("scroll", onScroll, { passive: true });
  return {
    root,
    update() {
      appName.textContent = S.config.title || APP_TITLE;
      paintStatus(status);
      chip?.paint();
      const tab = tabs.find((t) => t.key === S.tab) ?? tabs[0];
      navTitle.textContent = tab.label;
      for (const b of nav.children) {
        const active = b.dataset.tab === tab.key;
        b.classList.toggle("active", active);
        if (active) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
      }
      if (!this.view) {
        this.view = tab.view();
        main.replaceChildren(this.view.el);
      }
      this.view.update();
      paintSheet();
    },
  };
}

function openSheet(tab) {
  const view = tab.view({ withTitle: false });
  S.sheet = { key: tab.key, title: tab.label, view };
  scheduleRender();
}

function closeSheet() {
  if (!S.sheet && !document.querySelector(".sheet-backdrop")) return;
  S.sheet?.view.destroy?.();
  S.sheet = null;
  sheetKey = null;
  document.querySelector(".sheet-backdrop")?.remove();
  scheduleRender();
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.sheet) closeSheet(); });

// 小窓（PC の参加者・設定、スマホ参加者の設定）を描く
let sheetKey = null;
function paintSheet() {
  if (S.sheet?.key === "map" && !mapAllowed()) closeSheet();
  if (!S.sheet) { sheetKey = null; return; }
  if (sheetKey !== S.sheet.key || !document.querySelector(".sheet-backdrop")) {
    document.querySelector(".sheet-backdrop")?.remove();
    sheetKey = S.sheet.key;
    const backdrop = h("div", { class: "sheet-backdrop", onclick: (e) => { if (e.target === backdrop) closeSheet(); } },
      h("div", { class: `sheet sheet-${S.sheet.key}`, role: "dialog", "aria-modal": "true", "aria-label": S.sheet.title },
        h("div", { class: "sheet-head" },
          h("div", { class: "sheet-title" }, S.sheet.title),
          h("button", { class: "text-btn", onclick: closeSheet }, "閉じる")),
        h("div", { class: "sheet-body" }, S.sheet.view.el)));
    document.body.append(backdrop);
  }
  S.sheet.view.update();
}

function buildDesktopShell(tabs) {
  const panels = tabs.filter((t) => !t.sheet && !t.mobileOnly);
  const views = panels.map((t) => t.view());
  const title = h("div", { class: "desk-title" });
  const status = statusBar();
  const chip = S.isAdmin ? null : meChip();
  const actions = h("div", { class: "desk-actions" },
    tabs.filter((t) => t.sheet).map((t) => h("button", { class: "desk-btn", "data-sheet": t.key, onclick: () => openSheet(t) }, icon(t.icon), t.label)));
  const header = h("header", { class: "desk-bar" },
    h("img", { class: "desk-icon", src: "icon-192.png", alt: "" }), title,
    S.isAdmin ? h("span", { class: "badge static" }, "管理者") : null,
    status, h("div", { class: "desk-right" }, chip, actions));
  const grid = h("main", { class: `desk-grid cols-${panels.length}` },
    views.map((v, i) => h("section", { class: "panel", "data-panel": panels[i].key }, v.el)));
  const root = h("div", { class: "desk" }, header, grid);
  return {
    root,
    update() {
      title.textContent = S.config.title || APP_TITLE;
      paintStatus(status);
      chip?.paint();
      views.forEach((v) => v.update());
      paintSheet();
    },
  };
}

// 参加者のスマホ：タブを使わず1ページにまとめる。上部のボタンで各セクションへ移動する
function buildMemberPageShell() {
  const sections = [
    { key: "home", label: "お知らせ", view: memberHome({ compact: true }) },
    { key: "team", label: "チーム", view: memberTeam({ compact: true }) },
    { key: "points", label: "ポイント", view: memberPoints({ compact: true }) },
    { key: "notes", label: "表・メモ", view: notesView({ compact: true }) },
  ];
  const summary = memberSummary();
  const chip = meChip();
  const navTitle = h("div", { class: "nav-title" });
  const gear = h("div", { class: "nav-left" }, MEMBER_TABS.filter((t) => t.sheet).map((t) =>
    h("button", { class: "nav-gear", "data-sheet": t.key, "aria-label": t.label, onclick: () => openSheet(t) }, icon(t.icon))));
  const header = h("header", { class: "navbar" }, gear, navTitle, chip);
  const title = h("h1", { class: "large-title" });
  const status = statusBar();
  const jump = h("nav", { class: "jump", "aria-label": "セクションへ移動" }, h("div", { class: "seg" }, sections.map((sec) =>
    h("button", {
      type: "button", "data-jump": sec.key,
      onclick: () => document.getElementById(`sec-${sec.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    }, sec.label))));
  const main = h("main", null, sections.map((sec) => h("section", { class: "page-section", id: `sec-${sec.key}` }, sec.view.el)));
  const root = h("div", { class: "shell single" }, header, h("div", { class: "page" }, title, status, summary.el, jump, main));

  // スクロール位置に合わせて、上部のボタンの選択状態とナビゲーションバーの表示を変える
  const onScroll = () => {
    header.classList.toggle("scrolled", window.scrollY > 44);
    let current = sections[0].key;
    for (const sec of sections) {
      const el = document.getElementById(`sec-${sec.key}`);
      if (el && el.getBoundingClientRect().top < 160) current = sec.key;
    }
    // 一番下まで来たら（それ以上スクロールできないので）最後の欄を選択中にする
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = sections[sections.length - 1].key;
    for (const b of jump.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.jump === current));
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  requestAnimationFrame(onScroll);

  return {
    root,
    update() {
      const t = S.config.title || APP_TITLE;
      title.textContent = t;
      navTitle.textContent = t;
      paintStatus(status);
      chip.paint();
      summary.update();
      sections.forEach((sec) => sec.view.update());
      paintSheet();
    },
  };
}

function paintMapButtons() {
  for (const b of document.querySelectorAll("[data-sheet=map]")) b.hidden = !mapAllowed();
}

function render() {
  if (!S.authReady) return;
  if (!S.user) {
    shell = null;
    closeSheet();
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
  if (!shell) {
    closeSheet();
    if (desktopQuery.matches) shell = buildDesktopShell(S.isAdmin ? ADMIN_TABS : MEMBER_TABS);
    else shell = S.isAdmin ? buildMobileShell(ADMIN_TABS) : buildMemberPageShell();
    $app.replaceChildren(shell.root);
  }
  document.title = S.config.title || APP_TITLE;
  shell.update();
  paintMapButtons();
}

const $app = document.getElementById("app");

if ("serviceWorker" in navigator && !USE_EMULATOR) {
  navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW", e));
}
