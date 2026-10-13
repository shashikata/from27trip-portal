import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, initializeAuth, inMemoryPersistence, connectAuthEmulator,
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, updatePassword, EmailAuthProvider, reauthenticateWithCredential,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  collection, doc, query, where, onSnapshot, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  writeBatch, serverTimestamp, arrayUnion, increment, orderBy, limit,
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

// ---------------------------------------------------------------- データの置き場所（旅行＝プロファイルごと）
// 1つ目の旅行（pid = "root"）はルート直下、2つ目以降は profiles/{pid}/ の下に同じ形で置く
const ROOT = "root";
const base = () => (S.pid && S.pid !== ROOT ? ["profiles", S.pid] : []);
const C = (name) => collection(db, ...base(), name);
const D = (name, ...ids) => doc(db, ...base(), name, ...ids);

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
  pid: null,                 // 開いている旅行（プロファイル）。null = 参加者が選ぶ前
  profiles: new Map(),       // 管理者：旅行の一覧 profiles/{pid}
  myProfiles: [],            // 参加者：自分が入っている旅行 [{ id, name }]
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
  locations: new Map(),      // 参加者の現在地 locations/{uid}
  quizzes: new Map(),        // 管理者：クイズ quizzes/{id}
  live: null,                // 進行中のクイズ live/quiz
  quizAnswers: new Map(),    // 表示中の問題への解答 quizAnswers/{quizId}_{index}_{uid}
  acks: new Map(),           // 「見ました」 acks/{annId}_{uid}（参加者は自分の分だけ）
  annSrc: {},                // クエリごとのお知らせ（後で合成）
  logSrc: {},                // クエリごとのポイント履歴（後で合成）
  stats: null,               // ポイントの合計 stats/points（参加者は履歴を全部は読まず、合計はここから出す）
  feedRaw: {},               // 参加者：最近のお知らせ・ポイント（自分に関係するものだけ annSrc / logSrc に入れる）
  annLimit: 50,              // 参加者が読み込むお知らせの件数（「過去の分を読み込む」で増える）
  logLimit: 150,             // 参加者が読み込むポイント履歴の件数
  meta: {},                  // クエリごとの fromCache / hasPendingWrites
  tab: "home",
  sheet: null,               // PC 版で開いている小窓 { key, title, view }
};

const subs = new Map();
let DATA_VER = 0; // データが変わるたびに増える（計算結果の使い回しに使う）

// データが変わるまで計算結果を使い回す
function memo(fn) {
  let ver = -1, val;
  return (...args) => {
    if (args.length) return fn(...args);
    if (ver !== DATA_VER) { val = fn(); ver = DATA_VER; }
    return val;
  };
}
if (USE_EMULATOR) window.__S = S; // テスト用

// 頻繁に更新されるデータは、関係する所だけ描き直す（全体を描き直すと人数・件数が増えたときに重くなる）
//   loc  : 位置（地図だけ）
//   quiz : クイズの進行・解答（クイズの画面だけ）
const RENDER_KIND = { locations: "loc", live: "quiz", quizAnswers: "quiz" };

function listen(key, ref, onData) {
  if (subs.has(key)) return;
  const unsub = onSnapshot(
    ref,
    { includeMetadataChanges: true },
    (snap) => {
      const meta = { cache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites };
      const prev = S.meta[key];
      S.meta[key] = meta;
      // 中身も通信状態も変わっていない通知（メタデータだけの通知）は描き直さない
      const changed = typeof snap.docChanges === "function" ? snap.docChanges({ includeMetadataChanges: false }).length > 0 : true;
      const metaChanged = !prev || prev.cache !== meta.cache || prev.pending !== meta.pending;
      if (!changed && !metaChanged && prev) return;
      DATA_VER++;
      onData(snap);
      scheduleRender(metaChanged ? "all" : RENDER_KIND[key] ?? "all");
    },
    (err) => {
      console.warn(`[${key}]`, err.code, err.message);
      DATA_VER++;
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
  DATA_VER++;
}

function unlistenAll() {
  for (const key of [...subs.keys()]) unlisten(key);
}

const toMap = (snap) => {
  const m = new Map();
  snap?.forEach((d) => m.set(d.id, { id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
  return m;
};

const mergedCache = new WeakMap();
const merged = (src) => {
  const hit = mergedCache.get(src);
  if (hit && hit.ver === DATA_VER) return [...hit.list];
  const m = new Map();
  for (const part of Object.values(src)) for (const [k, v] of part) m.set(k, v);
  const list = [...m.values()];
  mergedCache.set(src, { ver: DATA_VER, list });
  return [...list];
};

// ---------------------------------------------------------------- データ購読

function startAdmin() {
  const pid = S.pid;
  ensureRootProfile().catch((e) => console.warn(e));
  getDoc(D("config", "app"))
    .then(async (d) => {
      const reg = await getDoc(doc(db, "profiles", pid)).catch(() => null);
      if (!d.exists()) await setDoc(D("config", "app"), { title: reg?.data()?.name ?? APP_TITLE });
    })
    .then(() => (pid === ROOT ? migrateLegacyTeams() : null))
    .then(backfillAccounts)
    .catch((e) => console.warn(e));
  listen("config", D("config", "app"), (s) => { if (s?.exists()) S.config = { ...S.config, ...s.data() }; });
  listen("members", C("members"), (s) => { S.members = toMap(s); });
  listen("sets", C("teamSets"), (s) => { S.sets = toMap(s); });
  listen("teams", C("teams"), (s) => { S.teams = toMap(s); });
  listen("memberships", C("memberships"), (s) => { S.memberships = toMap(s); });
  listen("ann", C("announcements"), (s) => { S.annSrc.all = toMap(s); });
  listen("logs", C("pointLogs"), (s) => { S.logSrc.all = toMap(s); scheduleStatsHeal(); });
  listen("stats", D("stats", "points"), (s) => { S.stats = s?.exists() ? s.data() : null; scheduleStatsHeal(); });
  listen("acks", C("acks"), (s) => { S.acks = toMap(s); });
  listen("notes", C("notes"), (s) => { S.notes = toMap(s); });
  listen("quizzes", C("quizzes"), (s) => { S.quizzes = toMap(s); });
  listenLiveQuiz();
}

// 1つ目の旅行（ルート直下のデータ）を、旅行の一覧に必ず登録しておく。
// どの旅行を開いているときでも確認する（以前は七日島を開いたときだけだったため、
// ルートが一覧に載らず、切り替えられなくなることがあった）
async function ensureRootProfile() {
  const reg = await getDoc(doc(db, "profiles", ROOT));
  if (reg.exists()) return;
  const cfg = await getDoc(doc(db, "config", "app")).catch(() => null);
  await setDoc(doc(db, "profiles", ROOT), { name: cfg?.data()?.title ?? APP_TITLE, order: 0 });
}

// アカウント一覧（accounts/{loginId} → uid）が無い古いアカウントを登録する。
// 旅行をまたいで同じ ID を使い回すときに、ID から uid を引くために使う
async function backfillAccounts() {
  const [rootMembers, accounts] = await Promise.all([getDocs(collection(db, "members")), getDocs(collection(db, "accounts"))]);
  const known = new Set(accounts.docs.map((d) => d.id));
  const missing = rootMembers.docs.filter((d) => d.data().loginId && !known.has(d.data().loginId));
  if (!missing.length) return;
  const b = writeBatch(db);
  missing.forEach((d) => b.set(doc(db, "accounts", d.data().loginId), { uid: d.id, name: d.data().name ?? d.data().loginId }));
  await b.commit();
}

// 旧版（チーム表が1つだけ）で作ったチームと振り分けを「チーム表1」に移す
async function migrateLegacyTeams() {
  const [asg, teamsSnap, cfg] = await Promise.all([
    getDocs(C("assignments")),
    getDocs(C("teams")),
    getDoc(D("config", "app")),
  ]);
  const memSnap = await getDocs(C("memberships"));
  const noHidden = memSnap.docs.filter((d) => typeof d.data().hidden !== "boolean");
  if (noHidden.length) {
    const b0 = writeBatch(db);
    noHidden.forEach((d) => b0.update(d.ref, { hidden: false }));
    await b0.commit();
  }
  const legacy = teamsSnap.docs.filter((d) => !d.data().setId);
  if (!legacy.length && asg.empty) return;
  const published = !!cfg.data()?.teamsPublished;
  const setRef = doc(C("teamSets"));
  const legacyIds = new Set(legacy.map((d) => d.id));
  const b = writeBatch(db);
  if (legacy.length) b.set(setRef, { name: "チーム表1", order: Date.now(), published });
  legacy.forEach((t) => b.update(t.ref, { setId: setRef.id, published }));
  asg.forEach((a) => {
    const teamId = a.data().teamId;
    if (legacyIds.has(teamId)) b.set(D("memberships", `${teamId}_${a.id}`), { teamId, uid: a.id, setId: setRef.id, published, hidden: false });
    b.delete(a.ref);
  });
  await b.commit();
}

function startMember(uid) {
  listen("me", D("members", uid), (s, err) => {
    S.me = err ? null : (s.exists() ? s.data() : null);
    if (S.me) startMemberData(uid);
  });
}

function startMemberData(uid) {
  const ann = C("announcements");
  const logs = C("pointLogs");
  const published = (name) => query(C(name), where("published", "==", true));
  listen("config", D("config", "app"), (s) => {
    if (s?.exists()) S.config = { ...S.config, ...s.data() };
    syncLocationSharing();
  });
  listen("members", C("members"), (s) => { if (s) S.members = toMap(s); });
  // セキュリティルールは「フィルタ」ではないので、読める範囲に合わせてクエリを分ける
  listen("sets", published("teamSets"), (s) => { S.sets = toMap(s); });
  listen("teams", published("teams"), (s) => { S.teams = toMap(s); });
  const memRef = C("memberships");
  const memUpdate = () => { S.memberships = new Map([...(S.memSrc.vis ?? []), ...(S.memSrc.mine ?? [])]); refreshFeed(uid); };
  listen("membershipsVisible", query(memRef, where("published", "==", true), where("hidden", "==", false)), (s) => { S.memSrc.vis = toMap(s); memUpdate(); });
  listen("membershipsMine", query(memRef, where("published", "==", true), where("uid", "==", uid)), (s) => { S.memSrc.mine = toMap(s); memUpdate(); });
  listen("acks", query(C("acks"), where("uid", "==", uid)), (s) => { if (s) S.acks = toMap(s); });
  listen("notes", query(C("notes"), where("shared", "==", true)), (s) => { if (s) S.notes = toMap(s); });
  listenLiveQuiz();
  listen("stats", D("stats", "points"), (s) => { S.stats = s?.exists() ? s.data() : null; });
  listen("annPinned", query(ann, where("pinned", "==", true)), (s) => { S.feedRaw.pinned = toMap(s); refreshFeed(uid); });
  listenRecent(uid);
}

// 参加者：お知らせとポイント履歴は「新しい順に N 件」だけ受け取る。
// 全件を受け取ると、アプリを開くたび（30分以上あくと）に全件分の読み取りが発生し、無料枠（5万回/日）を圧迫するため。
// 合計ポイントは stats/points から出すので、古い履歴を読まなくても正しい。
function listenRecent(uid) {
  listen("annRecent", query(C("announcements"), orderBy("createdAt", "desc"), limit(S.annLimit)), (s) => { S.feedRaw.ann = toMap(s); refreshFeed(uid); });
  listen("logRecent", query(C("pointLogs"), orderBy("createdAt", "desc"), limit(S.logLimit)), (s) => { S.feedRaw.log = toMap(s); refreshFeed(uid); });
}

// 過去の分も読み込む（参加者）
function loadOlder() {
  const uid = S.user.uid;
  S.annLimit += 50;
  S.logLimit += 150;
  unlisten("annRecent");
  unlisten("logRecent");
  listenRecent(uid);
}
const mayHaveOlder = () => !S.isAdmin && ((S.feedRaw.ann?.size ?? 0) >= S.annLimit || (S.feedRaw.log?.size ?? 0) >= S.logLimit);

// 受け取ったお知らせ・ポイントのうち、自分が見てよいものだけを残す（宛先・公開範囲は画面側で判定する）
function refreshFeed(uid) {
  const teams = new Set(myTeamIds(uid));
  const annOk = (a) => a.scope === "all" || (a.scope === "user" && a.target === uid) || (a.scope === "team" && teams.has(a.target));
  const logOk = (l) => l.visibility === "public" || (l.visibility === "private" && l.target === uid) || (l.visibility === "team" && teams.has(l.teamId));
  const keep = (m, ok) => new Map([...(m ?? [])].filter(([, v]) => ok(v)));
  S.annSrc = { pinned: keep(S.feedRaw.pinned, annOk), recent: keep(S.feedRaw.ann, annOk) };
  S.logSrc = { recent: keep(S.feedRaw.log, logOk) };
  DATA_VER++;
}

// ---- ポイントの合計（stats/points）
//   { u: { uid: { public, team, private } }, t: { teamId: { public, team } } }
// ポイントを付ける・取り消すときに、同じ書き込み（バッチ）で増減させる。
// さらに、全履歴を持っている管理者の端末が「履歴から計算した合計」と食い違っていないかを確かめ、ずれていれば直す。

function statsOf(logs, sign = 1) {
  const acc = {};
  for (const l of logs) {
    const d = sign * (Number(l.delta) || 0);
    if (!d || !l.target || !l.visibility) continue;
    const k = l.kind === "team" ? "t" : "u";
    const e = ((acc[k] ??= {})[l.target] ??= {});
    e[l.visibility] = (e[l.visibility] ?? 0) + d;
  }
  return acc;
}

// バッチに「合計の増減」を追加する
function addStats(b, logs, sign = 1) {
  const acc = statsOf(logs, sign);
  if (!Object.keys(acc).length) return;
  const patch = {};
  for (const k in acc) for (const id in acc[k]) for (const v in acc[k][id]) ((patch[k] ??= {})[id] ??= {})[v] = increment(acc[k][id][v]);
  b.set(D("stats", "points"), patch, { merge: true });
}

const statsKey = (st) => JSON.stringify(["u", "t"].flatMap((k) => Object.entries(st?.[k] ?? {}).flatMap(([id, e]) =>
  Object.entries(e ?? {}).filter(([, n]) => Number(n)).map(([v, n]) => `${k}.${id}.${v}=${Number(n)}`))).sort());

let healTimer = null;
function scheduleStatsHeal() {
  clearTimeout(healTimer);
  healTimer = setTimeout(healStats, 2500);
}
function healStats() {
  if (!S.isAdmin) return;
  const a = S.meta.logs, b = S.meta.stats;
  // サーバーから届いた最新の状態どうしで、送信中の変更がないときだけ比べる
  if (!a || !b || a.cache || a.pending || b.cache || b.pending) return;
  const want = statsOf(merged(S.logSrc));
  if (statsKey(want) === statsKey(S.stats)) return;
  setDoc(D("stats", "points"), want).catch((e) => console.warn("stats", e));
}

// 合計ポイント。参加者は stats から、管理者は手元の全履歴から計算する（stats がまだ無い旅行でも動くように）
function ptTotal(kind, id, vis) {
  if (!S.isAdmin && S.stats) {
    const e = S.stats[kind === "team" ? "t" : "u"]?.[id] ?? {};
    return vis ? Number(e[vis]) || 0 : Object.values(e).reduce((x, n) => x + (Number(n) || 0), 0);
  }
  return sum(merged(S.logSrc).filter((l) => l.kind === kind && l.target === id && (!vis || l.visibility === vis)));
}

// 旅行ごとに持つデータを空に戻す（旅行を切り替えるとき・ログアウトしたとき）
function resetProfileData() {
  DATA_VER++;
  Object.assign(S, {
    me: undefined, config: { title: APP_TITLE },
    members: new Map(), sets: new Map(), teams: new Map(), memberships: new Map(), memSrc: {}, acks: new Map(), notes: new Map(), locations: new Map(),
    annSrc: {}, logSrc: {}, meta: {}, tab: "home", stats: null, feedRaw: {}, annLimit: 50, logLimit: 150,
    quizzes: new Map(), live: null, quizAnswers: new Map(),
  });
  QZ.answersKey = null;
}

const pidKey = () => `island.pid.${S.user?.uid}`;
const savedPid = () => { try { return localStorage.getItem(pidKey()); } catch { return null; } };
const savePid = (pid) => { try { localStorage.setItem(pidKey(), pid); } catch { /* 保存できなくても動く */ } };

function startProfile() {
  if (S.isAdmin) {
    startAdmin();
    listen("profiles", collection(db, "profiles"), (s) => { if (s) S.profiles = toMap(s); });
  } else {
    startMember(S.user.uid);
  }
}

// 旅行を切り替える（管理者も参加者も）
function switchProfile(pid) {
  if (!pid || pid === S.pid) return;
  closeSheet();
  unlistenAll();
  if (!S.isAdmin && LOC.watchId != null) { navigator.geolocation.clearWatch(LOC.watchId); LOC.watchId = null; LOC.lastSent = null; }
  resetProfileData();
  S.pid = pid;
  SHOWN.clear();
  savePid(pid);
  shell = null;
  startProfile();
  scheduleRender();
  window.scrollTo(0, 0);
}

// 参加者が入っている旅行を調べる（members/{uid} があるかどうか）
async function resolveMemberProfiles(uid) {
  const reg = await getDocs(collection(db, "profiles")).catch(() => null);
  const regDocs = reg?.docs ?? [];
  const list = [];
  const rootMem = await getDoc(doc(db, "members", uid)).catch(() => null);
  if (rootMem?.exists()) list.push({ id: ROOT, name: regDocs.find((d) => d.id === ROOT)?.data().name ?? APP_TITLE, order: 0 });
  for (const d of regDocs) {
    if (d.id === ROOT) continue;
    const m = await getDoc(doc(db, "profiles", d.id, "members", uid)).catch(() => null);
    if (m?.exists()) list.push({ id: d.id, name: d.data().name ?? "旅行", order: d.data().order ?? 0 });
  }
  return list.sort((a, b) => a.order - b.order);
}

onAuthStateChanged(auth, async (user) => {
  unlistenAll();
  resetProfileData();
  Object.assign(S, { authReady: true, user, isAdmin: !!user && isAdminEmail(user.email), pid: null, profiles: new Map(), myProfiles: [], sheet: null });
  shell = null;
  syncLocationSharing(); // ログアウトしたら位置の取得を止める
  if (!user) return scheduleRender();
  if (S.isAdmin) {
    S.pid = savedPid() || ROOT;
    startProfile();
    return scheduleRender();
  }
  scheduleRender(); // 「読み込み中」を出す
  const list = await resolveMemberProfiles(user.uid);
  if (S.user !== user) return; // 途中でログアウトした
  S.myProfiles = list;
  const saved = savedPid();
  if (list.some((p) => p.id === saved)) S.pid = saved;
  else if (list.length === 1) S.pid = list[0].id;
  else if (list.length === 0) {
    // 電波がなくて調べられないときは、前回開いていた旅行で試す
    S.pid = saved || ROOT;
  } else S.pid = null; // 複数あるので選んでもらう
  if (S.pid) startProfile();
  scheduleRender();
});

window.addEventListener("online", () => scheduleRender());
window.addEventListener("offline", () => scheduleRender());

// ---------------------------------------------------------------- データの参照

// replaceChildren と同じだが、null / false は飛ばす（そのまま渡すと "null" という文字が出てしまう）
const setKids = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

const byNatural = (a, b) => String(a).localeCompare(String(b), "ja", { numeric: true });
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || byNatural(a.name, b.name);
const sortedMembersMemo = memo(() => [...S.members.entries()].map(([id, m]) => ({ id, ...m })).sort((a, b) => byNatural(a.loginId, b.loginId)));
const sortedMembers = () => [...sortedMembersMemo()];
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
  b.update(D("teamSets", setId), { published });
  teamsInSet(setId).forEach((t) => b.update(D("teams", t.id), { published }));
  membershipsOf((m) => m.setId === setId).forEach((m) => b.update(D("memberships", m.id), { published }));
  return b.commit();
}

// 表向きの所属を変える（スパイの本当のチームと同じになったら、スパイは解除される）
function assignMember(uid, setId, teamId) {
  const b = writeBatch(db);
  membershipsOf((m) => m.uid === uid && m.setId === setId && !m.hidden && m.teamId !== teamId)
    .forEach((m) => b.delete(D("memberships", m.id)));
  if (teamId) {
    b.set(D("memberships", `${teamId}_${uid}`), { teamId, uid, setId, published: !!S.sets.get(setId)?.published, hidden: false });
  }
  return b.commit();
}

// スパイ登録：参加先（表向き）と本当のチームを同時に書く
function setSpy(uid, setId, coverTeamId, trueTeamId) {
  const published = !!S.sets.get(setId)?.published;
  const b = writeBatch(db);
  membershipsOf((m) => m.uid === uid && m.setId === setId && m.teamId !== coverTeamId)
    .forEach((m) => b.delete(D("memberships", m.id)));
  b.set(D("memberships", `${coverTeamId}_${uid}`), { teamId: coverTeamId, uid, setId, published, hidden: false });
  b.set(D("memberships", `${trueTeamId}_${uid}`), { teamId: trueTeamId, uid, setId, published, hidden: true });
  return b.commit();
}

function clearSpy(uid, setId) {
  const b = writeBatch(db);
  membershipsOf((m) => m.uid === uid && m.setId === setId && m.hidden).forEach((m) => b.delete(D("memberships", m.id)));
  return b.commit();
}

function deleteSet(setId) {
  const b = writeBatch(db);
  b.delete(D("teamSets", setId));
  teamsInSet(setId).forEach((t) => b.delete(D("teams", t.id)));
  membershipsOf((m) => m.setId === setId).forEach((m) => b.delete(D("memberships", m.id)));
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
  quiz: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7"/><circle cx="12" cy="17" r=".9" fill="currentColor"/>',
  play: '<path d="M8 5.5v13l10.5-6.5L8 5.5Z"/>',
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
  if (e?.code === "permission-denied" && S.isAdmin) return "権限がありません（Firebase のルールが最新になっているか確認してください）";
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

// 長い一覧は最初の数十件だけ画面に出し、「さらに表示」で増やす（件数が増えても画面が重くならないように）
const SHOWN = new Map(); // 一覧ごとの表示件数
function paged(key, items, step = 30, { older = false } = {}) {
  const n = SHOWN.get(key) ?? step;
  const rest = items.length - n;
  let more = null;
  if (rest > 0) {
    more = h("button", { class: "more-btn", onclick: () => { SHOWN.set(key, n + step * 2); scheduleRender(); } }, `さらに表示（残り ${rest} 件）`);
  } else if (older && mayHaveOlder()) {
    more = h("button", { class: "more-btn", onclick: () => { SHOWN.set(key, n + step * 2); loadOlder(); } }, "過去の分を読み込む");
  }
  return { items: items.slice(0, n), more };
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
        ? deleteDoc(D("acks", ackId))
        : setDoc(D("acks", ackId), { annId: a.id, uid, at: serverTimestamp() })),
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
  b.delete(D("announcements", a.id));
  [...S.acks.values()].filter((x) => x.annId === a.id).forEach((x) => b.delete(D("acks", x.id)));
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
      h("button", { class: "text-btn", onclick: () => fire(updateDoc(D("announcements", a.id), { pinned: !a.pinned })) }, a.pinned ? "固定を解除" : "固定"),
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
    pair.forEach((x) => b.delete(D("pointLogs", x.id)));
    addStats(b, pair, -1);
    fire(b.commit(), "交換を取り消しました");
    return;
  }
  if (!confirm(`「${target} ${signed(l.delta)}（${l.reason || "理由なし"}）」を取り消しますか？`)) return;
  const b = writeBatch(db);
  b.delete(D("pointLogs", l.id));
  addStats(b, [l], -1);
  fire(b.commit(), "取り消しました");
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
  const moveBtn = h("button", { class: "text-btn" });
  moveBtn.addEventListener("click", () => fire(updateDoc(D("notes", n.id), { shared: !n.shared }), n.shared ? "管理者用に移しました" : "全体公開に移しました"));
  const body = h("textarea", { class: "plain", rows: "4", placeholder: "例：ビーチフラッグ 1位 +10 / 2位 +6 / 3位 +3" });
  const grid = h("div", { class: "table-wrap" });
  const saveBtn = h("button", { class: "text-btn", disabled: true }, "保存");
  const markDirty = () => { dirty = true; saveBtn.disabled = false; el.classList.add("dirty"); };
  title.addEventListener("input", markDirty);
  body.addEventListener("input", markDirty);

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
    fire(updateDoc(D("notes", n.id), data), "保存しました");
    dirty = false; saveBtn.disabled = true; el.classList.remove("dirty");
  });

  const el = h("article", { class: "card note editor", "data-note": n.id },
    h("div", { class: "note-head" }, icon(n.type === "table" ? "table" : "note"), title),
    n.type === "table" ? [grid, tableTools] : body,
    h("div", { class: "note-foot" },
      moveBtn,
      h("div", { class: "note-actions" },
        saveBtn,
        h("button", { class: "text-btn destructive", onclick: () => { if (confirm(`「${n.title || "無題"}」を削除しますか？`)) fire(deleteDoc(D("notes", n.id)), "削除しました"); } }, "削除"))),
  );
  return {
    el,
    patch(next) {
      n = next;
      moveBtn.replaceChildren(icon("arrows"), n.shared ? "管理者用へ移す" : "全体公開へ移す");
      el.classList.toggle("shared", !!n.shared);
      if (dirty) return;
      title.value = n.title ?? "";
      if (n.type === "table") { draft = tableRows(n); paintGrid(); } else body.value = n.body ?? "";
    },
  };
}

function notesView({ admin = false, compact = false, withTitle = true } = {}) {
  const add = (type, shared) => fire(addDoc(C("notes"), {
    title: type === "table" ? "新しい表" : "新しいメモ", type, body: "",
    rows: type === "table" ? [{ c: ["", "", ""] }, { c: ["", "", ""] }] : [],
    shared, order: Date.now(),
  }), `${shared ? "全体公開" : "管理者用"}に${type === "table" ? "表" : "メモ"}を追加しました`);

  // 参加者：全体公開の分だけ
  if (!admin) {
    const list = h("div", { class: "stack" });
    return {
      el: h("div", null, withTitle ? sectionTitle("表・メモ", compact) : null, list),
      update() {
        const notes = sortedNotes().filter((n) => n.shared);
        list.replaceChildren(...(notes.length ? notes.map(noteDisplay) : [emptyState("note", "まだありません")]));
      },
    };
  }

  // 管理者：全体公開 と 管理者用 の2つの欄
  const section = (shared) => {
    const list = h("div", { class: "stack" });
    const empty = h("p", { class: "note-empty" }, shared ? "参加者全員に表示されます。ルールやリーグ戦の表などに。" : "管理者だけが見られます。採点の内部メモなどに。");
    const el = h("section", { class: `note-section ${shared ? "public" : "private"}` },
      h("div", { class: "note-section-head" },
        h("h3", null, icon(shared ? "people" : "lock"), shared ? "全体公開" : "管理者用"),
        h("div", { class: "note-add" },
          h("button", { class: "pill", onclick: () => add("memo", shared) }, icon("note"), "メモ"),
          h("button", { class: "pill", onclick: () => add("table", shared) }, icon("table"), "表"))),
      empty, list);
    return {
      el,
      update() {
        const notes = sortedNotes().filter((n) => !!n.shared === shared);
        empty.hidden = notes.length > 0;
        keyedList(list, notes, (n) => noteEditor(n), (row, n) => row.patch(n));
      },
    };
  };
  const pub = section(true);
  const priv = section(false);
  return {
    el: h("div", null, withTitle ? sectionTitle("表・メモ", compact) : null, pub.el, priv.el),
    update() { pub.update(); priv.update(); },
  };
}

// 管理者 PC の4列目：表・メモ ＋ 参加者
function adminSide() {
  const notes = notesView({ admin: true });
  const members = adminMembers({ withTitle: true });
  return { el: h("div", null, notes.el, h("div", { class: "side-gap" }), members.el), update() { notes.update(); members.update(); } };
}

// ---------------------------------------------------------------- 位置の共有（参加者）
// 管理者が「参加者の位置を共有」をオンにしている間、アプリを開いていれば現在地を送る。
// 送るのは 30m 以上動いたとき（ただし 15 秒以上あける）と、止まっていても 2 分に1回。
// 位置は地図を開いている人にしか届かないが、送る回数が多いと Firebase の無料枠（書き込み 2万回/日）を使い切るため間引く。

const LOC = { watchId: null, lastSent: null, lastSentAt: 0, myPos: null, error: null };

function distanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function syncLocationSharing() {
  const uid = S.user?.uid;
  const on = !!(uid && !S.isAdmin && S.me && S.config.locShare && "geolocation" in navigator);
  if (on && LOC.watchId == null) {
    LOC.watchId = navigator.geolocation.watchPosition((pos) => {
      const p = [pos.coords.latitude, pos.coords.longitude];
      LOC.myPos = p; LOC.error = null;
      const now = Date.now();
      if (LOC.lastSent) {
        const since = now - LOC.lastSentAt;
        const moved = distanceM(LOC.lastSent, p) >= 30;
        if (since < 15000 || (!moved && since < 120000)) return;
      }
      LOC.lastSent = p; LOC.lastSentAt = now;
      setDoc(D("locations", uid), { uid, lat: p[0], lng: p[1], acc: Math.round(pos.coords.accuracy), at: serverTimestamp() })
        .catch((e) => console.warn("location", e));
      scheduleRender();
    }, (err) => { LOC.error = err.code; scheduleRender(); }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  } else if (!on && LOC.watchId != null) {
    navigator.geolocation.clearWatch(LOC.watchId);
    LOC.watchId = null; LOC.lastSent = null;
    // 共有をやめたら、自分の位置データを消す
    if (uid && !S.isAdmin) deleteDoc(D("locations", uid)).catch(() => {});
  }
}

const agoText = (x) => {
  const ms = Date.now() - ts(x);
  if (!ts(x)) return "送信中…";
  if (ms < 60000) return "たった今";
  if (ms < 3600000) return `${Math.floor(ms / 60000)}分前`;
  return `${Math.floor(ms / 3600000)}時間前`;
};

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
  const others = new Map(); // uid -> marker
  const people = h("div", { class: "map-people" });
  el.append(people);

  // 他の人の位置（管理者は全員、参加者は設定でオンのときだけ届く）
  const paintOthers = () => {
    const me = S.user?.uid;
    const locs = [...S.locations.values()].filter((l) => l.id !== me && S.members.has(l.id));
    if (map) {
      const alive = new Set();
      for (const l of locs) {
        alive.add(l.id);
        const stale = Date.now() - ts(l.at) > 5 * 60000;
        const name = memberName(l.id);
        const iconEl = window.L.divIcon({ className: "", html: `<div class="pin${stale ? " stale" : ""}"><span></span><b></b></div>`, iconSize: [0, 0] });
        let mk = others.get(l.id);
        if (!mk) { mk = window.L.marker([l.lat, l.lng], { icon: iconEl, keyboard: false }).addTo(map); others.set(l.id, mk); }
        else mk.setLatLng([l.lat, l.lng]).setIcon(iconEl);
        const node = mk.getElement()?.querySelector(".pin b");
        if (node) node.textContent = name;
      }
      for (const [id, mk] of others) if (!alive.has(id)) { mk.remove(); others.delete(id); }
    }
    people.hidden = !locs.length;
    people.replaceChildren(...locs.sort((a, b) => byNatural(memberName(a.id), memberName(b.id))).map((l) => {
      const stale = Date.now() - ts(l.at) > 5 * 60000;
      return h("button", {
        class: `person${stale ? " stale" : ""}`,
        onclick: () => { follow = false; map?.setView([l.lat, l.lng], Math.max(map.getZoom(), 17)); },
      }, h("span", { class: "person-dot" }), memberName(l.id), h("small", null, agoText(l.at)));
    }));
  };

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
  // 位置のデータは地図を開いている間だけ受け取る（全員の位置が動くたびに全員へ届くと、読み取り回数が膨らむため）
  const syncListen = () => {
    if (S.isAdmin || S.config.locAll) listen("locations", C("locations"), (x) => { if (x) S.locations = toMap(x); });
    else if (subs.has("locations")) { unlisten("locations"); S.locations = new Map(); }
  };
  return {
    el,
    update() {
      syncListen();
      paintOthers();
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
        paintOthers();
        if (!("geolocation" in navigator)) { status.textContent = "この端末では現在地を取得できません。"; return; }
        const onErr = (err) => { if (!dot) status.textContent = GEO_ERRORS[err.code] ?? err.message; };
        // 共有用にすでに取れている位置があれば、まずそれを出す
        if (LOC.myPos) show({ coords: { latitude: LOC.myPos[0], longitude: LOC.myPos[1], accuracy: 30 }, timestamp: Date.now() });
        // 開いた直後に1回取りに行き、その後は動きに合わせて更新する
        navigator.geolocation.getCurrentPosition(show, onErr, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
        watchId = navigator.geolocation.watchPosition(show, onErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
        if (last) show({ coords: { latitude: last[0], longitude: last[1], accuracy: 30 }, timestamp: Date.now() });
      }).catch((e) => { status.textContent = e.message; });
    },
    // 小窓を閉じたら位置の取得を止める（電池のため）
    destroy() {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      map?.remove();
      unlisten("locations");
      S.locations = new Map();
    },
  };
}

const mapAllowed = () => S.isAdmin || !!S.config.mapEnabled;

// ---------------------------------------------------------------- 画面：ログイン

function loginView() {
  const id = h("input", { type: "text", autocomplete: "username", autocapitalize: "none", autocorrect: "off", spellcheck: "false", placeholder: "user01", required: true });
  const pw = h("input", { type: "password", autocomplete: "current-password", placeholder: "必須", required: true });
  const btn = h("button", { class: "btn-filled", type: "submit" }, "ログイン");
  return h("div", { class: "login", "data-view": "login" },
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
      const page = paged("feed", [...pinned, ...rest], 30, { older: true });
      setKids(list, page.items.length
        ? page.items.map((x) => (x.type === "ann" ? announcementCard(x.a) : pointNotice(x.l)))
        : emptyState("megaphone", "まだありません", "新しいお知らせやポイントが届くとここに表示されます。"), page.more);
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
      const myTeams = myTeamIds(uid).map((id) => S.teams.get(id)).filter(Boolean)
        .sort((a, b) => byOrder(S.sets.get(a.setId) ?? {}, S.sets.get(b.setId) ?? {}));

      const parts = compact ? [] : [
        statCard("あなた", ptTotal("user", uid), [["全員に公開", ptTotal("user", uid, "public")], ["チーム内", ptTotal("user", uid, "team")], ["本人のみ", ptTotal("user", uid, "private")]]),
      ];
      for (const t of compact ? [] : myTeams) {
        const secret = trueTeamOf(uid, t.setId) === t.id;
        parts.push(statCard(`${teamName(t.id)}${secret ? "（本当のチーム）" : ""}`, ptTotal("team", t.id), [["全員に公開", ptTotal("team", t.id, "public")], ["チーム内のみ", ptTotal("team", t.id, "team")]], t.color));
      }
      const myPage = paged("myHist", mine, 20, { older: true });
      parts.push(group("あなたの履歴", [mine.length ? myPage.items.map((l) => logCell(l, { showTarget: false })) : none(), myPage.more].filter(Boolean)));
      const teamLogs = logs.filter((l) => l.kind === "team" && myTeams.some((t) => t.id === l.target));
      const teamPage = paged("teamHist", teamLogs, 20, { older: true });
      if (myTeams.length) parts.push(group("チームの履歴", [teamLogs.length ? teamPage.items.map((l) => logCell(l)) : none(), teamPage.more].filter(Boolean)));

      fillSelect(rankSel, [{ value: "user", label: "個人" }, ...sortedSets().map((s) => ({ value: s.id, label: `${s.name}（チーム）` }))]);
      const rows = rankSel.value === "user" || !S.sets.has(rankSel.value)
        ? sortedMembers().map((m) => ({ label: m.name, value: ptTotal("user", m.id, "public"), highlight: m.id === uid }))
        : teamsInSet(rankSel.value).map((t) => ({ label: t.name, color: t.color, value: ptTotal("team", t.id, "public"), highlight: myTeams.some((x) => x.id === t.id) }));
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
      const tile = (label, value, color, sub) => h("div", { class: "tile", style: color ? `--c:${color}` : null },
        h("div", { class: "tile-label" }, color ? dot(color) : null, label),
        h("div", { class: "tile-value" }, value, h("small", null, "pt")),
        sub ? h("div", { class: "tile-sub" }, sub) : null);
      const teams = sortedSets().flatMap((s) => [
        { t: S.teams.get(teamOfIn(uid, s.id)), secret: false },
        { t: S.teams.get(trueTeamOf(uid, s.id)), secret: true },
      ]).filter((x) => x.t);
      el.replaceChildren(
        tile("あなた", ptTotal("user", uid)),
        ...teams.map(({ t, secret }) => tile(t.name, ptTotal("team", t.id), t.color,
          secret ? "本当のチーム（あなただけ）" : S.sets.get(t.setId)?.name)),
      );
    },
  };
}

// ---------------------------------------------------------------- 旅行（プロファイル）の管理

const PROFILE_COLLECTIONS = ["config", "members", "teamSets", "teams", "memberships", "assignments", "announcements", "pointLogs", "acks", "notes", "locations", "stats", "quizzes", "quizAnswers", "live"];

const sortedProfiles = () => {
  const list = [...S.profiles.values()];
  if (!S.profiles.has(ROOT)) list.push({ id: ROOT, name: APP_TITLE, order: 0 });
  return list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
};
const profileName = (pid) => S.profiles.get(pid)?.name ?? S.myProfiles.find((p) => p.id === pid)?.name ?? (pid === S.pid ? S.config.title : "旅行");

// 中身が空の旅行を作って、そこに切り替える
async function createProfile() {
  const name = (prompt("新しい旅行の名前（例：2027 夏 沖縄旅行）") ?? "").trim();
  if (!name) return;
  const ref = doc(collection(db, "profiles"));
  const b = writeBatch(db);
  b.set(ref, { name, order: Date.now(), createdAt: serverTimestamp() });
  b.set(doc(db, "profiles", ref.id, "config", "app"), { title: name });
  await b.commit();
  toast(`「${name}」を作りました`);
  switchProfile(ref.id);
}

// 旅行の中身をすべて消す（1つ目の旅行＝ルートは消せない）
async function deleteProfile(pid) {
  if (pid === ROOT) return toast("1つ目の旅行は削除できません", true);
  const name = profileName(pid);
  if (!confirm(`「${name}」を削除しますか？\nお知らせ・チーム・ポイント・参加者の登録など、この旅行のデータがすべて消えます。元に戻せません。`)) return;
  if ((prompt(`確認のため、旅行の名前「${name}」を入力してください`) ?? "").trim() !== name) return toast("名前が一致しないので中止しました", true);
  for (const c of PROFILE_COLLECTIONS) {
    const snap = await getDocs(collection(db, "profiles", pid, c));
    for (let i = 0; i < snap.docs.length; i += 400) {
      const b = writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
      await b.commit();
    }
  }
  await deleteDoc(doc(db, "profiles", pid));
  toast(`「${name}」を削除しました`);
  if (S.pid === pid) switchProfile(ROOT);
}

// 旅行の切り替え一覧（設定の中に出す）
function profilesGroup() {
  const body = h("div");
  return {
    el: body,
    update() {
      const list = S.isAdmin ? sortedProfiles() : S.myProfiles;
      if (!S.isAdmin && list.length < 2) return body.replaceChildren();
      setKids(body, group(S.isAdmin ? "旅行（プロファイル）" : "旅行を切り替える", [
        ...list.map((p) => h("button", {
          class: `cell cell-button profile-row${p.id === S.pid ? " current" : ""}`,
          "data-profile": p.id,
          onclick: () => switchProfile(p.id),
        }, h("span", { class: "profile-name" }, p.name), p.id === S.pid ? h("span", { class: "profile-cur" }, icon("check"), "表示中") : null)),
        S.isAdmin ? h("button", { class: "cell cell-button", onclick: () => guard(null, createProfile) }, icon("plus"), "新しい旅行を作る") : null,
      ], S.isAdmin ? "新しい旅行は中身が空の状態で作られます。参加者のIDは旅行をまたいで使い回せます。" : null));
    },
  };
}

function settingsView({ withTitle = true } = {}) {
  const cur = h("input", { type: "password", autocomplete: "current-password", placeholder: "必須", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", minlength: "6", placeholder: "6文字以上", required: true });
  const btn = h("button", { class: "cell cell-button", type: "submit" }, "パスワードを変更");
  const adminBox = h("div");
  const profiles = profilesGroup();
  const el = h("div", null,
    withTitle ? largeTitle("設定") : null,
    profiles.el,
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
      profiles.update();
      if (!S.isAdmin || built) return;
      built = true;
      const titleInput = h("input", { type: "text", value: S.config.title ?? APP_TITLE });
      const mapSwitch = toggle(!!S.config.mapEnabled);
      const locSwitch = toggle(!!S.config.locShare);
      const locAllSwitch = toggle(!!S.config.locAll);
      locSwitch.addEventListener("change", () => fire(updateDoc(D("config", "app"), { locShare: locSwitch.checked }),
        locSwitch.checked ? "位置の共有をオンにしました" : "位置の共有をオフにしました"));
      locAllSwitch.addEventListener("change", () => fire(updateDoc(D("config", "app"), { locAll: locAllSwitch.checked }),
        locAllSwitch.checked ? "参加者同士でも位置が見えるようにしました" : "位置は管理者だけが見られるようにしました"));
      mapSwitch.addEventListener("change", () => fire(updateDoc(D("config", "app"), { mapEnabled: mapSwitch.checked }),
        mapSwitch.checked ? "参加者に地図を表示しました" : "参加者の地図を非表示にしました"));
      setKids(adminBox, group("企画", [
        field("タイトル", titleInput),
        h("button", {
          class: "cell cell-button",
          onclick: () => {
            const title = titleInput.value.trim() || APP_TITLE;
            fire(updateDoc(D("config", "app"), { title }), "保存しました");
            fire(setDoc(doc(db, "profiles", S.pid), { name: title }, { merge: true }));
          },
        }, "タイトルを保存"),
        field("参加者に地図を表示", mapSwitch),
        field("参加者の位置を共有", locSwitch),
        field("参加者同士でも見られる", locAllSwitch),
      ], "位置の共有をオンにすると、参加者がアプリを開いている間、現在地が30秒ごとに管理者へ届きます。「参加者同士でも見られる」をオンにすると、参加者の地図にも全員が表示されます。共有をオフにすると、位置のデータは消えます。"),
        S.pid !== ROOT ? group(null, h("button", { class: "cell cell-button destructive", onclick: () => guard(null, () => deleteProfile(S.pid)) }, "この旅行を削除")) : null);
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
      fire(addDoc(C("announcements"), {
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
      const page = paged("adminAnn", sortAnnouncements(merged(S.annSrc)), 20);
      setKids(list, page.items.length ? page.items.map((a) => announcementCard(a, { admin: true })) : emptyState("megaphone", "まだありません"), page.more);
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

  // 別の旅行ですでに作った ID なら、新しく作らずにこの旅行へ追加する（パスワードは前と同じ）
  async function createAccount(loginId, displayName, password) {
    const acc = await getDoc(doc(db, "accounts", loginId));
    if (acc.exists()) {
      // まとめて作成（名前が ID のまま）のときは、前の旅行で付けた名前を引き継ぐ
      const name = displayName === loginId && acc.data().name ? acc.data().name : displayName;
      await setDoc(D("members", acc.data().uid), { loginId, name, createdAt: serverTimestamp() });
      created.push({ loginId, name, password: null });
      renderResult();
      return;
    }
    const a2 = getSecondaryAuth();
    const cred = await createUserWithEmailAndPassword(a2, idToEmail(loginId), password);
    await setDoc(doc(db, "accounts", loginId), { uid: cred.user.uid, name: displayName });
    await setDoc(D("members", cred.user.uid), { loginId, name: displayName, createdAt: serverTimestamp() });
    await signOut(a2);
    created.push({ loginId, name: displayName, password });
    renderResult();
  }

  function renderResult() {
    if (!created.length) return result.replaceChildren();
    const text = created.map((c) => `${c.name}\tID: ${c.loginId}\tパスワード: ${c.password ?? "（前と同じ）"}`).join("\n");
    result.replaceChildren(group("作成したアカウント", [
      ...created.map((c) => h("div", { class: "cell cred" },
        h("div", { class: "cell-main" }, c.name, h("div", { class: "cell-sub" }, c.loginId)),
        c.password ? h("div", { class: "mono" }, c.password) : h("div", { class: "secondary small-note" }, "既存のID（パスワードは前と同じ）"))),
      h("button", { class: "cell cell-button", onclick: () => navigator.clipboard.writeText(text).then(() => toast("コピーしました")) }, icon("copy"), "すべてコピー"),
      h("button", { class: "cell cell-button secondary-btn", onclick: () => { if (confirm("パスワードを保存しましたか？表示を消します。")) { created.length = 0; renderResult(); } } }, "表示を消す"),
    ], h("span", { class: "warn" }, "パスワードはこの画面でしか表示されません。必ずコピーして保存してください。別の旅行で作ったIDは、そのまま追加されます（パスワードは前と同じ）。")));
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
      "例：user・1・16 で user01〜user16 を作成します。名前はあとで変更できます。別の旅行で作ったIDは、新しく作らずにこの旅行へ追加します。")),
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
            onclick: () => {
              const name = nm.value.trim() || m.loginId;
              fire(updateDoc(D("members", m.id), { name }), "保存しました");
              fire(setDoc(doc(db, "accounts", m.loginId), { uid: m.id, name }, { merge: true }));
              nm.saved();
            },
          }, "保存"),
          h("button", {
            class: "text-btn destructive",
            onclick: () => {
              const cur = S.members.get(m.id);
              if (!confirm(`${cur?.name}（${m.loginId}）を削除しますか？\nこの人は何も見られなくなります。`)) return;
              const b = writeBatch(db);
              b.delete(D("members", m.id));
              membershipsOf((x) => x.uid === m.id).forEach((x) => b.delete(D("memberships", x.id)));
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
    const ref = doc(C("teamSets"));
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
    membershipsOf((m) => m.setId === setId).forEach((m) => b.delete(D("memberships", m.id)));
    shuffled.forEach((m, i) => {
      const teamId = teams[i % teams.length].id;
      b.set(D("memberships", `${teamId}_${m.id}`), { teamId, uid: m.id, setId, published, hidden: false });
    });
    fire(b.commit(), "振り分けました");
  }

  const detail = h("div", null,
    group("チーム表", [
      field("名前", setName),
      h("button", {
        class: "cell cell-button",
        onclick: () => { fire(updateDoc(D("teamSets", setId), { name: setName.value.trim() || "チーム表" }), "保存しました"); setName.saved(); },
      }, "名前を保存"),
      field("参加者に発表", publish),
    ], publishFooter),
    h("form", {
      onsubmit: (e) => {
        e.preventDefault();
        fire(addDoc(C("teams"), {
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
            onclick: () => { fire(updateDoc(D("teams", t.id), { name: nm.value.trim() || t.name }), "保存しました"); nm.saved(); },
          }, "保存"),
          h("button", {
            class: "text-btn destructive",
            onclick: () => {
              const cur = S.teams.get(t.id);
              if (!confirm(`チーム「${cur?.name}」を削除しますか？所属メンバーは未所属になります。`)) return;
              const b = writeBatch(db);
              b.delete(D("teams", t.id));
              membershipsOf((m) => m.teamId === t.id).forEach((m) => b.delete(D("memberships", m.id)));
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
      const log = {
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
      };
      const b = writeBatch(db);
      b.set(doc(C("pointLogs")), log);
      addStats(b, [log]);
      fire(b.commit(), `${signed(d)} pt を付けました${toTrue ? `（本当のチーム ${S.teams.get(real)?.name} へ）` : ""}`);
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

      const transferId = doc(C("pointLogs")).id;
      const base = { kind: kindV, visibility: vis, reason: xReason.value.trim(), createdAt: serverTimestamp(), author: emailToId(S.user.email), transferId, counterKind: kindV };
      const b = writeBatch(db);
      const pair = [{ ...base, target: from, teamId: fromTeam, delta: -n, counterId: to }, { ...base, target: to, teamId: toTeam, delta: n, counterId: from }];
      pair.forEach((x) => b.set(doc(C("pointLogs")), x));
      addStats(b, pair);
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
      const page = paged("adminLogs", logs, 50);
      setKids(list, logs.length ? page.items.map((l) => logCell(l, { admin: true })) : none(), page.more);
    },
  };
}

// ---------------------------------------------------------------- クイズ（ミニゲーム）
//
//   quizzes/{id}   { title, answerers: [uid] | null(=全員), questions: [問題], order }
//     問題        { type: "choice" | "text" | "buzz", text, choices: [4つ], answer, points, time, penalty }
//                  answer は 4択なら 0〜3、記述なら正解の文字列（「/」区切りで複数可）、早押しは管理者用のメモ
//   live/quiz      進行中のクイズの状態（全員がこの1件だけを見ている）
//                  { quizId, title, index, total, phase, seq, openedAt, q, answer, answerers, scores, read, fullText, turn }
//                  phase: lobby（待機）→ [reading（問題読み）] → question（出題中）→ closed（締切）→ reveal（正解発表）→ … → results（結果）→ off
//                  read     : 問題読みあり（問題文を1文字ずつ出す）。早押しは読み上げ中も押せる（phase は question のまま）
//                  turn     : 早押しの解答権 { uid, seq }。操作用の画面が「押した順」と判定から決めて書き込む
//   quizAnswers/{quizId}_{index}_{uid}  { uid, quizId, index, choice | text | buzz, reactionMs, at, judge, timeout }
//                  早押し：押す（buzz）→ 解答権が来たら6秒以内に text を送る。間に合わなければ timeout（誤答扱い）
//
// 早押しの順位は「サーバーに届いた順」ではなく、各自の端末に問題が表示されてからボタンを押すまでの
// 時間（reactionMs）で決める。電波の良し悪しで届くまでの時間が違っても、有利・不利がほぼ出ない。

const QZ = {
  mode: "operator", answersKey: null, t0: 0, seenSeq: null, hidden: false, autoClosedSeq: null, textDraft: new Map(), presenter: null, tick: null,
  readKey: null, readT0: 0, readFrozen: null,   // 問題読み：始まった時刻（この端末）と、早押しで止まった文字数
  readPlan: new Map(),                           // 操作用：問題ごとの「問題読みを入れる」（quizId:index → true/false）
  turnKey: null, turnT0: 0,                      // 解答権が来た時刻（この端末）
  buzzSeen: new Map(), turnWritten: null, timeoutSent: new Set(), buzzUI: null,
};
const BUZZ_ANSWER_SEC = 6;   // 解答権を得てから答えを送るまでの秒数
const BUZZ_GRACE_MS = 400;   // 最初の早押しから解答権を決めるまで待つ時間（通信の遅い人の方が先に押していることがあるため）
const READ_SPEED = 6;        // 問題読みの速さ（文字/秒）の初期値
const QTYPE = { choice: "4択", text: "記述", buzz: "早押し" };
const CHOICE_COLORS = ["#FF3B30", "#007AFF", "#FF9500", "#34C759"];
const CHOICE_MARKS = ["A", "B", "C", "D"];

function listenLiveQuiz() {
  listen("live", D("live", "quiz"), (s) => {
    const prev = S.live;
    S.live = s?.exists() ? s.data({ serverTimestamps: "estimate" }) : null;
    const L = S.live;
    // 出題（解答受付の開始）を受け取った瞬間を記録する（反応時間の起点。全体の再描画を待たずにここで測る）
    const qKey = L?.phase === "question" ? `${L.seq}:q` : null;
    if (qKey && qKey !== QZ.seenSeq) {
      QZ.seenSeq = qKey;
      QZ.t0 = performance.now();
      QZ.hidden = false;
    }
    // 問題読みの開始
    if (L?.read && (L.phase === "reading" || L.phase === "question") && QZ.readKey !== L.seq) {
      QZ.readKey = L.seq;
      QZ.readT0 = performance.now();
      QZ.readFrozen = null;
    }
    // 解答権が移った瞬間（6秒の起点）
    const tk = L?.turn ? `${L.seq}:${L.turn.uid}:${L.turn.seq}` : null;
    if (tk !== QZ.turnKey) { QZ.turnKey = tk; QZ.turnT0 = performance.now(); }
    if (L && prev && L.phase !== prev.phase) QZ.hidden = false;
    syncQuizAnswers();
    paintQuizLive();
  });
}

// 進行中のクイズの解答をすべて購読する（1クイズ分なので数百件程度）
function syncQuizAnswers() {
  const L = S.live;
  const key = L && L.phase !== "off" && L.quizId ? L.quizId : null;
  if (key === QZ.answersKey) return;
  unlisten("quizAnswers");
  S.quizAnswers = new Map();
  QZ.answersKey = key;
  if (!key) return;
  listen("quizAnswers", query(C("quizAnswers"), where("quizId", "==", key)), (s) => {
    if (s) S.quizAnswers = toMap(s);
    paintQuizLive();
  });
}

const normAnswer = (t) => String(t ?? "").normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");
const acceptedAnswers = (q) => String(q.answer ?? "").split(/[/／,、]/).map(normAnswer).filter(Boolean);

// 自動採点（早押しは管理者が判定するので null）
function autoJudge(q, a) {
  if (!q || !a) return null;
  if (q.type === "choice") return a.choice === q.answer;
  if (q.type === "text") return acceptedAnswers(q).includes(normAnswer(a.text));
  return null;
}
// 早押しで時間切れ（6秒以内に送れなかった）は誤答扱い
const judged = (q, a) => (typeof a.judge === "boolean" ? a.judge : q?.type === "buzz" && a.timeout ? false : autoJudge(q, a));
const buzzText = (a) => (a.text ? a.text : a.timeout ? "時間切れ" : "");
function answerPoints(q, a) {
  const j = judged(q, a);
  if (j === true) return Number(q.points ?? 10) || 0;
  if (j === false && q.type === "buzz") return -(Number(q.penalty ?? 0) || 0);
  return 0;
}

// 発表の状態（締切のあと、その場で組み合わせて出せる）
//   showAns     : 各自の回答を出す相手（"all" か uid の配列）
//   answerShown : 正解（答え）を出したか
//   shown       : ○× を出す相手（"all" か uid の配列）
const inList = (v, uid) => v === "all" || (Array.isArray(v) && v.includes(uid));
const isShown = (L, uid) => L?.phase === "reveal" && inList(L.shown, uid);
const isAnsShown = (L, uid) => L?.phase === "reveal" && (inList(L.showAns, uid) || inList(L.shown, uid));
const answerVisible = (L) => L?.phase === "reveal" && L.answerShown === true;

// アニメーションは最初に出たときだけ再生する（画面は0.2秒ごとに描き直すため）
const animSeen = new Set();
const firstTime = (key) => { if (animSeen.has(key)) return false; animSeen.add(key); return true; };

// ○× の記号（線が描かれていくアニメーション付き）
function markSvg(ok, animate, cls = "") {
  if (ok !== true && ok !== false) return null;
  const span = document.createElement("span");
  span.className = `mk ${ok ? "mk-ok" : "mk-ng"}${animate ? " anim" : ""} ${cls}`;
  span.innerHTML = ok
    ? '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="36"/></svg>'
    : '<svg viewBox="0 0 100 100"><path d="M24 24 76 76"/><path d="M76 24 24 76"/></svg>';
  return span;
}

const answersOf = (index) => [...S.quizAnswers.values()].filter((a) => a.index === index);
const buzzOrder = (index) => answersOf(index).filter((a) => a.buzz).sort((a, b) => (a.reactionMs ?? 1e9) - (b.reactionMs ?? 1e9));
const fmtSec = (ms) => (ms == null ? "" : `${(ms / 1000).toFixed(2)}秒`);
const amAnswerer = () => !S.isAdmin && S.live && (!S.live.answerers || S.live.answerers.includes(S.user?.uid));
const quizAudience = (answerers) => (answerers ? sortedMembers().filter((m) => answerers.includes(m.id)) : sortedMembers());

function quizScores(qz) {
  const scores = new Map(quizAudience(qz.answerers).map((m) => [m.id, 0]));
  qz.questions.forEach((q, i) => answersOf(i).forEach((a) => scores.set(a.uid, (scores.get(a.uid) ?? 0) + answerPoints(q, a))));
  return [...scores.entries()].map(([uid, score]) => ({ uid, name: memberName(uid), score })).sort((a, b) => b.score - a.score);
}

const publicQuestion = (q) => ({
  type: q.type, text: q.text ?? "", choices: q.type === "choice" ? q.choices ?? [] : [],
  time: Number(q.time) || 0, points: Number(q.points ?? 10) || 0, phone: q.phone !== false, speed: Number(q.speed) || READ_SPEED,
});

// ---- 問題読み（問題文を1文字ずつ出す）

// 問題読みを入れるか（操作用の画面で切り替えたもの → 問題の設定 → 早押しなら入れる）
const defaultRead = (q) => (typeof q?.read === "boolean" ? q.read : q?.type === "buzz");
const wantsRead = (qz, i) => {
  const k = `${qz.id}:${i}`;
  return QZ.readPlan.has(k) ? QZ.readPlan.get(k) : defaultRead(qz.questions[i]);
};
const qText = (L) => L?.q?.text || "（問題文なし）";

// 今、何文字目まで出すか。早押しは誰かが押した時点で止める。締切・発表・「全文を表示」で全文
function readProgress(L) {
  const len = qText(L).length;
  if (!L?.read || L.fullText || !(L.phase === "reading" || (L.phase === "question" && L.q?.type === "buzz"))) return len;
  if (typeof L.readStop === "number") return Math.min(L.readStop, len); // 操作用の画面が決めた止める位置（全員そろえる）
  if (QZ.readFrozen != null) return QZ.readFrozen;
  const n = Math.min(len, Math.floor(((performance.now() - QZ.readT0) / 1000) * (L.q.speed || READ_SPEED)));
  if (L.q.type === "buzz" && buzzOrder(L.index).length) QZ.readFrozen = n;
  return n;
}

// 問題文の欄。まだ読んでいない部分は透明な文字で置いておき、行の折り返しが途中で変わらないようにする
function readTextEl(L, cls) {
  const el = h("div", { class: cls, "data-read": "" }, h("span", { class: "rd-on" }), h("span", { class: "rd-rest" }));
  paintRead(el, L);
  return el;
}
function paintRead(el, L) {
  const text = qText(L);
  const n = readProgress(L);
  const on = text.slice(0, n), rest = text.slice(n);
  if (el.firstChild.textContent !== on) el.firstChild.textContent = on;
  if (el.lastChild.textContent !== rest) el.lastChild.textContent = rest;
  const stopped = QZ.readFrozen != null || typeof L.readStop === "number";
  el.classList.toggle("typing", n < text.length && !stopped);
  el.classList.toggle("stopped", n < text.length && stopped);
}

// ---- 早押しの解答権

const turnLeft = () => Math.max(0, BUZZ_ANSWER_SEC - (performance.now() - QZ.turnT0) / 1000);

// 操作用の画面が、押した順と判定から「今の解答権」を決めて書き込む。
// ×（または時間切れ）になったら、押した順に次の人へ移る。○が出たらその人で止める
function quizSyncTurn(L, qz) {
  const q = qz.questions[L.index];
  if (q?.type !== "buzz" || L.phase !== "question") return;
  const now = performance.now();
  const order = buzzOrder(L.index);
  for (const a of order) if (!QZ.buzzSeen.has(a.id)) QZ.buzzSeen.set(a.id, now);
  const winner = order.find((a) => judged(q, a) === true);
  const next = winner ?? order.find((a) => judged(q, a) !== false);
  if (!L.turn && next && now - Math.min(...order.map((a) => QZ.buzzSeen.get(a.id))) < BUZZ_GRACE_MS) return;
  const want = next?.uid ?? null;
  if ((L.turn?.uid ?? null) !== want) {
    const key = `${L.seq}:${want}:${order.filter((a) => judged(q, a) === false).length}`;
    if (QZ.turnWritten === key) return;
    QZ.turnWritten = key;
    // 最初の解答権を決めるとき、問題読みを止めた位置も書き込む（表示用・スマホで止まる位置をそろえる）
    const stop = !L.turn && want && L.read && typeof L.readStop !== "number" ? { readStop: readProgress(L) } : {};
    fire(updateDoc(liveRef(), { turn: want ? { uid: want, seq: Date.now() } : null, ...stop }));
    return;
  }
  // 解答者のスマホが閉じている・電波がないなどで時間切れが届かないときは、少し待ってからこちらで時間切れにする
  const a = next && !winner ? next : null;
  if (a && !a.text && !a.timeout && typeof a.judge !== "boolean" && turnLeft() === 0
    && performance.now() - QZ.turnT0 > (BUZZ_ANSWER_SEC + 2.5) * 1000 && !QZ.timeoutSent.has(`${a.id}:${L.turn.seq}`)) {
    QZ.timeoutSent.add(`${a.id}:${L.turn.seq}`);
    fire(updateDoc(D("quizAnswers", a.id), { timeout: true }));
  }
}

// ---- 進行（管理者）

const liveRef = () => D("live", "quiz");

function quizOpenQuestion(qz, i, read = wantsRead(qz, i)) {
  const q = qz.questions[i];
  if (!q) return;
  QZ.autoClosedSeq = null;
  // 4択・記述の問題読みは、読み終わってから「解答開始」で受け付ける。早押しは読み上げ中も押せる
  const reading = read && q.type !== "buzz";
  fire(setDoc(liveRef(), {
    quizId: qz.id, title: qz.title, total: qz.questions.length, answerers: qz.answerers ?? null,
    index: i, phase: reading ? "reading" : "question", seq: Date.now(), openedAt: serverTimestamp(), q: publicQuestion(q), answer: null, scores: null,
    read: !!read, fullText: false, turn: null, readStop: null,
  }));
}
const quizStartAnswering = () => quizSetPhase("question", { openedAt: serverTimestamp(), fullText: true });
const quizSetPhase = (phase, extra = {}) => fire(updateDoc(liveRef(), { phase, ...extra }));

function quizPrimaryAction() {
  const L = S.live;
  const qz = L && S.quizzes.get(L.quizId);
  if (!L || !qz) return;
  if (L.phase === "lobby") return quizOpenQuestion(qz, 0);
  if (L.phase === "reading") return quizStartAnswering();
  if (L.phase === "question" && buzzWinner(L, qz)) return quizReveal({ showAns: "all", shown: "all", answerShown: true });
  if (L.phase === "question") return quizSetPhase("closed");
  if (L.phase === "closed") return quizReveal({ showAns: "all", shown: "all", answerShown: true });
  if (L.phase === "reveal") {
    // まだ出していないもの（回答・正解・○×）があれば、先に全部出す（誤って次へ進まないように）
    if (!allRevealed(L, qz)) return quizReveal({ showAns: "all", shown: "all", answerShown: true });
    if (L.index + 1 < qz.questions.length) return quizOpenQuestion(qz, L.index + 1);
    return quizSetPhase("results", { scores: quizScores(qz).map(({ uid, score }) => ({ uid, score })) });
  }
  if (L.phase === "results") return quizEnd();
}
// ○× を全員に出せば各自の回答も見えるので、回答はそれで出し終わった扱いにする
const allRevealed = (L, qz) => L.phase === "reveal" && L.shown === "all" && L.answerShown === true;
const buzzWinner = (L, qz) => {
  const q = qz.questions[L.index];
  return q?.type === "buzz" ? buzzOrder(L.index).find((a) => judged(q, a) === true) ?? null : null;
};
function primaryLabel(L, qz, last) {
  if (L.phase === "reveal" && !allRevealed(L, qz)) return "残りを全部発表";
  if (L.phase === "reading") return "解答開始";
  if (L.phase === "question" && buzzWinner(L, qz)) return "正解を発表";
  return ({ lobby: "第1問を出題", question: "締め切る", closed: "全部まとめて発表", reveal: last ? "結果発表" : "次の問題へ", results: "クイズを終了" })[L.phase] ?? "";
}

// 発表の段階に進めつつ、出すものを指定する（締切の直後は何も出していない状態から始める）
function quizReveal(patch) {
  const L = S.live;
  const qz = L && S.quizzes.get(L.quizId);
  if (!qz) return;
  const first = L.phase !== "reveal";
  fire(updateDoc(liveRef(), {
    phase: "reveal", answer: qz.questions[L.index]?.answer ?? null,
    ...(first ? { showAns: [], shown: [], answerShown: false } : {}),
    ...patch,
  }));
}
// 1人分だけ出す（すでに全員分を出しているときは何もしない）
function quizRevealFor(field, uid) {
  const L = S.live;
  if (L?.phase === "reveal" && L[field] === "all") return;
  if (L?.phase !== "reveal") return quizReveal({ [field]: [uid] });
  fire(updateDoc(liveRef(), { [field]: arrayUnion(uid) }));
}

function quizEnd() {
  if (!confirm("クイズを終了しますか？参加者の画面からクイズが消えます。")) return;
  fire(updateDoc(liveRef(), { phase: "off" }));
  closePresenter();
}

async function quizStart(quizId, mode = "operator") {
  const qz = S.quizzes.get(quizId);
  if (!qz?.questions?.length) return toast("問題がありません", true);
  if (S.live && S.live.phase !== "off" && S.live.quizId !== quizId && !confirm("別のクイズが進行中です。終了して、このクイズを始めますか？")) return;
  fire(setDoc(liveRef(), {
    quizId, title: qz.title, total: qz.questions.length, answerers: qz.answerers ?? null,
    index: 0, phase: "lobby", seq: Date.now(), q: null, answer: null, scores: null,
  }));
  openPresenter(mode);
}

function quizToPoints(qz) {
  const rows = quizScores(qz).filter((r) => r.score !== 0);
  if (!rows.length) return toast("加算するポイントがありません", true);
  if (!confirm(`${rows.length}人の個人ポイントにクイズの得点を加算します（全員に公開）。よろしいですか？`)) return;
  const b = writeBatch(db);
  const logs = rows.map((r) => ({
    kind: "user", target: r.uid, teamId: null, visibility: "public", delta: r.score,
    reason: `クイズ「${qz.title}」`, createdAt: serverTimestamp(), author: emailToId(S.user.email),
  }));
  logs.forEach((x) => b.set(doc(C("pointLogs")), x));
  addStats(b, logs);
  fire(b.commit(), "個人ポイントに加算しました");
}

// ---- 問題の作成（管理者）

const newQuestion = (type = "choice") => ({
  type, text: "", choices: ["", "", "", ""], answer: type === "choice" ? 0 : "", points: 10, time: type === "buzz" ? 0 : 20, penalty: 0, phone: true,
});

function quizManager({ withTitle = true } = {}) {
  let editing = null;
  let draft = null;
  let dirty = false;
  const list = h("div");
  const editor = h("div");
  const el = h("div", null, withTitle ? largeTitle("クイズ") : null, list, editor);

  async function createQuiz() {
    const ref = doc(C("quizzes"));
    await setDoc(ref, { title: "新しいクイズ", answerers: null, questions: [newQuestion()], order: Date.now() });
    openEditor(ref.id);
  }
  function openEditor(id) { editing = id; draft = null; dirty = false; list.hidden = true; editor.hidden = false; tryLoad(); }
  function closeEditor() {
    if (dirty && !confirm("保存していない変更があります。破棄して戻りますか？")) return;
    editing = null; draft = null; dirty = false; list.hidden = false; editor.hidden = true; paintList();
  }
  function tryLoad() {
    const qz = S.quizzes.get(editing);
    if (!qz || draft) return;
    draft = JSON.parse(JSON.stringify({ title: qz.title, answerers: qz.answerers ?? null, questions: qz.questions ?? [] }));
    paintEditor();
  }
  const touch = () => { dirty = true; editor.classList.add("dirty"); };
  async function save() {
    await updateDoc(D("quizzes", editing), { title: draft.title.trim() || "クイズ", answerers: draft.answerers, questions: draft.questions });
    dirty = false; editor.classList.remove("dirty");
    toast("保存しました");
  }

  function paintList() {
    const quizzes = [...S.quizzes.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const L = S.live;
    setKids(list,
      L && L.phase !== "off" ? group(`進行中：${L.title}`, [
        h("button", { class: "cell cell-button live-now", onclick: () => openPresenter("display") }, h("span", { class: "live-dot" }), "表示用の画面を開く（プロジェクター用）"),
        h("button", { class: "cell cell-button", onclick: () => openPresenter("operator") }, icon("play"), "操作用の画面を開く（進行・○×判定）"),
      ], "表示用と操作用は、別の管理者アカウント・別の端末で開けます（例：admin1 で表示用、admin2 で操作用）。") : null,
      quizzes.length ? quizzes.map((qz) => h("article", { class: "card quiz-card", "data-quiz": qz.id },
        h("div", { class: "quiz-card-title" }, icon("quiz"), qz.title),
        h("div", { class: "cell-sub" }, `${qz.questions?.length ?? 0}問 ・ 解答者：${qz.answerers ? `${qz.answerers.length}人` : "全員"}`),
        h("div", { class: "quiz-card-actions" },
          h("button", { class: "text-btn", onclick: () => openEditor(qz.id) }, "編集"),
          h("button", { class: "text-btn destructive", onclick: () => { if (confirm(`「${qz.title}」を削除しますか？`)) fire(deleteDoc(D("quizzes", qz.id)), "削除しました"); } }, "削除"),
          h("button", { class: "btn-small", onclick: () => quizStart(qz.id, "operator") }, icon("play"), "開始（操作用）")),
      )) : emptyState("quiz", "クイズはまだありません", "「新しいクイズ」から作れます。"),
      h("button", { class: "btn-filled", onclick: () => guard(null, createQuiz) }, icon("plus"), "新しいクイズ"),
    );
  }

  function paintEditor() {
    const d = draft;
    const title = h("input", { type: "text", value: d.title, class: "plain title-input", placeholder: "クイズの名前" });
    title.addEventListener("input", () => { d.title = title.value; touch(); });

    // 解答者
    const who = segmented([{ value: "all", label: "全員" }, { value: "pick", label: "選ぶ" }], d.answerers ? "pick" : "all");
    const picks = h("div", { class: "pick-list" });
    const paintPicks = () => {
      picks.hidden = !d.answerers;
      setKids(picks, d.answerers ? sortedMembers().map((m) => {
        const cb = h("input", { type: "checkbox", checked: d.answerers.includes(m.id) });
        cb.addEventListener("change", () => {
          d.answerers = cb.checked ? [...new Set([...d.answerers, m.id])] : d.answerers.filter((x) => x !== m.id);
          touch();
        });
        return h("label", { class: "pick" }, cb, m.name);
      }) : null);
    };
    who.addEventListener("change", () => { d.answerers = who.value === "pick" ? [] : null; touch(); paintPicks(); });
    paintPicks();

    const qList = h("div");
    const paintQuestions = () => setKids(qList, d.questions.map((q, i) => questionEditor(q, i)));
    function questionEditor(q, i) {
      const type = segmented(Object.entries(QTYPE).map(([value, label]) => ({ value, label })), q.type);
      type.addEventListener("change", () => {
        q.type = type.value;
        if (q.type === "choice" && typeof q.answer !== "number") q.answer = 0;
        if (q.type !== "choice" && typeof q.answer === "number") q.answer = "";
        if (q.type === "buzz" && !q.time) q.time = 0;
        touch(); paintQuestions();
      });
      const text = h("textarea", { class: "plain", rows: "2", placeholder: "問題文" });
      text.value = q.text ?? "";
      text.addEventListener("input", () => { q.text = text.value; touch(); });
      const num = (val, onset, attrs = {}) => {
        const inp = h("input", { type: "number", value: String(val ?? 0), inputmode: "numeric", ...attrs });
        inp.addEventListener("input", () => { onset(Number(inp.value) || 0); touch(); });
        return inp;
      };
      let body;
      if (q.type === "choice") {
        q.choices = [0, 1, 2, 3].map((k) => q.choices?.[k] ?? "");
        body = h("div", { class: "choice-edit" }, q.choices.map((c, k) => {
          const inp = h("input", { type: "text", value: c, placeholder: `選択肢 ${CHOICE_MARKS[k]}` });
          inp.addEventListener("input", () => { q.choices[k] = inp.value; touch(); });
          const radio = h("input", { type: "radio", name: `ans-${i}-${editing}`, checked: q.answer === k, "aria-label": `${CHOICE_MARKS[k]}を正解にする` });
          radio.addEventListener("change", () => { q.answer = k; touch(); });
          return h("label", { class: "choice-row" }, h("span", { class: "mark", style: `--c:${CHOICE_COLORS[k]}` }, CHOICE_MARKS[k]), inp, radio, h("span", { class: "radio-label" }, "正解"));
        }));
      } else {
        const ans = h("input", { type: "text", value: q.answer ?? "", placeholder: q.type === "text" ? "正解（「/」で区切ると複数OK）" : "正解のメモ（自分用）" });
        ans.addEventListener("input", () => { q.answer = ans.value; touch(); });
        body = h("div", { class: "group-body" }, field("正解", ans));
      }
      const move = (dir) => {
        const j = i + dir;
        if (j < 0 || j >= d.questions.length) return;
        [d.questions[i], d.questions[j]] = [d.questions[j], d.questions[i]];
        touch(); paintQuestions();
      };
      return h("article", { class: "card q-edit" },
        h("div", { class: "q-head" },
          h("b", null, `第${i + 1}問`),
          h("div", { class: "q-tools" },
            h("button", { class: "icon-btn", title: "上へ", onclick: () => move(-1) }, "↑"),
            h("button", { class: "icon-btn", title: "下へ", onclick: () => move(1) }, "↓"),
            h("button", { class: "text-btn destructive", onclick: () => { d.questions.splice(i, 1); touch(); paintQuestions(); } }, "削除"))),
        type, text, body,
        h("div", { class: "group-body q-nums" },
          field("スマホに問題文を表示", (() => {
            const t = toggle(q.phone !== false);
            t.addEventListener("change", () => { q.phone = t.checked; touch(); });
            return t;
          })()),
          field("問題読み画面を入れる", (() => {
            const t = toggle(defaultRead(q));
            t.addEventListener("change", () => { q.read = t.checked; touch(); paintQuestions(); });
            return t;
          })()),
          defaultRead(q) ? field("読み上げの速さ（文字/秒）", num(q.speed ?? READ_SPEED, (v) => { q.speed = v; }, { min: "1", max: "30" })) : null,
          field("配点", num(q.points ?? 10, (v) => { q.points = v; })),
          field(q.type === "buzz" ? "制限時間（秒・0で無制限）" : "制限時間（秒）", num(q.time ?? 0, (v) => { q.time = v; })),
          q.type === "buzz" ? field("誤答・時間切れ（減点）", num(q.penalty ?? 0, (v) => { q.penalty = v; })) : null),
        h("div", { class: "cell-sub q-hint" }, defaultRead(q)
          ? (q.type === "buzz" ? "問題文を1文字ずつ表示し、読み上げ中も早押しできます。誰かが押すと表示が止まります。" : "問題文を1文字ずつ表示し、操作用の画面で「解答開始」を押すまで解答できません。")
          : "問題文と選択肢をすぐに全部表示します。"),
      );
    }
    paintQuestions();

    setKids(editor,
      h("div", { class: "row-between" },
        h("button", { class: "text-btn", onclick: closeEditor }, "‹ 一覧へ戻る"),
        h("button", { class: "text-btn", onclick: () => guard(null, save) }, "保存")),
      h("div", { class: "card" }, title),
      group("解答者", [h("div", { class: "cell" }, who)], "「選ぶ」にすると、チェックした人だけが解答できます。"),
      picks,
      qList,
      h("div", { class: "quiz-add" }, Object.entries(QTYPE).map(([type, label]) =>
        h("button", { class: "pill", onclick: () => { d.questions.push(newQuestion(type)); touch(); paintQuestions(); } }, icon("plus"), `${label}の問題`))),
      h("button", { class: "btn-filled", onclick: () => guard(null, async () => { await save(); quizStart(editing, "operator"); }) }, icon("play"), "保存して開始（操作用の画面へ）"),
    );
  }

  editor.hidden = true;
  return {
    el,
    update() {
      if (editing) { tryLoad(); return; }
      paintList();
    },
  };
}

// ---- プレゼン画面（管理者）

function openPresenter(mode = "operator") {
  if (QZ.presenter && QZ.mode !== mode) closePresenter();
  if (!QZ.presenter) {
    closeSheet();
    const el = h("div", { class: `present mode-${mode}`, role: "dialog", "aria-label": mode === "display" ? "クイズの表示用画面" : "クイズの操作用画面" });
    document.body.append(el);
    QZ.presenter = el;
    QZ.mode = mode;
    if (mode === "display") el.requestFullscreen?.().catch(() => {});
    clearInterval(QZ.tick);
    QZ.tick = setInterval(() => paintQuizLive(false), 200); // タイマー表示と自動締切
  }
  paintQuizLive();
}

function closePresenter() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  QZ.presenter?.remove();
  QZ.presenter = null;
  clearInterval(QZ.tick);
  QZ.tick = null;
}

document.addEventListener("keydown", (e) => {
  if (!QZ.presenter || !S.isAdmin || QZ.mode !== "operator") return;
  if (e.target.closest?.("input, textarea, select")) return;
  const L = S.live;
  const qz = L && S.quizzes.get(L.quizId);
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); quizPrimaryAction(); }
  if (qz && e.key === "ArrowRight" && L.index + 1 < qz.questions.length) quizOpenQuestion(qz, L.index + 1);
  if (qz && e.key === "ArrowLeft" && L.index > 0) quizOpenQuestion(qz, L.index - 1);
});

function remainingSec(L, local) {
  if (!L?.q?.time) return null;
  const start = local ? QZ.t0 : ts(L.openedAt) || Date.now();
  const elapsed = local ? (performance.now() - start) / 1000 : (Date.now() - start) / 1000;
  return Math.max(0, L.q.time - elapsed);
}

function paintPresenter(full = true) {
  const P = QZ.presenter;
  const L = S.live;
  if (!P) return;
  const qz = L && S.quizzes.get(L.quizId);
  if (L?.phase === "off") { closePresenter(); return; }
  // 開いた直後で、進行状態やクイズがまだ届いていない
  if (!L || !qz) {
    P.dataset.state = "wait";
    P.replaceChildren(h("div", { class: "pr-lobby" }, h("div", { class: "pr-sub" }, "準備中…"),
      h("button", { class: "pr-btn ghost", onclick: closePresenter }, "閉じる")));
    return;
  }

  // 制限時間が来たら自動で締め切る（表示用・操作用のどちらが開いていても動く）
  const rem = L.phase === "question" ? remainingSec(L, false) : null;
  if (rem === 0 && QZ.autoClosedSeq !== L.seq) { QZ.autoClosedSeq = L.seq; quizSetPhase("closed"); }
  if (QZ.mode === "operator") quizSyncTurn(L, qz);
  // 普段はタイマーだけ更新する。ただし「準備中」の表示中と、2秒に1回は全体を描き直して取りこぼしを防ぐ
  if (!full && P.dataset.state !== "wait" && Date.now() - (QZ.lastFull ?? 0) < 2000) { updateQuizTicks(); return; }
  QZ.lastFull = Date.now();
  P.dataset.state = "ok";

  if (QZ.mode === "display") paintDisplay(P, L, qz, rem);
  else paintOperator(P, L, qz, rem);
}

// 解答者全員の状態（下のバー）。正解発表までは「回答あり / なし」だけ、発表後は ○×
function answerBar(L, qz) {
  const q = qz.questions[L.index];
  const answers = answersOf(L.index);
  const order = q?.type === "buzz" ? buzzOrder(L.index) : [];
  const audience = quizAudience(qz.answerers);
  return h("div", { class: `pr-bar${audience.length > 12 ? " many" : ""}` }, audience.map((m) => {
    const a = answers.find((x) => x.uid === m.id && (q.type !== "buzz" || x.buzz));
    // 早押しの誤答は、解答権が移るのですぐに出す
    const wrongNow = q?.type === "buzz" && a && judged(q, a) === false;
    const revealed = isShown(L, m.id) || wrongNow;
    const ok = a && revealed ? judged(q, a) : null;
    const turn = q?.type === "buzz" && L.phase === "question" && L.turn?.uid === m.id && !wrongNow;
    const rank = q?.type === "buzz" && a ? order.indexOf(a) + 1 : 0;
    const ansShown = a && isAnsShown(L, m.id);
    const pop = (revealed && a && firstTime(`chip:${L.seq}:${m.id}`)) || (ansShown && firstTime(`ansv:${L.seq}:${m.id}`)) || (a && !revealed && firstTime(`ans:${L.seq}:${m.id}`));
    const ansLabel = q.type === "choice" ? CHOICE_MARKS[a?.choice] ?? "?" : q.type === "text" ? a?.text : rank ? `${rank}番` : "✓";
    return h("div", { class: `pr-chip${a ? " done" : ""}${ok === true ? " ok" : ok === false ? " ng" : ""}${turn ? " turn" : ""}${pop ? " pop" : ""}` },
      h("span", { class: "nm" }, m.name),
      ansShown && q.type !== "buzz" ? h("span", { class: "av" }, ansLabel) : null,
      h("span", { class: "st" }, revealed && a ? (markSvg(ok, false, "mark-chip") ?? "?") : turn ? "解答中" : rank ? `${rank}番` : a ? "✓" : "—"));
  }));
}

function resultsBody(qz, withButton) {
  const rows = quizScores(qz);
  let rank = 0, prev = null;
  const enter = firstTime(`res:${S.live?.seq}:${QZ.mode}`);
  return h("div", { class: `pr-results${enter ? " enter" : ""}` },
    h("div", { class: "pr-big" }, "結果発表"),
    h("ol", { class: "pr-rank" }, rows.map((r, i) => {
      if (r.score !== prev) { rank = i + 1; prev = r.score; }
      return h("li", { class: `r${rank}` }, h("span", { class: "pr-rank-no" }, rank), h("span", { class: "pr-rank-name" }, r.name), h("span", { class: "pr-rank-pt" }, r.score, h("small", null, "点")));
    })),
    withButton ? h("button", { class: "pr-btn ghost", onclick: () => quizToPoints(qz) }, "この得点を個人ポイントに加算") : null);
}

// 早押し（表示用）：今の解答権と、その問題の誤答一覧
function buzzStage(L, q) {
  const order = buzzOrder(L.index);
  if (!order.length) return h("div", { class: "pr-buzzstage" }, h("div", { class: "pr-wait" }, L.phase === "question" ? "早押し待ち…" : "早押しはありませんでした"));
  const wrong = order.filter((a) => judged(q, a) === false);
  const winner = order.find((a) => judged(q, a) === true);
  // 解答権を持っている人（○なら、発表するまでは「判定中」のまま）
  const cur = L.phase === "question" ? order.find((a) => a.uid === L.turn?.uid && judged(q, a) !== false) : winner;
  let turn = null;
  if (cur) {
    const ok = judged(q, cur) === true && isShown(L, cur.uid);
    const text = buzzText(cur);
    turn = h("div", { class: `pr-turn${ok ? " ok" : ""}${firstTime(`turn:${L.seq}:${cur.uid}`) ? " enter" : ""}` },
      h("div", { class: "lbl" }, ok ? "正解" : "解答権"),
      h("div", { class: "who" }, memberName(cur.uid), h("small", null, fmtSec(cur.reactionMs))),
      text ? h("div", { class: "ans" }, `「${text}」`)
        : L.phase === "question" ? h("div", { class: "pr-turn-count", "data-turncount": "" }, Math.ceil(turnLeft())) : null,
      ok ? markSvg(true, firstTime(`bw:${L.seq}:${cur.uid}`), "mark-turn") : null);
  } else if (L.phase === "question") {
    const left = order.filter((a) => judged(q, a) !== false).length;
    turn = h("div", { class: "pr-turn idle" }, h("div", { class: "lbl" }, left ? "解答権を確認中…" : "早押し待ち…"));
  }
  return h("div", { class: `pr-buzzstage${wrong.length ? " has-wrong" : ""}` },
    turn,
    wrong.length ? h("div", { class: "pr-wrong" },
      h("div", { class: "pr-wrong-title" }, `誤答 ${wrong.length}`),
      h("ol", null, wrong.map((a) => h("li", { class: firstTime(`wr:${L.seq}:${a.uid}`) ? "enter" : null },
        markSvg(false, firstTime(`wx:${L.seq}:${a.uid}`), "mark-wrong"),
        h("span", { class: "ans" }, buzzText(a) || "—"),
        h("span", { class: "who" }, memberName(a.uid)))))) : null);
}

// 表示用（プロジェクターに映す）：操作ボタンなし。○×は「正解を発表」まで出さない
function paintDisplay(P, L, qz, rem) {
  const q = qz.questions[L.index];
  const audience = quizAudience(qz.answerers);
  const answers = answersOf(L.index);
  const revealed = answerVisible(L);
  const head = h("div", { class: "pr-head" },
    h("div", { class: "pr-title" }, L.title),
    L.phase === "lobby" || L.phase === "results" ? null : h("div", { class: "pr-meta" },
      h("span", { class: "pr-badge" }, `第${L.index + 1}問 / ${qz.questions.length}`),
      h("span", { class: `pr-badge type-${q?.type}` }, QTYPE[q?.type] ?? ""),
      h("span", { class: "pr-badge" }, `${q?.points ?? 10}点`),
      L.phase === "closed" ? h("span", { class: "pr-badge closed" }, "締切") : null,
      L.phase === "reading" ? h("span", { class: "pr-badge reading" }, "問題") : null),
    rem != null ? h("div", { class: `pr-timer${rem <= 5 ? " hurry" : ""}` }, Math.ceil(rem)) : null,
    h("button", { class: "pr-exit", title: "表示用画面を閉じる", onclick: closePresenter }, icon("xmark")));

  let body;
  if (L.phase === "lobby") {
    body = h("div", { class: "pr-lobby" },
      h("div", { class: `pr-big${firstTime(`dl:${L.seq}`) ? " enter" : ""}` }, L.title),
      h("div", { class: "pr-sub" }, `全${qz.questions.length}問 ・ 解答者 ${audience.length}人`),
      h("div", { class: "pr-names" }, audience.map((m) => h("span", null, m.name))),
      h("div", { class: "pr-hint" }, "まもなく始まります"));
  } else if (L.phase === "results") {
    body = resultsBody(qz, false);
  } else {
    let detail = null;
    if (L.phase === "reading") {
      detail = h("div", { class: "pr-hint" }, "問題を読んでいます…");
    } else if (q.type === "choice") {
      const counts = [0, 1, 2, 3].map((k) => answers.filter((a) => a.choice === k).length);
      detail = h("div", { class: "pr-choices" }, (q.choices ?? []).map((c, k) => h("div", {
        class: `pr-choice${revealed ? (q.answer === k ? ` correct${firstTime(`c:${L.seq}`) ? " anim" : ""}` : " dim") : ""}`, style: `--c:${CHOICE_COLORS[k]}`,
      }, h("span", { class: "mark" }, CHOICE_MARKS[k]), h("span", { class: "txt" }, c),
        L.phase === "reveal" && L.showAns === "all" ? h("span", { class: "cnt" }, `${counts[k]}人`) : null)));
    } else if (q.type === "text" && L.phase === "reveal") {
      detail = h("div", { class: "pr-texts" }, answers.filter((a) => isAnsShown(L, a.uid)).map((a) => {
        const ok = isShown(L, a.uid) ? judged(q, a) : null;
        return h("div", { class: `pr-text${ok === true ? " ok" : ok === false ? " ng" : ""}${firstTime(`tc:${L.seq}:${a.uid}`) ? " enter" : ""}` },
          h("div", { class: "who" }, memberName(a.uid)), h("div", { class: "ans" }, a.text),
          ok == null ? null : markSvg(ok, firstTime(`t:${L.seq}:${a.uid}`), "mark-big"));
      }));
    } else if (q.type === "buzz") {
      detail = buzzStage(L, q);
    }
    body = h("div", { class: "pr-q" },
      readTextEl(L, `pr-text-q${firstTime(`dq:${L.seq}`) ? " enter" : ""}`),
      detail,
      revealed && q.type !== "choice" && q.answer ? h("div", { class: `pr-answer${firstTime(`da:${L.seq}`) ? " enter" : ""}` }, "正解：", q.answer) : null);
  }
  setKids(P, head, body, L.phase === "lobby" || L.phase === "results" ? null : answerBar(L, qz));
}

// 操作用（手元で進行と ○×判定をする）
function paintOperator(P, L, qz, rem) {
  const q = qz.questions[L.index];
  const audience = quizAudience(qz.answerers);
  const answers = answersOf(L.index);
  const last = L.index + 1 >= qz.questions.length;
  const phaseLabel = { lobby: "待機中", reading: "問題読み中", question: "出題中", closed: "締切（判定してください）", reveal: "正解発表中", results: "結果発表中" }[L.phase] ?? "";

  const head = h("div", { class: "op-head" },
    h("div", null, h("div", { class: "op-title" }, L.title),
      h("div", { class: "op-sub" }, L.phase === "lobby" || L.phase === "results" ? phaseLabel : `第${L.index + 1}問 / ${qz.questions.length} ・ ${QTYPE[q?.type]} ・ ${phaseLabel}`)),
    rem != null ? h("div", { class: `op-timer${rem <= 5 ? " hurry" : ""}` }, `${Math.ceil(rem)}秒`) : null,
    h("button", { class: "text-btn", onclick: () => openPresenter("display") }, "表示用に切り替え"),
    h("button", { class: "text-btn", onclick: closePresenter }, "閉じる"));

  // 次の問題（先読み）。問題読みを入れるかをここで切り替えられる
  const nextIndex = L.phase === "lobby" ? 0 : L.index + 1;
  const nq = L.phase === "results" ? null : qz.questions[nextIndex];
  const nextCard = nq ? (() => {
    const k = `${qz.id}:${nextIndex}`;
    const t = toggle(wantsRead(qz, nextIndex));
    t.addEventListener("change", () => { QZ.readPlan.set(k, t.checked); paintQuizLive(); });
    return h("div", { class: "card op-next" },
      h("div", { class: "op-next-head" }, h("span", { class: "op-next-label" }, "次の問題"), `第${nextIndex + 1}問 ・ ${QTYPE[nq.type]} ・ ${nq.points ?? 10}点`),
      h("div", { class: "op-next-text" }, nq.text || "（問題文なし）"),
      nq.type === "choice"
        ? h("div", { class: "op-next-sub" }, (nq.choices ?? []).map((c, k2) => `${CHOICE_MARKS[k2]} ${c}`).join("　"), "　→ 正解 ", CHOICE_MARKS[nq.answer] ?? "?")
        : h("div", { class: "op-next-sub" }, "正解：", nq.answer || "（未設定）"),
      h("label", { class: "op-next-read" }, t, h("span", null, "問題読み画面を入れる")));
  })() : null;

  let body;
  if (L.phase === "lobby") {
    body = h("div", { class: "op-body" },
      h("p", { class: "op-note" }, "表示用の画面（プロジェクター）は、もう1台の端末で「クイズ」→「表示用の画面を開く」から開いてください。"),
      nextCard,
      group(`解答者 ${audience.length}人`, audience.map((m) => cell(m.name))));
  } else if (L.phase === "results") {
    body = h("div", { class: "op-body" }, resultsBody(qz, true));
  } else {
    const canReveal = L.phase === "closed" || L.phase === "reveal";
    const isBuzz = q.type === "buzz";
    const order = isBuzz ? buzzOrder(L.index) : null;
    const list = (order ?? answers.slice().sort((a, b) => (a.reactionMs ?? 0) - (b.reactionMs ?? 0))).map((a, i) => {
      const ok = judged(q, a);
      const hasTurn = isBuzz && L.phase === "question" && L.turn?.uid === a.uid && ok !== false;
      const match = isBuzz && a.text && acceptedAnswers(q).includes(normAnswer(a.text));
      const shown = q.type === "choice" ? `${CHOICE_MARKS[a.choice] ?? "?"}：${q.choices?.[a.choice] ?? ""}` : q.type === "text" ? a.text
        : buzzText(a) ? `「${buzzText(a)}」` : hasTurn ? "入力中…" : "待機";
      return h("div", { class: `cell op-ans${ok === true ? " ok" : ok === false ? " ng" : ""}${hasTurn ? " turn" : ""}` },
        order ? h("span", { class: "op-rank" }, i + 1) : null,
        h("div", { class: "cell-main" },
          h("b", null, memberName(a.uid), hasTurn ? h("span", { class: "op-turn" }, "解答権") : null),
          h("div", { class: "cell-sub" }, `${shown} ・ ${fmtSec(a.reactionMs)}`, match ? h("span", { class: "op-match" }, "正解と一致") : null),
          hasTurn && !a.text ? h("div", { class: "op-turn-count", "data-turncount": "" }, `残り ${Math.ceil(turnLeft())} 秒`) : null),
        judgeButtons(a, ok),
        canReveal && !isBuzz ? (isAnsShown(L, a.uid)
          ? h("span", { class: "op-shown" }, "回答済")
          : h("button", { class: "btn-small ghost", onclick: () => quizRevealFor("showAns", a.uid) }, "回答")) : null,
        canReveal ? (isShown(L, a.uid)
          ? h("span", { class: "op-shown" }, "○×済")
          : h("button", { class: "btn-small", onclick: () => quizRevealFor("shown", a.uid) }, "○×")) : null);
    });
    const missing = audience.filter((m) => !answers.some((a) => a.uid === m.id && (!isBuzz || a.buzz)));
    const reading = L.read && (L.phase === "reading" || (isBuzz && L.phase === "question")) && !L.fullText;
    body = h("div", { class: "op-body" },
      h("div", { class: "card op-q" },
        h("div", { class: "op-qtext" }, q.text || "（問題文なし）"),
        reading ? h("div", { class: "op-readline" }, "画面の表示：", readTextEl(L, "op-readprog"),
          h("button", { class: "btn-small ghost", onclick: () => quizSetPhase(L.phase, { fullText: true }) }, "全文を表示")) : null,
        q.type === "choice" ? h("div", { class: "op-choices" }, (q.choices ?? []).map((c, k) =>
          h("div", { class: `op-choice${q.answer === k ? " correct" : ""}`, style: `--c:${CHOICE_COLORS[k]}` }, `${CHOICE_MARKS[k]} ${c}`))) : null,
        q.type !== "choice" ? h("div", { class: "op-correct" }, "正解：", q.answer || "（未設定）") : null,
        h("div", { class: "cell-sub" }, [
          q.phone !== false ? "スマホに問題文を表示しています" : "スマホには問題文を表示していません",
          L.read ? "問題読みあり" : "問題読みなし",
        ].join(" ・ ")),
        !L.read && L.phase === "question" && !answers.length
          ? h("button", { class: "btn-small ghost", onclick: () => quizOpenQuestion(qz, L.index, true) }, "問題読みを入れて出し直す") : null),
      L.phase === "reading" ? h("p", { class: "op-note" }, "問題を読み上げてください。読み終わったら「解答開始」で解答を受け付けます（選択肢もそこで表示されます）。") : null,
      L.phase === "reading" ? null : group(`${isBuzz ? "早押しの順番" : "回答"}（${list.length} / ${audience.length}人）`, list.length ? list : none("まだありません"),
        isBuzz ? `押した順に解答権が移ります。解答権を得た人は${BUZZ_ANSWER_SEC}秒以内に答えを送ります（間に合わなければ誤答）。答えを見て○×を付けてください。×なら自動で次の人へ移り、表示用の画面の「誤答」に出ます。`
          : "自動で採点しています。○×を押すと手動で直せます（もう一度押すと自動に戻ります）。"),
      missing.length && L.phase !== "reading" ? group("未回答", cell(h("span", { class: "secondary" }, missing.map((m) => m.name).join("・")))) : null,
      nextCard,
      h("p", { class: "op-note" }, "ここで付けた○×は、発表するまで表示用の画面や参加者には出ません（早押しの×は、すぐ「誤答」として出ます）。締切のあと、下のボタンで「回答」「正解」「○×」を好きな順に出せます。名前の横の「回答」「○×」で1人ずつ出すこともできます。"));
  }

  const revealing = L.phase === "closed" || L.phase === "reveal";
  const qType = qz.questions[L.index]?.type;
  const foot = h("div", { class: "op-foot" },
    h("button", { class: "pr-btn ghost", disabled: !(L.index > 0 && L.phase !== "lobby" && L.phase !== "results"), onclick: () => quizOpenQuestion(qz, L.index - 1) }, "← 前"),
    revealing && qType !== "buzz" ? h("button", { class: "pr-btn ghost", disabled: L.phase === "reveal" && L.showAns === "all", onclick: () => quizReveal({ showAns: "all" }) }, "回答を全員表示") : null,
    revealing ? h("button", { class: "pr-btn ghost", disabled: answerVisible(L), onclick: () => quizReveal({ answerShown: true }) }, "正解を表示") : null,
    revealing ? h("button", { class: "pr-btn ghost", disabled: L.phase === "reveal" && L.shown === "all", onclick: () => quizReveal({ shown: "all" }) }, "○×を全員表示") : null,
    h("button", { class: "pr-btn primary", onclick: quizPrimaryAction }, primaryLabel(L, qz, last)),
    h("button", { class: "pr-btn ghost", disabled: !(!last && L.phase !== "lobby" && L.phase !== "results"), onclick: () => quizOpenQuestion(qz, L.index + 1) }, "次 →"),
    h("button", { class: "pr-btn danger", onclick: quizEnd }, "終了"));
  // 入力中の欄（操作用はないが念のため）やスクロール位置を保つ
  const scroll = P.querySelector(".op-body")?.scrollTop ?? 0;
  setKids(P, head, body, foot);
  const ob = P.querySelector(".op-body");
  if (ob) ob.scrollTop = scroll;
}

function judgeButtons(a, ok) {
  const set = (v) => fire(updateDoc(D("quizAnswers", a.id), { judge: v }));
  return h("span", { class: "judge" },
    h("button", { class: `j ok${ok === true ? " on" : ""}`, onclick: () => set(ok === true ? null : true), title: "正解" }, "○"),
    h("button", { class: `j ng${ok === false ? " on" : ""}`, onclick: () => set(ok === false ? null : false), title: "不正解" }, "×"));
}

// ---- 解答者の画面（スマホ）

function quizAnswer(data) {
  const L = S.live;
  const uid = S.user.uid;
  if (!L || L.phase !== "question") return;
  const rem = remainingSec(L, true);
  if (rem === 0) return toast("時間切れです", true);
  const reactionMs = Math.round(performance.now() - QZ.t0);
  fire(setDoc(D("quizAnswers", `${L.quizId}_${L.index}_${uid}`), {
    uid, quizId: L.quizId, index: L.index, reactionMs, at: serverTimestamp(), ...data,
  }));
}

// 早押しのボタンと解答欄（問題ごとに1回だけ作って使い回す）。
// 作り直すと、押した直後に出る入力欄にキーボードを出せなかったり、入力中にキーボードが閉じたりするため
function buzzPanel(L) {
  if (QZ.buzzUI?.seq === L.seq) { updateBuzzPanel(); return QZ.buzzUI.root; }
  const uid = S.user.uid;
  const id = `${L.quizId}_${L.index}_${uid}`;
  const btn = h("button", { class: "ql-buzz" }, "早押し");
  const info = h("div", { class: "ql-sub ql-buzzinfo" });
  const title = h("div", { class: "ql-turn-title" });
  const count = h("div", { class: "ql-turn-count" });
  const input = h("input", { type: "text", class: "ql-input", placeholder: "答えを入力", enterkeyhint: "send", autocomplete: "off", autocapitalize: "off" });
  const send = h("button", { class: "ql-send" }, "解答する");
  const box = h("div", { class: "ql-turnbox", hidden: true }, h("div", { class: "ql-turn-row" }, title, count), input, send);
  const root = h("div", { class: "ql-buzzwrap" }, btn, info, box);
  const ui = QZ.buzzUI = { seq: L.seq, id, root, btn, info, title, count, input, send, box, pressed: false, sent: false };
  // 押した瞬間に記録する（pointerdown）。キーボードは click のときに出す（スマホはこの順でないと出ない）
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (btn.disabled || ui.pressed) return;
    ui.pressed = true;
    quizAnswer({ buzz: true });
    updateBuzzPanel();
  });
  // スマホは「指を離したとき（pointerup）」か click の中でないとキーボードが出ないので、両方で入力欄にフォーカスする
  const focusInput = () => { if (ui.pressed && !box.hidden && document.activeElement !== input) input.focus({ preventScroll: true }); };
  btn.addEventListener("pointerup", focusInput);
  btn.addEventListener("click", focusInput);
  const submit = () => {
    const text = input.value.trim();
    const L2 = S.live;
    if (!text || ui.sent || L2?.turn?.uid !== uid || L2.phase !== "question" || turnLeft() === 0) return;
    ui.sent = true;
    fire(updateDoc(D("quizAnswers", id), { text, textMs: Math.round(performance.now() - QZ.turnT0) }));
    input.blur();
    updateBuzzPanel();
  };
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); } });
  updateBuzzPanel();
  return root;
}

function updateBuzzPanel() {
  const ui = QZ.buzzUI;
  const L = S.live;
  if (!ui || !L || ui.seq !== L.seq) return;
  const uid = S.user.uid;
  const mine = S.quizAnswers.get(ui.id);
  const pressed = ui.pressed || !!mine?.buzz;
  const rem = remainingSec(L, true);
  const open = L.phase === "question" && rem !== 0;
  const order = buzzOrder(L.index);
  const rank = order.findIndex((a) => a.uid === uid) + 1;
  const myTurn = L.phase === "question" && L.turn?.uid === uid;
  const verdict = mine ? (typeof mine.judge === "boolean" ? mine.judge : mine.timeout ? false : null) : null;
  const sent = ui.sent || !!mine?.text;
  const left = myTurn ? turnLeft() : null;
  // 時間切れ：自分で「時間切れ」を記録する（誤答扱い）
  if (myTurn && left === 0 && !sent && !mine?.timeout && !QZ.timeoutSent.has(`${ui.id}:${L.turn.seq}`)) {
    QZ.timeoutSent.add(`${ui.id}:${L.turn.seq}`);
    fire(updateDoc(D("quizAnswers", ui.id), { timeout: true }));
  }
  // 押したあとも disabled にはしない（disabled にすると指を離したときのイベントが届かず、キーボードを出せない）。2回目以降は無視する
  ui.btn.disabled = !open && !pressed;
  ui.btn.classList.toggle("pressed", pressed);
  ui.root.classList.toggle("is-pressed", pressed);
  ui.btn.textContent = pressed ? "押した！" : "早押し";
  const timedOut = mine?.timeout || (myTurn && left === 0 && !sent);
  let msg = "";
  if (L.phase !== "question") msg = "";
  else if (!pressed) msg = open ? "" : "締め切りました";
  else if (verdict === false && !L.answerShown && L.phase === "question") msg = timedOut && !mine?.text ? "時間切れ（誤答）" : `「${mine?.text ?? ""}」は誤答でした`;
  else if (sent) msg = `「${mine?.text ?? ui.input.value.trim()}」で解答しました。判定を待っています…`;
  else if (timedOut) msg = "時間切れ（誤答）";
  else if (myTurn) msg = "";
  else if (L.phase === "question") msg = rank ? `${rank}番目（${fmtSec(mine?.reactionMs)}）。前の人が間違えると解答権が回ってきます` : "送信中…";
  ui.info.textContent = msg;
  ui.info.hidden = !msg;
  // 押したら入力欄を出す（解答権が来る前から入力して待てる。送れるのは解答権が来てから）
  const showBox = pressed && L.phase === "question" && !sent && verdict == null && !timedOut;
  ui.box.hidden = !showBox;
  ui.box.classList.toggle("mine", !!myTurn);
  ui.title.textContent = myTurn ? "解答権獲得！" : "解答権を待っています（先に入力できます）";
  ui.count.textContent = myTurn ? `${Math.ceil(left)}` : "";
  ui.count.classList.toggle("hurry", myTurn && left <= 3);
  ui.send.disabled = !myTurn || left === 0 || !ui.input.value.trim();
  ui.input.oninput = () => { ui.send.disabled = !(S.live?.turn?.uid === uid && turnLeft() > 0 && ui.input.value.trim()); };
}

function paintMemberQuiz(full = true) {
  if (!full) { updateQuizTicks(); return; }
  // 答えを入力している最中は、同じ問題・同じ段階のあいだ作り直さない（キーボードが閉じないように）
  // 早押しの出題中と問題読みの間も、動く部分（文字・ボタン・秒数）は個別に書き換えるので作り直さない
  // （押した直後に作り直すと、入力欄にキーボードが出ないことがある）
  const typing = document.activeElement?.classList?.contains("ql-input");
  const live = S.live;
  const steady = live && ((live.phase === "question" && live.q?.type === "buzz") || live.phase === "reading");
  if ((typing || steady) && QZ.lastPaint === `${live?.seq}:${live?.phase}` && !QZ.hidden && amAnswerer() && document.querySelector(".quiz-live")) { updateQuizTicks(); return; }
  QZ.lastPaint = `${S.live?.seq}:${S.live?.phase}`;
  let el = document.querySelector(".quiz-live");
  let fab = document.querySelector(".quiz-fab");
  const L = S.live;
  const active = !!(L && L.phase !== "off" && amAnswerer());
  if (!active) { el?.remove(); fab?.remove(); return; }
  if (QZ.hidden) {
    el?.remove();
    if (!fab) document.body.append(h("button", { class: "quiz-fab", onclick: () => { QZ.hidden = false; paintMemberQuiz(); } }, icon("quiz"), "クイズに戻る"));
    return;
  }
  fab?.remove();
  if (!el) { el = h("div", { class: "quiz-live", role: "dialog", "aria-label": "クイズ" }); document.body.append(el); }

  const uid = S.user.uid;
  const q = L.q;
  const mine = L.phase === "lobby" || L.phase === "results" ? null : S.quizAnswers.get(`${L.quizId}_${L.index}_${uid}`);
  const rem = L.phase === "question" ? remainingSec(L, true) : null;
  const locked = L.phase !== "question" || rem === 0;
  const readingNow = L.phase === "reading";

  const head = h("div", { class: "ql-head" },
    h("div", { class: "ql-title" }, L.title),
    L.phase === "lobby" || L.phase === "results" ? null : h("div", { class: "ql-meta" }, `第${L.index + 1}問 / ${L.total} ・ ${QTYPE[q?.type] ?? ""} ・ ${q?.points ?? 10}点`),
    h("button", { class: "ql-close", "aria-label": "閉じる", onclick: () => { QZ.hidden = true; paintMemberQuiz(); } }, icon("xmark")));
  const timer = rem != null ? h("div", { class: "ql-timer" }, h("div", { class: "bar", style: `width:${(rem / (q.time || 1)) * 100}%` }), h("span", null, `${Math.ceil(rem)}秒`)) : null;

  let body;
  if (L.phase === "lobby") {
    body = h("div", { class: "ql-center" }, h("div", { class: `ql-big${firstTime(`ml:${L.seq}`) ? " enter" : ""}` }, "まもなく始まります"), h("div", { class: "ql-sub" }, `${S.me?.name ?? ""} さん、準備はいいですか？`));
  } else if (L.phase === "results") {
    const rows = (L.scores ?? []).map((r) => ({ ...r, name: memberName(r.uid) }));
    const me = rows.findIndex((r) => r.uid === uid);
    body = h("div", { class: "ql-center" },
      h("div", { class: "ql-sub" }, "あなたの得点"),
      h("div", { class: `ql-score${firstTime(`ms:${L.seq}`) ? " enter" : ""}` }, me >= 0 ? rows[me].score : 0, h("small", null, "点")),
      me >= 0 ? h("div", { class: "ql-sub" }, `${rows.filter((r) => r.score > rows[me].score).length + 1}位 / ${rows.length}人`) : null,
      h("ol", { class: "ql-top" }, rows.slice(0, 3).map((r) => h("li", null, h("span", null, r.name), h("b", null, `${r.score}点`)))));
  } else {
    const myShown = isShown(L, uid);
    const correctNow = myShown ? (q.type === "buzz" ? (typeof mine?.judge === "boolean" ? mine.judge : mine?.timeout ? false : null) : autoJudge({ ...q, answer: L.answer }, mine ?? {}) && !!mine) : null;
    const judgeOverride = typeof mine?.judge === "boolean" ? mine.judge : null;
    const verdict = myShown ? (judgeOverride ?? correctNow) : null;
    let input;
    if (readingNow) {
      input = h("div", { class: "ql-reading" }, h("span", { class: "live-dot" }), "問題を読んでいます。まもなく解答開始です");
    } else if (q.type === "choice") {
      input = h("div", { class: "ql-choices" }, (q.choices ?? []).map((c, k) => h("button", {
        class: `ql-choice${mine?.choice === k ? " picked" : ""}${answerVisible(L) && L.answer === k ? " correct" : ""}`,
        style: `--c:${CHOICE_COLORS[k]}`, disabled: locked,
        onpointerdown: (e) => { e.preventDefault(); quizAnswer({ choice: k }); },
      }, h("span", { class: "mark" }, CHOICE_MARKS[k]), q.phone !== false ? h("span", { class: "txt" }, c) : null)));
    } else if (q.type === "text") {
      const key = `${L.seq}`;
      let ta = QZ.textDraft.get(key);
      if (!ta) {
        ta = h("textarea", { class: "ql-input", rows: "2", placeholder: "答えを入力" });
        ta.value = mine?.text ?? "";
        QZ.textDraft.clear();
        QZ.textDraft.set(key, ta);
      }
      ta.disabled = locked;
      input = h("div", { class: "ql-textbox" }, ta,
        h("button", { class: "ql-send", disabled: locked, onclick: () => { if (ta.value.trim()) quizAnswer({ text: ta.value.trim() }); } }, mine ? "送り直す" : "送信"));
    } else {
      input = buzzPanel(L);
    }
    const status = q.type === "buzz" ? (L.phase === "closed" ? "締め切りました。正解発表を待っています…" : "") : L.phase === "question"
      ? (mine ? (q.type === "choice" ? "回答しました（締切まで変えられます）" : q.type === "text" ? "送信しました（締切まで送り直せます）" : "") : rem === 0 ? "時間切れ" : "")
      : L.phase === "closed" ? "締め切りました。正解発表を待っています…" : "";
    body = h("div", { class: "ql-q" },
      q.phone !== false ? readTextEl(L, `ql-qtext${firstTime(`mq:${L.seq}`) ? " enter" : ""}`) : h("div", { class: "ql-qtext muted" }, "問題は前の画面を見てください"),
      input,
      status ? h("div", { class: "ql-status" }, status) : null,
      L.phase === "reveal" ? h("div", { class: `ql-verdict${verdict === true ? " ok" : verdict === false ? " ng" : ""}${firstTime(`mv:${L.seq}:${myShown}`) ? " enter" : ""}` },
        myShown ? markSvg(verdict, firstTime(`me:${L.seq}:${verdict}`), "mark-phone") : null,
        h("div", { class: "ql-vtext" }, !myShown ? "発表を待っています…" : verdict === true ? "正解！" : verdict === false ? "不正解…" : mine ? "判定を待っています" : "未回答"),
        answerVisible(L) && q.type !== "choice" && L.answer ? h("div", { class: "ql-ans" }, `正解：${L.answer}`) : null) : null);
  }
  setKids(el, head, timer, body);
}

// 全体の描画や Firestore の更新のたびに呼ぶ（full = false のときはタイマーの表示だけ更新する）
function paintQuizLive(full = true) {
  if (S.isAdmin) paintPresenter(full);
  else paintMemberQuiz(full);
}

// タイマーの数字・問題読みの文字・解答権の残り秒数だけを書き換える。画面全体を作り直すと、アニメーションがやり直しになったり、
// 押している最中のボタンや入力中の欄が作り直されて操作が消えたりするため
function updateQuizTicks() {
  const L = S.live;
  if (!L) return;
  for (const el of document.querySelectorAll("[data-read]")) paintRead(el, L);
  for (const el of document.querySelectorAll("[data-turncount]")) {
    const n = Math.ceil(turnLeft());
    el.textContent = el.classList.contains("op-turn-count") ? `残り ${n} 秒` : n;
    el.classList.toggle("hurry", n <= 3);
  }
  if (!S.isAdmin) updateBuzzPanel();
  if (L.phase !== "question" || !L.q?.time) return;
  if (S.isAdmin) {
    const rem = remainingSec(L, false);
    for (const t of document.querySelectorAll(".pr-timer, .op-timer")) {
      t.textContent = t.classList.contains("op-timer") ? `${Math.ceil(rem)}秒` : Math.ceil(rem);
      t.classList.toggle("hurry", rem <= 5);
    }
  } else {
    const rem = remainingSec(L, true);
    const bar = document.querySelector(".ql-timer .bar");
    const txt = document.querySelector(".ql-timer span");
    if (bar) bar.style.width = `${(rem / (L.q.time || 1)) * 100}%`;
    if (txt) txt.textContent = `${Math.ceil(rem)}秒`;
  }
}

// 解答者側：時間切れになった瞬間だけ全体を描き直してボタンを止める。それ以外はタイマー・問題読み・解答権の秒数だけ
setInterval(() => {
  const L = S.live;
  if (S.isAdmin || !(L?.phase === "question" || L?.phase === "reading") || !amAnswerer() || QZ.hidden) return;
  if (L.phase === "question" && L.q?.time && remainingSec(L, true) === 0 && QZ.lockedSeq !== L.seq) { QZ.lockedSeq = L.seq; paintMemberQuiz(true); return; }
  updateQuizTicks();
}, 200);

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
  { key: "quiz", icon: "quiz", label: "クイズ", view: quizManager, sheet: true },
  { key: "map", icon: "map", label: "地図", view: mapView, sheet: true },
  { key: "settings", icon: "gear", label: "設定", view: settingsView, sheet: true },
];

const desktopQuery = window.matchMedia("(min-width: 1100px)");
desktopQuery.addEventListener("change", () => { shell = null; S.sheet = null; scheduleRender(); });

let shell = null;
let renderQueued = false;

let renderKinds = new Set();
function scheduleRender(kind = "all") {
  renderKinds.add(kind);
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const kinds = renderKinds;
    renderKinds = new Set();
    render(kinds);
  });
}

// 参加者用：所属チームと所持ポイントを右上に常に表示する
function meChip() {
  const el = h("div", { class: "me-chip", "aria-label": "あなたの所属チームとポイント" });
  el.paint = () => {
    const uid = S.user.uid;
    const teams = sortedSets().map((s) => S.teams.get(teamOfIn(uid, s.id))).filter(Boolean);
    const points = ptTotal("user", uid);
    el.replaceChildren(
      ...(S.config.locShare ? [h("span", { class: `me-loc${LOC.error ? " err" : ""}`, title: LOC.error ? "位置を取得できていません" : "位置を共有中" }, icon("locate"))] : []),
      ...teams.map((t) => h("span", { class: "me-team", title: teamName(t.id) }, dot(t.color), t.name)),
      h("span", { class: "me-points" }, points, h("small", null, "pt")),
    );
  };
  return el;
}

// 上部の旅行名。押すと旅行を切り替えられる（管理者は「新しい旅行を作る」も）
function profileSwitcher(cls = "") {
  const text = h("span", { class: "profile-text" });
  const sel = h("select", { class: "profile-select", "aria-label": "旅行を切り替える" });
  sel.addEventListener("change", () => {
    if (sel.value === "__new") { sel.value = S.pid; guard(null, createProfile); return; }
    switchProfile(sel.value);
  });
  const wrap = h("div", { class: `profile-switch ${cls}` }, text, icon("chevron", "profile-chev"), sel);
  wrap.paint = () => {
    const list = S.isAdmin ? sortedProfiles() : S.myProfiles;
    const multi = S.isAdmin || list.length > 1;
    text.textContent = S.config.title || APP_TITLE;
    wrap.classList.toggle("multi", multi);
    sel.hidden = !multi;
    if (!multi || document.activeElement === sel) return;
    fillSelect(sel, [...list.map((p) => ({ value: p.id, label: p.name })), ...(S.isAdmin ? [{ value: "__new", label: "＋ 新しい旅行を作る…" }] : [])]);
    if ([...sel.options].some((o) => o.value === S.pid)) sel.value = S.pid;
  };
  return wrap;
}

// 参加者が複数の旅行に入っているときの選択画面
function profilePicker() {
  return h("div", { class: "login", "data-view": "picker" },
    h("img", { class: "app-icon", src: "icon-192.png", alt: "" }),
    h("h1", null, "どの旅行を開きますか？"),
    h("p", { class: "secondary" }, "あとから設定で切り替えられます。"),
    h("div", { class: "group-body" }, S.myProfiles.map((p) =>
      h("button", { class: "cell cell-button profile-row", "data-profile": p.id, onclick: () => { S.pid = null; switchProfile(p.id); } },
        h("span", { class: "profile-name" }, p.name), icon("chevron")))),
    h("button", { class: "text-btn", style: "margin: 20px auto 0", onclick: () => signOut(auth) }, "ログアウト"),
  );
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
  const appName = profileSwitcher("app-name");
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
      appName.paint();
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
  const title = profileSwitcher("desk-title");
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
      title.paint();
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
  const switcher = profileSwitcher("big");
  const title = h("h1", { class: "large-title" }, switcher);
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
      switcher.paint();
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

function render(kinds) {
  if (!S.authReady) return;
  // 位置・クイズだけが変わったときは、開いている小窓とクイズの画面だけ描き直す
  if (kinds && !kinds.has("all") && shell && S.user) {
    if ((kinds.has("loc") && S.sheet?.key === "map") || (kinds.has("quiz") && S.sheet?.key === "quiz")) S.sheet.view.update();
    if (kinds.has("quiz")) paintQuizLive();
    return;
  }
  if (!S.user) {
    shell = null;
    closeSheet();
    if (!document.querySelector("[data-view=login]")) $app.replaceChildren(loginView());
    return;
  }
  if (!S.isAdmin) {
    if (!S.pid) {
      shell = null;
      if (S.myProfiles.length > 1) { if (!document.querySelector("[data-view=picker]")) $app.replaceChildren(profilePicker()); return; }
      return $app.replaceChildren(h("div", { class: "splash" }, h("div", { class: "spinner" })));
    }
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
  paintQuizLive();
}

const $app = document.getElementById("app");
if (USE_EMULATOR) window.__render = render; // テスト用（描画時間の計測）

if ("serviceWorker" in navigator && !USE_EMULATOR) {
  // 新しい版が公開されたら、切り替わった時点でページを1回だけ読み直す（初回のインストール時は読み直さない）
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
    .then((reg) => {
      // 開きっぱなしでも新しい版に気づけるよう、画面に戻ってきたときに確認する
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
    })
    .catch((e) => console.warn("SW", e));
}
