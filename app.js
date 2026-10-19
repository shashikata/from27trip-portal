import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, initializeAuth, inMemoryPersistence, connectAuthEmulator,
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, updatePassword, EmailAuthProvider, reauthenticateWithCredential,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  collection, doc, query, where, onSnapshot, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, deleteField,
  writeBatch, serverTimestamp, arrayUnion, increment, orderBy, limit, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, APP_TITLE, EMAIL_DOMAIN, ADMIN_IDS, USE_EMULATOR, ACCOUNT_SWITCH } from "./config.js";

// ---------------------------------------------------------------- Firebase

// アカウントの切り替え（config.js の ACCOUNT_SWITCH の組み合わせだけ）。
// 管理者と参加者で別々の Firebase のインスタンスを使い、それぞれのログイン状態を端末に残しておく。
// 切り替えは「どちらを使うか」を端末に保存して読み込み直すだけなので、パスワードをアプリが保存することはない
const SWITCH_KEY = "island.activeAccount"; // "alt" なら参加者側（別インスタンス）
const SWITCH_FROM_KEY = "island.switchFrom"; // 切り替え元の管理者ID
const SWITCH_TARGET_KEY = "island.switchTarget"; // 切り替え先の参加者ID（名前から探したときのため）
const altSession = (() => { try { return localStorage.getItem(SWITCH_KEY) === "alt"; } catch { return false; } })();
const switchFrom = (() => { try { return localStorage.getItem(SWITCH_FROM_KEY); } catch { return null; } })();
const switchTarget = altSession && switchFrom ? (() => {
  const spec = (ACCOUNT_SWITCH ?? {})[switchFrom];
  if (typeof spec === "string") return spec;
  try { return localStorage.getItem(SWITCH_TARGET_KEY); } catch { return null; }
})() : null;
function switchAccount(toAlt, fromId, targetId) {
  try {
    localStorage.setItem(SWITCH_KEY, toAlt ? "alt" : "main");
    if (fromId) localStorage.setItem(SWITCH_FROM_KEY, fromId);
    if (targetId) localStorage.setItem(SWITCH_TARGET_KEY, targetId);
  } catch { return toast("この端末では切り替えられません（保存できません）", true); }
  location.reload();
}

// 起動時、Firebase は保存済みのログインを「アカウント情報の再取得（＋期限切れならトークン更新）」の通信が終わるまで使わせない。
// 電波が弱いとここで最大30秒ぐるぐるするので、起動直後のこの2つだけは通信せずに失敗扱いにして、保存済みのログインですぐ始める。
// （通信の失敗は Firebase が「ログインはそのまま」と扱う。トークンは、データを取りに行くときに Firebase が改めて更新する）
let authBooting = true;
{
  const realFetch = self.fetch.bind(self);
  self.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (authBooting && /accounts:lookup|securetoken\.googleapis\.com/.test(url)) return Promise.reject(new TypeError("skipped at startup"));
    return realFetch(input, init);
  };
}

const fbApp = altSession ? initializeApp(firebaseConfig, "switch-alt") : initializeApp(firebaseConfig);
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

// ---- 確定前ページ（pid = "lobby"）
// 旅行が決まる前の人が見るページ。中身は profiles/lobby/ の下に、ほかの旅行と同じ形で置く。
//   profiles/lobby/members/{uid}  { name, loginId, trips: { pid: true(確定) | false(割り当てただけ) } }
// 確定前ページの members に入っている人は、確定した旅行だけを開ける（それ以外の旅行の登録は残っていても開かない）。
// 旅行はいくつでも割り当てられ、確定したあとでも追加・取り消しができる。
// 確定すると、確定前ページのお知らせ・出欠・集金は旅行のページにも合流して表示される。
// 合流したものは id の頭に "L:" を付けて同じ一覧（S.polls など）に入れ、書き込むときは確定前ページの場所に戻す。
const LOBBY = "lobby";
const inLobby = () => S.pid === LOBBY;
const isL = (id) => typeof id === "string" && id.startsWith("L:");
// ほかの旅行のページから合流したもの（集金）は "X:{旅行のid}:" を付ける
const isExt = (id) => typeof id === "string" && (id.startsWith("L:") || id.startsWith("X:"));
const extPid = (id) => (isL(id) ? LOBBY : id.slice(2, id.indexOf(":", 2)));
const rawId = (id) => (!isExt(id) ? id : isL(id) ? id.slice(2) : id.slice(id.indexOf(":", 2) + 1));
const pageBase = (pid) => (pid && pid !== ROOT ? ["profiles", pid] : []);
const DX = (name, id) => (isExt(id) ? doc(db, ...pageBase(extPid(id)), name, rawId(id)) : D(name, id));
const CX = (name, id) => (isExt(id) ? collection(db, ...pageBase(extPid(id)), name) : C(name));
const LC = (name) => collection(db, "profiles", LOBBY, name);
const LD = (name, id) => doc(db, "profiles", LOBBY, name, id);
const tripsOf = (m) => m?.trips ?? {};
// 旅行の分と確定前ページの分を合わせて S.polls などに入れる
const mergeSrc = (key, part, val) => { S.lobbySrc[key] = { ...S.lobbySrc[key], [part]: val }; S[key] = new Map(Object.values(S.lobbySrc[key]).flatMap((m) => [...(m ?? [])])); };
// 管理者：旅行のページに出す確定前ページの集金・アンケートは、この旅行の参加者が対象に入っているものだけ
// 管理者：旅行のページに出す確定前ページのお知らせ（全員宛てと、この旅行の参加者宛てのもの）
function refreshAdminLobbyAnn() {
  if (!S.lobbyAnnRaw) return;
  // この旅行にまだ誰も確定していないときは出さない（関係する人がいないため）
  S.annSrc.lobby = S.members.size ? new Map([...S.lobbyAnnRaw].filter(([, a]) => a.scope === "all" || (a.scope === "user" && S.members.has(a.target)))) : new Map();
  DATA_VER++;
}
const relevantHere = (x) => !x.fromLobby || !x.targets || x.targets.some((uid) => S.members.has(uid));
const confirmedTrips = (m) => Object.keys(tripsOf(m)).filter((k) => tripsOf(m)[k] === true);
// 確定前ページのデータを合流用に読み込む（id と、ほかのデータを指す欄に "L:" を付ける）
const toMapX = (snap, pid, refs = []) => {
  const pre = pid === LOBBY ? "L:" : `X:${pid}:`;
  const m = new Map();
  snap?.forEach((d) => {
    const v = { ...d.data({ serverTimestamps: "estimate" }), id: `${pre}${d.id}`, fromLobby: pid === LOBBY, fromPage: pid };
    for (const f of refs) if (v[f]) v[f] = `${pre}${v[f]}`;
    m.set(v.id, v);
  });
  return m;
};
const toMapL = (snap, refs = []) => toMapX(snap, LOBBY, refs);
// ページの名前（「確定前ページより」「'27春旅行より」のタグに使う）
const pageName = (pid) => (pid === LOBBY ? LOBBY_NAME : S.profiles.get(pid)?.name ?? S.myProfiles.find((p) => p.id === pid)?.name ?? "別の旅行");
const fromTag = (pid) => h("span", { class: "from-tag" }, `${pageName(pid)}より`);

// ---- ほかのページの集金・立て替え
// 確定前ページ・ほかの旅行のページで作った集金と立て替えも、終わっていないものはこのページに「〇〇より」を付けて出す。
//   集金   : S.payments に "L:" / "X:{pid}:" 付きで合流（書き込みは DX で元のページへ）。対象者全員が入金済み・免除になったら出さない
//   立て替え: ページごとに S.extExpenses に置き、そのページの精算が残っている間だけ出す
// 管理者はすべてのページ、参加者は自分が入っているページの分（自分が対象のものだけ表示）
function syncExtPages() {
  if (!S.user || !S.pid) return;
  const uid = S.user.uid;
  const pages = S.isAdmin
    ? [...new Set([ROOT, ...S.profiles.keys()])].filter((p) => p !== S.pid)
    : S.myProfiles.map((p) => p.id).filter((p) => p !== S.pid);
  const quiet = (fn) => (s, err) => { if (!err && s) fn(s); };
  for (const p of pages) {
    const col = (name) => collection(db, ...pageBase(p), name);
    const k = `x:${p}:`;
    listen(`${k}members`, col("members"), quiet((s) => { S.extMembers.set(p, toMap(s)); }));
    listen(`${k}expenses`, col("expenses"), quiet((s) => { S.extExpenses.set(p, toMap(s)); }));
    if (p === LOBBY) continue; // 確定前ページの集金は、旅行のページでは前から合流している（lPayments）
    listen(`${k}payments`, col("payments"), quiet((s) => mergeSrc("payments", `x:${p}`, toMapX(s, p))));
    listen(`${k}payReports`, S.isAdmin ? col("payReports") : query(col("payReports"), where("uid", "==", uid)),
      quiet((s) => mergeSrc("payReports", `x:${p}`, toMapX(s, p, ["paymentId"]))));
  }
}
// ページの参加者（ID 順。割り勘の端数の付け方をそのページと同じにするため）
const extMemberCache = new Map();
function pageMembers(pid) {
  const src = S.extMembers.get(pid) ?? (pid === LOBBY ? S.lobbyMembers : null);
  if (!src) return null;
  const hit = extMemberCache.get(pid);
  if (hit && hit.src === src) return hit.list;
  const list = [...src.entries()].map(([id, m]) => ({ id, ...m })).sort((a, b) => byNatural(a.loginId, b.loginId));
  extMemberCache.set(pid, { src, list });
  return list;
}

const idToEmail = (id) => (id.includes("@") ? id : `${id}@${EMAIL_DOMAIN}`).toLowerCase();
const emailToId = (email) => (email || "").replace(`@${EMAIL_DOMAIN}`, "");
const isAdminEmail = (email) => ADMIN_IDS.map(idToEmail).includes((email || "").toLowerCase());
// 管理者の表示名（admin1 → 管理者1 …）
const adminName = (email) => { const i = ADMIN_IDS.indexOf(emailToId(email)); return i >= 0 ? `管理者${i + 1}` : "管理者"; };

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
  attrDefs: new Map(),       // 管理者：参加者の属性の項目 attrDefs/{id} { name, options: [..], order }
  memberAttrs: new Map(),    // 管理者：参加者ごとの属性 memberAttrs/{uid} { values: { 項目id: 値 } }
  ptQrs: new Map(),          // ポイントQR ptQrs/{id}（管理者）
  ptClaims: new Map(),       // ポイントQRの受け取り記録 ptClaims/{id}（管理者）
  locGroups: new Map(),      // 位置の共有グループ locGroups/{id} { name, members: [uid] }（管理者が作る）
  mapPins: new Map(),        // 管理者が地図に刺したピン mapPins/{id}
  polls: new Map(),          // 出欠などのアンケート polls/{id}
  votes: new Map(),          // 回答 votes/{pollId}_{uid}（参加者は自分の分だけ）
  pollTally: new Map(),      // 参加者：集計を見せるアンケートの回答（pollId -> [{ choice, order }]）
  payments: new Map(),       // 集金 payments/{id}
  msgRecent: new Map(),      // チャット：新しい順に80件（未読の数・一覧に使う）
  chatMsgs: new Map(),       // チャット：開いているチャットの全メッセージ
  expenses: new Map(),       // 立て替えと支払いの記録 expenses/{id}
  checklists: new Map(),     // チェックリストのセクション checklists/{id}
  checks: new Map(),         // チェック checks/{listId}_{itemId}_{uid|shared}（参加者は自分の分と共有の分）
  payReports: new Map(),     // 参加者からの「送金しました」 payReports/{paymentId}_{uid}（参加者は自分の分だけ）
  quizzes: new Map(),        // 管理者：クイズ quizzes/{id}
  live: null,                // 進行中のクイズ live/quiz
  quizAnswers: new Map(),    // 表示中の問題への解答 quizAnswers/{quizId}_{index}_{uid}
  quizSabo: new Map(),       // 妨害の申し込み quizSabo/{id}
  quizBets: new Map(),       // 賭け quizBets/{id}
  acks: new Map(),           // 「見ました」 acks/{annId}_{uid}（参加者は自分の分だけ）
  lobbySrc: {},              // 参加者：旅行の分と、合流した確定前ページの分（S.polls などはこの2つを合わせたもの）
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
const RENDER_KIND = { msgRecent: "chat", chatOpen: "chat", locations: "loc", mapPins: "loc", live: "quiz", quizAnswers: "quiz", quizSabo: "quiz", quizBets: "quiz" };

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
      // 中身は同じで「端末の保存分 → サーバーで確認済み」に変わっただけなら、上の通信状態の表示だけ直す
      // （起動直後は受信の数だけこれが届くので、毎回すべて描き直すと重い）
      if (!changed && prev && prev.pending === meta.pending) { onData(snap); scheduleRender("status"); return; }
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
  listen("members", C("members"), (s) => { S.members = toMap(s); refreshAdminLobbyAnn(); });
  listen("sets", C("teamSets"), (s) => { S.sets = toMap(s); });
  listen("teams", C("teams"), (s) => { S.teams = toMap(s); });
  listen("memberships", C("memberships"), (s) => { S.memberships = toMap(s); });
  listen("ann", C("announcements"), (s) => { S.annSrc.all = toMap(s); });
  listen("logs", C("pointLogs"), (s) => { S.logSrc.all = toMap(s); scheduleStatsHeal(); });
  listen("stats", D("stats", "points"), (s) => { S.stats = s?.exists() ? s.data() : null; scheduleStatsHeal(); });
  listen("acks", C("acks"), (s) => { if (s) mergeSrc("acks", "trip", toMap(s)); });
  listen("notes", C("notes"), (s) => { S.notes = toMap(s); });
  listen("quizzes", C("quizzes"), (s) => { S.quizzes = toMap(s); });
  listen("polls", C("polls"), (s) => { if (s) mergeSrc("polls", "trip", toMap(s)); });
  listen("pollReqs", C("pollRequests"), (s) => { if (s) S.pollReqs = toMap(s); });
  listen("votes", C("votes"), (s) => { if (s) mergeSrc("votes", "trip", toMap(s)); });
  listen("payments", C("payments"), (s) => { if (s) mergeSrc("payments", "trip", toMap(s)); });
  listen("payReports", C("payReports"), (s) => { if (s) mergeSrc("payReports", "trip", toMap(s)); });
  // 旅行のページでも、確定前ページの集金・出欠を（この旅行の参加者の分だけ）見て管理できるようにする。書き込みは確定前ページへ
  if (pid !== LOBBY) {
    const quiet = (fn) => (s, err) => { if (!err && s) fn(s); };
    listen("lPolls", LC("polls"), quiet((s) => mergeSrc("polls", "lobby", toMapL(s))));
    listen("lVotes", LC("votes"), quiet((s) => mergeSrc("votes", "lobby", toMapL(s, ["pollId"]))));
    listen("lPayments", LC("payments"), quiet((s) => mergeSrc("payments", "lobby", toMapL(s))));
    listen("lPayReports", LC("payReports"), quiet((s) => mergeSrc("payReports", "lobby", toMapL(s, ["paymentId"]))));
    // 確定前ページのお知らせ（この旅行の参加者が宛先のもの）と「見ました」、参加者の確定状況
    listen("lAnn", LC("announcements"), quiet((s) => { S.lobbyAnnRaw = toMapL(s); refreshAdminLobbyAnn(); }));
    listen("lAcks", LC("acks"), quiet((s) => mergeSrc("acks", "lobby", toMapL(s, ["annId"]))));
    listen("lMembers", LC("members"), quiet((s) => { S.lobbyMembers = toMap(s); DATA_VER++; }));
  }
  listen("expenses", C("expenses"), (s) => { S.expenses = toMap(s); });
  if (pid === LOBBY) listen("videos", C("videos"), (s) => { if (s) S.videos = toMap(s); });
  listen("checklists", C("checklists"), (s) => { S.checklists = toMap(s); });
  listen("checks", C("checks"), (s) => { S.checks = toMap(s); });
  listen("locGroups", C("locGroups"), (s) => { if (s) S.locGroups = toMap(s); });
  listen("ptQrs", C("ptQrs"), (s) => { if (s) S.ptQrs = toMap(s); });
  listen("attrDefs", C("attrDefs"), (s) => { if (s) S.attrDefs = toMap(s); });
  listen("memberAttrs", C("memberAttrs"), (s) => { if (s) S.memberAttrs = toMap(s); });
  listen("ptClaims", C("ptClaims"), (s) => { if (s) S.ptClaims = toMap(s); });
  // パスワードを本人が変えた記録（印刷に使う。変えた人の分だけなので少ない）
  listen("pwChanged", C("pwChanged"), (s) => { if (s) S.pwChangedIds = new Set(s.docs.map((d) => d.id)); });
  listen("msgRecent", query(C("messages"), orderBy("at", "desc"), limit(300)), (s) => { if (s) S.msgRecent = toMap(s); });
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
  let lobbyWas = null; // 確定前ページ：前回受け取った自分の状態（確定した瞬間を見つけるため）
  listen("me", D("members", uid), (s, err) => {
    S.me = err ? null : (s.exists() ? s.data() : null);
    S.meErr = err ? err.code ?? "error" : null;
    // 確定前ページを開いている間に旅行が確定したら、その旅行のページへ移る
    if (inLobby() && S.me && s && !s.metadata.fromCache) {
      const now = confirmedTrips(S.me);
      const added = lobbyWas ? now.filter((x) => !lobbyWas.includes(x)) : [];
      if (added.length) {
        const pid = added[0];
        resolveMemberProfiles(uid).then((list) => {
          if (S.user?.uid !== uid || !inLobby()) return;
          setMyProfiles(list);
          if (list.some((x) => x.id === pid)) { toast("旅行が確定しました"); switchProfile(pid); }
        });
      }
      lobbyWas = now;
    }
    if (S.me) startMemberData(uid);
    // この旅行に登録がないときは、入っている旅行をもう一度調べて、あればそちらへ切り替える
    // （前回開いていた旅行から外された・最初の確認が通信の失敗で空だった、などのとき）
    else if (!err && s && !s.metadata.fromCache && !QZ.meRetried?.has(`${uid}:${S.pid}`)) {
      (QZ.meRetried ??= new Set()).add(`${uid}:${S.pid}`);
      const pid = S.pid;
      resolveMemberProfiles(uid).then((list) => {
        if (S.user?.uid !== uid || S.pid !== pid || S.me) return;
        setMyProfiles(list);
        const other = list.filter((x) => x.id !== pid);
        if (other.length === 1) switchProfile(other[0].id);
        else if (other.length > 1) { S.pid = null; shell = null; scheduleRender(); }
      });
    }
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
  // 端末に保存したデータの読み出しは1つずつ順番に行われるので、最初の画面に出るもの（お知らせ・合計・出欠・集金）を先に頼む
  listen("annPinned", query(ann, where("pinned", "==", true)), (s) => { S.feedRaw.pinned = toMap(s); refreshFeed(uid); });
  listenRecent(uid);
  listen("stats", D("stats", "points"), (s) => { S.stats = s?.exists() ? s.data() : null; });
  listen("polls", C("polls"), (s) => { if (s) mergeSrc("polls", "trip", toMap(s)); syncPollTally(); });
  listen("pollReqs", query(C("pollRequests"), where("uid", "==", uid)), (s) => { if (s) S.pollReqs = toMap(s); });
  listen("votes", query(C("votes"), where("uid", "==", uid)), (s) => { if (s) mergeSrc("votes", "trip", toMap(s)); });
  listen("payments", C("payments"), (s) => { if (s) mergeSrc("payments", "trip", toMap(s)); });
  listen("payReports", query(C("payReports"), where("uid", "==", uid)), (s) => { if (s) mergeSrc("payReports", "trip", toMap(s)); });
  // 確定した旅行では、確定前ページのお知らせ・出欠・集金も合流して出す（確定前ページに入っていない人は読めないので何も出ない）
  if (!inLobby()) {
    // 確定が取り消された・別の旅行に変わったときは、確定前ページへ戻す
    listen("lobbyMe", LD("members", uid), (s, err) => {
      if (err || !s?.exists() || s.metadata.fromCache) return;
      const L = s.data();
      // 確定した旅行が増えた・減ったら、切り替えの一覧を更新する。今の旅行が外れたら移る
      const want = confirmedTrips(L).sort().join(",");
      const have = S.myProfiles.filter((x) => x.id !== LOBBY).map((x) => x.id).sort().join(",");
      if (want !== have || tripsOf(L)[S.pid] !== true) {
        resolveMemberProfiles(uid).then((list) => {
          if (S.user?.uid !== uid) return;
          setMyProfiles(list);
          scheduleRender();
          if (!list.some((x) => x.id === S.pid)) { toast("旅行の割り当てが変わりました"); switchProfile(list[0]?.id ?? LOBBY); }
        });
      }
    });
    const quiet = (fn) => (s, err) => { if (!err && s) fn(s); };
    listen("lAnnRecent", query(LC("announcements"), orderBy("createdAt", "desc"), limit(50)), quiet((s) => { S.feedRaw.lobby = toMapL(s); refreshFeed(uid); }));
    listen("lAnnPinned", query(LC("announcements"), where("pinned", "==", true)), quiet((s) => { S.feedRaw.lobbyPinned = toMapL(s); refreshFeed(uid); }));
    listen("lAcks", query(LC("acks"), where("uid", "==", uid)), quiet((s) => mergeSrc("acks", "lobby", toMapL(s, ["annId"]))));
    listen("lPolls", LC("polls"), quiet((s) => { mergeSrc("polls", "lobby", toMapL(s)); syncPollTally(); }));
    listen("lVotes", query(LC("votes"), where("uid", "==", uid)), quiet((s) => mergeSrc("votes", "lobby", toMapL(s, ["pollId"]))));
    listen("lPayments", LC("payments"), quiet((s) => mergeSrc("payments", "lobby", toMapL(s))));
    listen("lPayReports", query(LC("payReports"), where("uid", "==", uid)), quiet((s) => mergeSrc("payReports", "lobby", toMapL(s, ["paymentId"]))));
  }
  listen("acks", query(C("acks"), where("uid", "==", uid)), (s) => { if (s) mergeSrc("acks", "trip", toMap(s)); });
  if (inLobby()) listen("videos", query(C("videos"), where("visible", "==", true)), (s) => { if (s) S.videos = toMap(s); });
  listen("notes", query(C("notes"), where("shared", "==", true)), (s) => { if (s) S.notes = toMap(s); });
  listenLiveQuiz();
  listen("expenses", C("expenses"), (s) => { if (s) S.expenses = toMap(s); });
  listen("checklists", C("checklists"), (s) => { if (s) S.checklists = toMap(s); });
  listen("locGroups", C("locGroups"), (s) => { if (s) S.locGroups = toMap(s); });
  // チェックは「自分の分」と「共有の分」だけ受け取る（全員分を受け取ると、項目数×人数分の読み取りになるため）
  const mergeChecks = () => { S.checks = new Map([...(S.checkSrc?.mine ?? []), ...(S.checkSrc?.shared ?? [])]); };
  listen("checksMine", query(C("checks"), where("uid", "==", uid)), (s) => { if (s) { S.checkSrc = { ...S.checkSrc, mine: toMap(s) }; mergeChecks(); } });
  listen("checksShared", query(C("checks"), where("shared", "==", true)), (s) => { if (s) { S.checkSrc = { ...S.checkSrc, shared: toMap(s) }; mergeChecks(); } });
  // チャットは新しい順に80件だけ（自分に関係するものだけ使う。開いているチャットは別に全部受け取る）
  listen("msgRecent", query(C("messages"), orderBy("at", "desc"), limit(80)), (s) => { if (s) S.msgRecent = toMap(s); }); // 見てよいかは使うときに判定（チームの所属が後から届くため）
  syncExtPages();
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
  S.annSrc = { pinned: keep(S.feedRaw.pinned, annOk), recent: keep(S.feedRaw.ann, annOk), lobbyPinned: keep(S.feedRaw.lobbyPinned, annOk), lobby: keep(S.feedRaw.lobby, annOk) };
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
function statsPatch(logs, sign = 1) {
  const acc = statsOf(logs, sign);
  if (!Object.keys(acc).length) return null;
  const patch = {};
  for (const k in acc) for (const id in acc[k]) for (const v in acc[k][id]) ((patch[k] ??= {})[id] ??= {})[v] = increment(acc[k][id][v]);
  return patch;
}
function addStats(b, logs, sign = 1) {
  const patch = statsPatch(logs, sign);
  if (patch) b.set(D("stats", "points"), patch, { merge: true });
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
  // 管理者：履歴が増えても人数×履歴の計算にならないよう、データが変わったときに1回だけ集計しておく
  if (ptIndex.ver !== DATA_VER) {
    const m = new Map();
    const add = (k, d) => m.set(k, (m.get(k) ?? 0) + d);
    for (const l of merged(S.logSrc)) {
      const d = Number(l.delta) || 0;
      add(`${l.kind}|${l.target}|`, d);
      add(`${l.kind}|${l.target}|${l.visibility}`, d);
    }
    Object.assign(ptIndex, { ver: DATA_VER, m });
  }
  return ptIndex.m.get(`${kind}|${id}|${vis || ""}`) ?? 0;
}
const ptIndex = { ver: -1, m: new Map() };

// 旅行ごとに持つデータを空に戻す（旅行を切り替えるとき・ログアウトしたとき）
function resetProfileData() {
  DATA_VER++;
  Object.assign(S, {
    me: undefined, config: { title: APP_TITLE },
    members: new Map(), sets: new Map(), teams: new Map(), memberships: new Map(), memSrc: {}, acks: new Map(), notes: new Map(), locations: new Map(), locGroups: new Map(), ptQrs: new Map(), ptClaims: new Map(), attrDefs: new Map(), memberAttrs: new Map(),
    annSrc: {}, logSrc: {}, meta: {}, tab: "home", stats: null, feedRaw: {}, annLimit: 50, logLimit: 150,
    quizzes: new Map(), pwChangedIds: null, live: null, quizAnswers: new Map(), quizSabo: new Map(), quizBets: new Map(),
    lobbySrc: {}, lobbyMembers: null, lobbyAnnRaw: null, polls: new Map(), votes: new Map(), pollTally: new Map(), payments: new Map(), payReports: new Map(), expenses: new Map(), extMembers: new Map(), extExpenses: new Map(), videos: new Map(), pollReqs: new Map(), checklists: new Map(), checks: new Map(), checkSrc: {}, mapPins: new Map(), msgRecent: new Map(), chatMsgs: new Map(),
  });
  QZ.answersKey = null;
  TALLY_ONCE.clear();
}

const pidKey = () => `island.pid.${S.user?.uid}`;
const savedPid = () => { try { return localStorage.getItem(pidKey()); } catch { return null; } };
// 入っている旅行の一覧も端末に覚えておき、次に開いたとき通信を待たずに使う
const profsKey = () => `island.profiles.${S.user?.uid}`;
function cachedProfiles() {
  try {
    const v = JSON.parse(localStorage.getItem(profsKey()));
    return Array.isArray(v) && v.length && v.every((p) => p && typeof p.id === "string") ? v : null;
  } catch { return null; }
}
function setMyProfiles(list) {
  S.myProfiles = list;
  if (!S.isAdmin && S.pid && subs.has("msgRecent")) syncExtPages(); // 入っている旅行が増えたら、その旅行の集金・立て替えも受け取る
  try { if (list.length) localStorage.setItem(profsKey(), JSON.stringify(list)); } catch { /* 保存できなくても動く */ }
}
const savePid = (pid) => { try { localStorage.setItem(pidKey(), pid); } catch { /* 保存できなくても動く */ } };

function startProfile() {
  if (S.isAdmin) {
    startAdmin();
    listen("profiles", collection(db, "profiles"), (s) => { if (s) { S.profiles = toMap(s); syncExtPages(); } });
  } else {
    startMember(S.user.uid);
  }
}

// 旅行を切り替える（管理者も参加者も）
if (USE_EMULATOR) window.__switch = (pid) => switchProfile(pid); // テスト用
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
  // 旅行ごとの登録の確認は同時に投げる（1件ずつ待つと、旅行の数だけ通信の往復を待つことになる）
  const [reg, rootMem] = await Promise.all([getDocs(collection(db, "profiles")).catch(() => null), getDoc(doc(db, "members", uid)).catch(() => null)]);
  const regDocs = reg?.docs ?? [];
  const list = [];
  if (rootMem?.exists()) list.push({ id: ROOT, name: regDocs.find((d) => d.id === ROOT)?.data().name ?? APP_TITLE, order: 0 });
  let lobby = null;
  const others = regDocs.filter((d) => d.id !== ROOT);
  const mems = await Promise.all(others.map((d) => getDoc(doc(db, "profiles", d.id, "members", uid)).catch(() => null)));
  others.forEach((d, i) => {
    const m = mems[i];
    if (!m?.exists()) return;
    if (d.id === LOBBY) lobby = m.data();
    else list.push({ id: d.id, name: d.data().name ?? "旅行", order: d.data().order ?? 0 });
  });
  list.sort((a, b) => a.order - b.order);
  // 確定前ページに入っている人は、確定した旅行だけを開ける
  if (!lobby) return list;
  const trips = list.filter((x) => tripsOf(lobby)[x.id] === true);
  return [...trips, { id: LOBBY, name: LOBBY_NAME, order: 1e9, lobby: true }];
}
const LOBBY_NAME = "確定前ページ";

// ---- QRコードでログイン
// 配る用カードのQRコードは「アプリのURL#login=<IDとパスワード>」。開いたらすぐ URL から消して（履歴にも残さない）自動でログインする。
// 「#」より後ろはサーバーに送られないので、GitHub のアクセス記録などにも残らない。
const b64url = (str) => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
const qrLoginUrl = (base, loginId, password) => `${base}#login=${b64url(JSON.stringify({ u: loginId, p: password }))}`;
function takeQrLogin() {
  const m = location.hash.match(/^#login=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const j = JSON.parse(unb64url(m[1]));
    return j?.u && j?.p ? { u: String(j.u), p: String(j.p) } : null;
  } catch { return null; }
}
let qrLogin = takeQrLogin();
// ポイントQR：「アプリのURL#pt=<旅行>.<QRのid>」。ログインしていなくても覚えておき、旅行を開いたら受け取る
let ptPending = null;
function takePtHash() {
  const m = location.hash.match(/^#pt=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (m) {
    history.replaceState(null, "", location.pathname + location.search);
    ptPending = { pid: m[1], id: m[2] };
    try { sessionStorage.setItem("island.pt", JSON.stringify(ptPending)); } catch { /* なし */ }
    return;
  }
  try { ptPending ??= JSON.parse(sessionStorage.getItem("island.pt") ?? "null"); } catch { /* なし */ }
}
takePtHash();
// すでにアプリを開いているタブで QR の URL を開いたとき（ページは読み直されず「#」だけ変わる）
window.addEventListener("hashchange", () => {
  takePtHash();
  scheduleRender();
  qrLogin = takeQrLogin();
  if (qrLogin) handleQrLogin(auth.currentUser);
});
let qrPrefill = null; // QR でのログインに失敗したとき、ログイン画面に ID を入れておく

async function handleQrLogin(user) {
  const q = qrLogin;
  qrLogin = null;
  const current = user ? emailToId(user.email) : null;
  if (current === q.u) return false;
  if (user && !confirm(`いまは ${current} でログインしています。\nQRコードの ${q.u} でログインし直しますか？`)) return false;
  try {
    if (user) await signOut(auth);
    await signInWithEmailAndPassword(auth, idToEmail(q.u), q.p);
    try { sessionStorage.setItem("island.qrlogin", "1"); } catch { /* 保存できなくても動く */ }
    toast(`${q.u} でログインしました`);
  } catch (e) {
    qrPrefill = q.u;
    toast(e?.code === "auth/invalid-credential" || e?.code === "auth/wrong-password"
      ? "QRコードのパスワードは変更されています。今のパスワードでログインしてください" : errMsg(e), true);
    // 失敗したときは、ふつうのログイン画面（またはログアウト後の状態）をそのまま出す
    return !!user;
  }
  return true;
}

onAuthStateChanged(auth, async (user) => {
  authBooting = false;
  // QRコードから開いたときは、先にそのアカウントでログインする（ログインし直すと、この関数がもう一度呼ばれる）
  if (qrLogin && await handleQrLogin(user)) return;
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
  // 前回調べた「入っている旅行」が端末にあれば、それですぐ開く（確認の通信は裏で行い、変わっていたら切り替える）
  const cached = cachedProfiles();
  if (cached) {
    S.myProfiles = cached;
    S.pid = pickPid(cached);
    if (S.pid) startProfile();
  }
  scheduleRender(); // 端末に何もないときは「読み込み中」を出す
  const list = await resolveMemberProfiles(user.uid);
  if (S.user !== user) return; // 途中でログアウトした
  if (!cached) {
    setMyProfiles(list);
    S.pid = pickPid(list);
    if (S.pid) startProfile();
    return scheduleRender();
  }
  if (!list.length) return; // 調べられなかった（電波がない等）：前回の一覧のまま使う
  setMyProfiles(list);
  if (S.pid && list.some((p) => p.id === S.pid)) return scheduleRender(); // 今の旅行はそのまま（切り替えの一覧だけ新しくする）
  // 今の旅行から外れていた・選ぶ画面だった：改めて選び直す
  const next = pickPid(list);
  if (next) return switchProfile(next);
  unlistenAll();
  resetProfileData();
  S.pid = null;
  shell = null;
  scheduleRender();
});

// 参加者が最初に開く旅行を決める
function pickPid(list) {
  const saved = savedPid();
  const trips = list.filter((p) => p.id !== LOBBY);
  // 確定した旅行があれば、確定前ページより旅行を先に開く
  if (list.some((p) => p.id === LOBBY)) return trips.some((p) => p.id === saved) ? saved : trips.length > 1 ? null : trips[0]?.id ?? LOBBY;
  if (list.some((p) => p.id === saved)) return saved;
  if (list.length === 1) return list[0].id;
  if (list.length === 0) return saved || ROOT; // 電波がなくて調べられないときは、前回開いていた旅行で試す
  return null; // 複数あるので選んでもらう
}

window.addEventListener("online", () => scheduleRender());
window.addEventListener("offline", () => scheduleRender());

// ---------------------------------------------------------------- データの参照

// replaceChildren と同じだが、null / false は飛ばす（そのまま渡すと "null" という文字が出てしまう）
const setKids = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

// 並べ替えの比較器は1つ作って使い回す（localeCompare に言語を渡すと毎回作り直すので、人数が多いと重い）
const jaCollator = new Intl.Collator("ja", { numeric: true });
const byNatural = (a, b) => jaCollator.compare(String(a), String(b));
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
// チームのリーダー（表示だけ。チームから外れた人は出さない）
const teamLeader = (t) => (t?.leader && membersOfTeam(t.id).some((m) => m.id === t.leader) ? t.leader : null);
// 役職（チーム表ごと。teamSets/{id}.roles = { uid: "会計" }。空なら役職なし）
const roleOf = (setId, uid) => S.sets.get(setId)?.roles?.[uid] ?? "";
const withRole = (t, m) => { const r = roleOf(t.setId, m.id); return r ? `${m.name}（${r}）` : m.name; };
// リーダーを先頭にした名前の並び
const teamNamesText = (t, ms) => {
  const L = teamLeader(t);
  return [...ms].sort((a, b) => (b.id === L) - (a.id === L)).map((m) => (m.id === L ? `👑${withRole(t, m)}` : withRole(t, m))).join("・");
};
const myTeamIds = (uid) => membershipsOf((m) => m.uid === uid && S.teams.has(m.teamId)).map((m) => m.teamId);
const memberName = (uid) => S.members.get(uid)?.name ?? extMemberName(uid) ?? "（削除済み）";
const extMemberName = (uid) => {
  for (const m of S.extMembers.values()) if (m.get(uid)?.name) return m.get(uid).name;
  return S.lobbyMembers?.get(uid)?.name ?? null;
};
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
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  yen: '<path d="M7 4l5 7 5-7M12 11v9M8 13.5h8M8 17h8"/>',
  map: '<path d="M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2-6-2Z"/><path d="M9 4.5v13M15 6.5v13"/>',
  locate: '<circle cx="12" cy="12" r="3.5"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22"/>',
  quiz: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7"/><circle cx="12" cy="17" r=".9" fill="currentColor"/>',
  play: '<path d="M8 5.5v13l10.5-6.5L8 5.5Z"/>',
  arrows: '<path d="M4 8h15l-3.5-3.5M20 16H5l3.5 3.5"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="m3.5 6.5 1.2 1.2L7 5.3M3.5 12l1.2 1.2L7 10.8M3.5 17.5l1.2 1.2L7 16.3"/>',
  chat: '<path d="M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 3.5V16.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z"/><path d="M8 10h8M8 13h5"/>',
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
  // 確定前ページのお知らせを旅行のページで見るときは、確定前ページの参加者全員で数える
  if (a.fromLobby && S.lobbyMembers) {
    const lm = [...S.lobbyMembers.values()].sort((x, y) => byNatural(x.loginId, y.loginId));
    return a.scope === "user" ? lm.filter((m) => m.id === a.target) : lm;
  }
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
        ? deleteDoc(DX("acks", ackId))
        : setDoc(DX("acks", ackId), { annId: rawId(a.id), uid, at: serverTimestamp() })),
    }, done ? [icon("check"), "見ました"] : "見ました");
  }
  const audience = ackAudience(a);
  const seen = audience.filter((m) => S.acks.has(`${a.id}_${m.id}`));
  const notYet = audience.filter((m) => !S.acks.has(`${a.id}_${m.id}`));
  const details = h("details", { class: "ack-list", open: openAckLists.has(a.id) },
    h("summary", null, icon("check"), `見た人 ${seen.length} / ${audience.length}人${a.fromLobby ? "（確定前ページ全体）" : ""}`),
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
    admin && a.fromLobby ? h("div", { class: "cell-sub from-lobby" }, "確定前ページのお知らせ（固定・削除は確定前ページで）") : null,
    admin && !a.fromLobby ? h("div", { class: "ann-actions" },
      h("button", { class: "text-btn", onclick: () => openShareImage("ann", a) }, icon("photo"), "報告用の画像"),
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
  const body = h("textarea", { class: "plain note-textarea", rows: "12", placeholder: "例：ビーチフラッグ 1位 +10 / 2位 +6 / 3位 +3" });
  // 書いた分だけ縦に伸ばす（スクロールしないと読めない狭い欄にしない）
  const grow = () => {
    if (!body.isConnected || !body.offsetWidth) return; // 見えていない間は測れないので、見えたとき（下の監視）に伸ばす
    body.style.height = "auto";
    body.style.height = `${body.scrollHeight + 4}px`;
  };
  body.addEventListener("input", grow);
  body.addEventListener("focus", grow);
  // 画面に出たとき・横幅が変わったとき（折り返しが変わる）にも伸ばし直す
  let lastW = 0;
  if (window.ResizeObserver) new ResizeObserver(() => { if (body.offsetWidth && body.offsetWidth !== lastW) { lastW = body.offsetWidth; grow(); } }).observe(body);
  const grid = h("div", { class: "table-wrap" });
  const saveBtn = h("button", { class: "text-btn", disabled: true }, "保存");
  const markDirty = () => { dirty = true; saveBtn.disabled = false; el.classList.add("dirty"); };
  title.addEventListener("input", markDirty);
  body.addEventListener("input", markDirty);

  const edit = (fn) => { fn(); markDirty(); paintGrid(); };
  const swap = (a, i, j) => { [a[i], a[j]] = [a[j], a[i]]; };
  const mini = (label, title, fn, disabled = false) => h("button", { type: "button", class: "tbl-mini", title, "aria-label": title, disabled, onclick: () => edit(fn) }, label);
  // 行（見出しの行は動かさない）は ↑↓ で並べ替え・＋ で下に1行挟む・× で消す。列は一番上の ←→× で
  const paintGrid = () => {
    const width = Math.max(1, ...draft.map((r) => r.length));
    draft.forEach((r) => { while (r.length < width) r.push(""); });
    const colTools = h("tr", { class: "tbl-tools-row" }, h("td", { class: "tbl-ctl" }), [...Array(width).keys()].map((ci) => h("td", { class: "tbl-ctl" },
      mini("←", `${ci + 1}列目を左へ`, () => draft.forEach((r) => swap(r, ci, ci - 1)), ci === 0),
      mini("→", `${ci + 1}列目を右へ`, () => draft.forEach((r) => swap(r, ci, ci + 1)), ci === width - 1),
      mini("×", `${ci + 1}列目を消す`, () => { if (width > 1 && (draft.every((r) => !r[ci]) || confirm(`${ci + 1}列目を消しますか？`))) draft.forEach((r) => r.splice(ci, 1)); }, width === 1))));
    grid.replaceChildren(h("table", { class: "note-table edit" }, h("tbody", null, colTools, draft.map((r, ri) => h("tr", null,
      h("td", { class: "tbl-ctl row" }, ri === 0 ? h("span", { class: "tbl-head-label" }, "見出し") : [
        mini("↑", `${ri}行目を上へ`, () => swap(draft, ri, ri - 1), ri <= 1),
        mini("↓", `${ri}行目を下へ`, () => swap(draft, ri, ri + 1), ri === draft.length - 1),
        mini("＋", `${ri}行目の下に行を挟む`, () => draft.splice(ri + 1, 0, Array(width).fill(""))),
        mini("×", `${ri}行目を消す`, () => { if (r.every((x) => !x) || confirm(`${ri}行目を消しますか？`)) draft.splice(ri, 1); })]),
      r.map((v, ci) => {
        const inp = h("input", { type: "text", value: v, "aria-label": `${ri + 1}行${ci + 1}列` });
        inp.addEventListener("input", () => { draft[ri][ci] = inp.value; markDirty(); });
        return h(ri === 0 ? "th" : "td", null, inp);
      }))))));
  };
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
      if (n.type === "table") { draft = tableRows(n); paintGrid(); } else { body.value = n.body ?? ""; requestAnimationFrame(grow); }
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
  return { el: h("div", { class: "side-default" }, h("div", null, notes.el), h("div", null, members.el)), update() { notes.update(); members.update(); } };
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

// ---- 地図のピン（管理者が刺す）
//   mapPins/{id} { lat, lng, title, note, icon, color, vis: "all" | "admin", createdAt }
const PIN_ICONS = ["📍", "🏕️", "🍖", "🚻", "🚩", "⛱️", "🎯", "⚠️", "💎", "🏁"];
const PIN_COLORS = ["#FF3B30", "#FF9500", "#34C759", "#007AFF", "#AF52DE", "#1C1C1E"];
const visiblePins = () => [...S.mapPins.values()].filter((p) => S.isAdmin || p.vis !== "admin").sort((a, b) => ts(a.createdAt) - ts(b.createdAt));

function pinEditor(pin, { onClose, onMove }) {
  const d = { title: "", note: "", icon: PIN_ICONS[0], color: PIN_COLORS[0], vis: "all", ...pin };
  const title = h("input", { type: "text", placeholder: "名前（例：集合場所）", value: d.title, maxlength: "40" });
  const note = h("textarea", { rows: "2", placeholder: "メモ（任意）" });
  note.value = d.note ?? "";
  const icons = h("div", { class: "pin-icons" });
  const colors = h("div", { class: "pin-colors" });
  const paintChoices = () => {
    setKids(icons, PIN_ICONS.map((ic) => h("button", { type: "button", class: `pin-choice${d.icon === ic ? " on" : ""}`, onclick: () => { d.icon = ic; paintChoices(); onMove?.(d); } }, ic)));
    setKids(colors, PIN_COLORS.map((c) => h("button", { type: "button", class: `pin-color${d.color === c ? " on" : ""}`, style: `--c:${c}`, "aria-label": "色", onclick: () => { d.color = c; paintChoices(); onMove?.(d); } })));
  };
  paintChoices();
  const vis = segmented([{ value: "all", label: "全員に表示" }, { value: "admin", label: "管理者だけ" }], d.vis);
  const save = () => {
    const data = { lat: d.lat, lng: d.lng, title: title.value.trim() || "ピン", note: note.value.trim(), icon: d.icon, color: d.color, vis: vis.value };
    fire(d.id ? updateDoc(D("mapPins", d.id), data) : addDoc(C("mapPins"), { ...data, createdAt: serverTimestamp() }), d.id ? "ピンを更新しました" : "ピンを刺しました");
    onClose();
  };
  return h("div", { class: "pin-editor" },
    h("div", { class: "pin-editor-head" }, h("b", null, d.id ? "ピンを編集" : "新しいピン"), h("span", { class: "secondary" }, "ピンはドラッグで動かせます")),
    h("div", { class: "group-body" }, h("div", { class: "cell" }, title), h("div", { class: "cell" }, note)),
    icons, colors, h("div", { class: "pin-vis" }, vis),
    h("div", { class: "pin-actions" },
      d.id ? h("button", { class: "text-btn destructive", onclick: () => { if (confirm(`「${d.title}」を削除しますか？`)) { fire(deleteDoc(D("mapPins", d.id)), "削除しました"); onClose(); } } }, "削除") : null,
      h("button", { class: "text-btn", onclick: onClose }, "キャンセル"),
      h("button", { class: "btn-small", onclick: save }, d.id ? "保存" : "刺す")));
}

// ---- 位置の共有グループ
// 管理者が「参加者同士でも見られる」をオフにしているときでも、同じグループの人どうしは位置が見える（管理者は常に全員）
const sortedLocGroups = () => [...S.locGroups.values()].sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
const myLocGroups = (uid = S.user?.uid) => sortedLocGroups().filter((g) => (g.members ?? []).includes(uid));
function myLocMates(uid = S.user?.uid) {
  const set = new Set();
  for (const g of myLocGroups(uid)) for (const m of g.members ?? []) if (m !== uid) set.add(m);
  return set;
}
// 地図に出してよい人（管理者・全員公開は全員、それ以外は同じグループの人だけ）
const canSeeLoc = (uid) => S.isAdmin || S.config.locAll || myLocMates().has(uid);

// 管理者：グループの作成・編集（設定の中）
function locGroupsEditor() {
  const body = h("div");
  const editors = new Map(); // id -> { el, checks, name }（描き直しても選択や入力が消えないように使い回す）
  const newName = h("input", { type: "text", class: "plain", placeholder: "例：A班 / 買い出し組", maxlength: "20" });
  const add = h("form", { onsubmit: (e) => {
    e.preventDefault();
    if (!newName.value.trim()) return;
    fire(addDoc(C("locGroups"), { name: newName.value.trim(), members: [], createdAt: serverTimestamp() }), "グループを作りました");
    newName.value = "";
  } }, h("div", { class: "group-body" }, h("div", { class: "cell" }, newName), h("button", { class: "cell cell-button", type: "submit" }, icon("plus"), "グループを作る")));
  const card = (g) => {
    let e = editors.get(g.id);
    if (!e) {
      const name = editableInput({ class: "plain", maxlength: "20", "aria-label": "グループ名" });
      const checks = memberChecks(g.members ?? []);
      const save = () => fire(updateDoc(D("locGroups", g.id), { name: name.value.trim() || g.name, members: checks.value() }), "保存しました");
      e = { name, checks, el: h("article", { class: "card loc-group" },
        h("div", { class: "loc-group-head" }, name,
          h("button", { class: "text-btn", onclick: () => { name.saved(); save(); } }, "保存"),
          h("button", { class: "text-btn destructive", onclick: () => { if (confirm(`「${g.name}」を削除しますか？`)) fire(deleteDoc(D("locGroups", g.id)), "削除しました"); } }, "削除")),
        checks.el) };
      editors.set(g.id, e);
      e.checks.set(g.members ?? []);
    }
    e.name.sync(g.name);
    e.checks.refresh();
    return e.el;
  };
  return {
    el: body,
    update() {
      if (!S.isAdmin) return;
      const gs = sortedLocGroups();
      for (const id of [...editors.keys()]) if (!S.locGroups.has(id)) editors.delete(id);
      setKids(body, group("位置の共有グループ", [h("div", { class: "cell loc-groups" }, gs.length ? gs.map(card) : h("span", { class: "secondary" }, "まだありません")), add],
        "同じグループの人どうしは、「参加者同士でも見られる」がオフでも地図でお互いの位置が見えます（位置の共有がオンのときだけ）。メンバーを選んで「保存」を押してください。1人が複数のグループに入ってもかまいません。"));
    },
  };
}

function mapView() {
  const box = h("div", { class: "map-box" });
  const status = h("div", { class: "map-status" }, "現在地を探しています…");
  const locateBtn = h("button", { class: "map-locate", "aria-label": "現在地に戻る", title: "現在地に戻る" }, icon("locate"));
  const el = h("div", { class: "map-view" }, h("div", { class: "map-wrap" }, box, locateBtn), status);
  let map = null, dot = null, ring = null, watchId = null, last = null, follow = true;
  const others = new Map(); // uid -> marker
  const people = h("div", { class: "map-people" });
  const groupNote = h("div", { class: "map-groups", hidden: true });
  el.append(groupNote, people);

  // ピン
  const pinMarks = new Map(); // id -> marker
  const pinList = h("div", { class: "map-pins" });
  const editorBox = h("div");
  let adding = false, draft = null, ghost = null;
  const addBtn = S.isAdmin ? h("button", { class: "map-addpin", title: "ピンを刺す", onclick: () => {
    adding = !adding;
    addBtn.classList.toggle("on", adding);
    status.dataset.hint = adding ? "1" : "";
    if (adding) status.textContent = "ピンを刺したい場所をタップしてください";
  } }, "📍", h("span", null, "ピン")) : null;
  el.querySelector(".map-wrap").append(...(addBtn ? [addBtn] : []));
  el.append(editorBox, pinList);
  const pinIcon = (p, ghostPin) => window.L.divIcon({ className: "", iconSize: [0, 0],
    html: `<div class="mpin${ghostPin ? " ghost" : ""}" style="--c:${p.color || PIN_COLORS[0]}"><span class="mpin-head"><i>${PIN_ICONS.includes(p.icon) ? p.icon : "📍"}</i></span><b></b></div>` });
  const closeEditor = () => { draft = null; ghost?.remove(); ghost = null; editorBox.replaceChildren(); status.textContent = ""; paintPins(); };
  const openEditor = (pin) => {
    draft = { ...pin };
    ghost?.remove(); ghost = null;
    if (!pin.id && map) {
      // まだ保存していないピンは、半透明の仮のピンで場所を見せる（ドラッグで調整できる）
      ghost = window.L.marker([pin.lat, pin.lng], { icon: pinIcon(pin, true), draggable: true }).addTo(map);
      ghost.on("dragend", () => { const ll = ghost.getLatLng(); draft.lat = ll.lat; draft.lng = ll.lng; });
    }
    editorBox.replaceChildren(pinEditor(draft, {
      onClose: closeEditor,
      onMove: (d) => { Object.assign(draft, { icon: d.icon, color: d.color }); if (ghost) ghost.setIcon(pinIcon(draft, true)); },
    }));
    editorBox.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  };
  const paintPins = () => {
    const list = visiblePins();
    if (map) {
      const alive = new Set();
      for (const p of list) {
        if (draft?.id === p.id) { alive.add(p.id); continue; }
        alive.add(p.id);
        let mk = pinMarks.get(p.id);
        const sig = `${p.lat},${p.lng},${p.icon},${p.color},${p.title},${p.note},${p.vis}`;
        if (!mk) {
          mk = window.L.marker([p.lat, p.lng], { icon: pinIcon(p), draggable: S.isAdmin, keyboard: false }).addTo(map);
          if (S.isAdmin) {
            mk.on("click", () => openEditor(S.mapPins.get(mk.pinId) ?? p));
            mk.on("dragend", () => { const ll = mk.getLatLng(); fire(updateDoc(D("mapPins", mk.pinId), { lat: ll.lat, lng: ll.lng }), "ピンを動かしました"); });
          } else {
            mk.on("click", () => {
              const cur = S.mapPins.get(mk.pinId);
              if (!cur) return;
              mk.unbindPopup();
              mk.bindPopup(h("div", { class: "mpin-pop" }, h("b", null, `${cur.icon ?? ""} ${cur.title}`), cur.note ? h("div", null, cur.note) : null)).openPopup();
            });
          }
          mk.pinId = p.id;
          pinMarks.set(p.id, mk);
        }
        if (mk.sig !== sig) {
          mk.setLatLng([p.lat, p.lng]).setIcon(pinIcon(p));
          const node = mk.getElement()?.querySelector(".mpin b");
          if (node) node.textContent = p.title;
          mk.sig = sig;
        }
      }
      for (const [id, mk] of pinMarks) if (!alive.has(id)) { mk.remove(); pinMarks.delete(id); }
    }
    pinList.hidden = !list.length;
    setKids(pinList, list.length ? [h("div", { class: "map-pins-title" }, "ピン"), ...list.map((p) => h("button", {
      class: "map-pin-row", onclick: () => { follow = false; map?.setView([p.lat, p.lng], Math.max(map.getZoom(), 17)); if (S.isAdmin) openEditor(p); },
    }, h("span", { class: "dot-ic", style: `--c:${p.color}` }, p.icon ?? "📍"), h("span", { class: "cell-main" }, h("b", null, p.title), p.note ? h("small", null, p.note) : null),
      p.vis === "admin" ? h("span", { class: "tint" }, "管理者だけ") : null))] : null);
  };

  // 他の人の位置（管理者は全員、参加者は設定でオンのときだけ届く）
  const paintOthers = () => {
    const me = S.user?.uid;
    const locs = [...S.locations.values()].filter((l) => l.id !== me && S.members.has(l.id) && canSeeLoc(l.id));
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
    const gs = !S.isAdmin && S.config.locShare && !S.config.locAll ? myLocGroups() : [];
    groupNote.hidden = !gs.length;
    groupNote.textContent = gs.length ? `位置の共有グループ：${gs.map((g) => `${g.name}（${(g.members ?? []).map(memberName).join("・")}）`).join("　")}` : "";
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
    if (status.dataset.hint) return;
    status.textContent = `現在地：誤差 約${Math.round(accuracy)}m ・ ${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")} 更新`;
  };

  locateBtn.addEventListener("click", () => {
    follow = true;
    if (map && last) map.setView(last, Math.max(map.getZoom(), 16));
  });

  let started = false;
  // 位置のデータは地図を開いている間だけ受け取る（全員の位置が動くたびに全員へ届くと、読み取り回数が膨らむため）
  // 全員を受け取るか、同じグループの人だけ（30人まではその人たちの分だけ読む）を受け取るか。変わったら購読し直す
  let locKey = null;
  const syncListen = () => {
    const mates = [...myLocMates()].sort();
    const key = S.isAdmin || S.config.locAll ? "all" : !mates.length ? null : mates.length <= 30 ? `in:${mates.join(",")}` : "all";
    if (key !== locKey) {
      unlisten("locations");
      S.locations = new Map();
      locKey = key;
      if (key === "all") listen("locations", C("locations"), (x) => { if (x) S.locations = toMap(x); });
      else if (key) listen("locations", query(C("locations"), where("uid", "in", mates)), (x) => { if (x) S.locations = toMap(x); });
    }
    listen("mapPins", C("mapPins"), (x) => { if (x) S.mapPins = toMap(x); });
  };
  return {
    el,
    update() {
      syncListen();
      paintOthers();
      paintPins();
      if (started) { map?.invalidateSize(); return; }
      started = true;
      loadLeaflet().then((L) => {
        map = L.map(box, { zoomControl: true, attributionControl: true }).setView(ISLAND_CENTER, 13);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(map);
        map.on("dragstart", () => { follow = false; });
        // 管理者：「ピン」ボタンを押してから地図をタップすると、そこにピンを刺す
        map.on("click", (e) => {
          if (!adding) return;
          adding = false;
          addBtn?.classList.remove("on");
          status.dataset.hint = "";
          status.textContent = "名前を付けて「刺す」を押してください";
          openEditor({ lat: e.latlng.lat, lng: e.latlng.lng });
        });
        paintPins();
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
      unlisten("mapPins");
      S.locations = new Map();
      S.mapPins = new Map();
    },
  };
}

const mapAllowed = () => S.isAdmin || !!S.config.mapEnabled;

// ---------------------------------------------------------------- 画面：ログイン

function loginView() {
  const id = h("input", { type: "text", autocomplete: "username", autocapitalize: "none", autocorrect: "off", spellcheck: "false", placeholder: "user01", required: true, value: qrPrefill ?? switchTarget ?? undefined });
  const pw = h("input", { type: "password", autocomplete: "current-password", placeholder: "必須", required: true });
  const btn = h("button", { class: "btn-filled", type: "submit" }, "ログイン");
  return h("div", { class: "login", "data-view": "login" },
    h("img", { class: "app-icon", src: "icon-192.png", alt: "" }),
    h("h1", null, "旅行ポータル"),
    ptPending ? h("p", { class: "pt-login-note" }, "ポイントQRを読み取りました。ログインするとポイントを受け取れます。") : null,
    h("p", { class: "secondary" }, switchTarget ? `参加者アカウント（${switchTarget}）でログインしてください。次からはログインしたまま切り替えられます。` : "配られたIDとパスワードでログインしてください。"),
    h("form", {
      onsubmit: (e) => {
        e.preventDefault();
        guard(btn, () => signInWithEmailAndPassword(auth, idToEmail(id.value.trim()), pw.value));
      },
    },
      h("div", { class: "group-body" }, field("ID", id), field("パスワード", pw)),
      btn,
    ),
    altSession ? h("button", { class: "btn-filled ghost-btn", onclick: () => switchAccount(false) }, "管理者アカウントに戻る") : null,
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
  // 確定前ページにはポイントがないので、絞り込みは出さない
  const el = h("div", null, sectionTitle("お知らせ", compact), inLobby() ? null : h("div", { class: "seg-wrap" }, filter), list);
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
        : emptyState("megaphone", "まだありません", inLobby() ? "新しいお知らせが届くとここに表示されます。" : "新しいお知らせやポイントが届くとここに表示されます。"), page.more);
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
          team && teamLeader(team) ? cell(h("span", { class: "team-leader-note" }, "👑 リーダー"), teamLeader(team) === uid ? "あなた" : memberName(teamLeader(team))) : null,
          team && roleOf(set.id, uid) ? cell("あなたの役職", roleOf(set.id, uid)) : null,
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
              h("div", { class: "cell-sub" }, ms.length ? teamNamesText(t, ms) : "メンバーなし")),
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
      const teams = inLobby() ? [] : sortedSets().flatMap((s) => [
        { t: S.teams.get(teamOfIn(uid, s.id)), secret: false },
        { t: S.teams.get(trueTeamOf(uid, s.id)), secret: true },
      ]).filter((x) => x.t);
      el.replaceChildren(...[
        inLobby() ? null : tile("あなた", ptTotal("user", uid)),
        ...teams.map(({ t, secret }) => tile(t.name, ptTotal("team", t.id), t.color,
          secret ? "本当のチーム（あなただけ）" : S.sets.get(t.setId)?.name)),
      ].filter(Boolean));
      // やること（未回答のアンケート・未入金）
      const todo = [myUnanswered(uid) ? `未回答のアンケート ${myUnanswered(uid)}件` : null, myUnpaid(uid) ? `未入金 ${yen(myUnpaid(uid))}` : null].filter(Boolean);
      // QR でログインした直後の案内（ホーム画面に追加したアプリは、iPhone ではログイン状態が別になる）
      let qrNote = false;
      try { qrNote = sessionStorage.getItem("island.qrlogin") === "1" && !matchMedia("(display-mode: standalone)").matches; } catch { /* なし */ }
      if (qrNote) el.append(h("div", { class: "info-banner" },
        h("div", null, h("b", null, "ホーム画面に追加しておくと便利です"),
          h("div", null, "Safari の共有ボタン →「ホーム画面に追加」。追加したアプリを初めて開いたときだけ、カードの ID とパスワードを入力してください（iPhone はログイン状態が別になるため）。")),
        h("button", { class: "text-btn", onclick: () => { try { sessionStorage.removeItem("island.qrlogin"); } catch { /* なし */ } scheduleRender(); } }, "閉じる")));
      if (todo.length) el.append(h("button", { class: "todo-banner", onclick: () => (myUnanswered(uid) || !document.getElementById("pay-top")?.childElementCount ? document.getElementById("sec-money") : document.getElementById("pay-top"))?.scrollIntoView({ behavior: "smooth", block: "start" }) }, icon("check"), todo.join(" ・ "), icon("chevron")));
    },
  };
}

// ---------------------------------------------------------------- 旅行（プロファイル）の管理

const PROFILE_COLLECTIONS = ["config", "members", "teamSets", "teams", "memberships", "assignments", "announcements", "pointLogs", "acks", "notes", "locations", "stats", "quizzes", "quizAnswers", "live", "quizSabo", "quizBets", "mapPins", "polls", "votes", "payments", "payReports", "pwChanged", "messages", "chatImages", "expenses", "checklists", "checks", "locGroups", "ptQrs", "ptClaims", "attrDefs", "memberAttrs"];

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

// 確定前ページを作る：今いる参加者（すべての旅行）を、未割り当て・未確定で入れる。
// 旅行のデータ（参加者の登録・お知らせ・チーム・ポイント）は消さない。確定すればまた開けるようになる
async function createLobby() {
  if (S.profiles.has(LOBBY)) return switchProfile(LOBBY);
  if (!confirm("確定前ページを作りますか？\n\n今の参加者は全員「未確定」になり、次に開いたときから確定前ページ（お知らせ・出欠・集金・チャット・立て替え）だけが表示されます。\n旅行のデータは消えません。旅行を割り当てて「確定」すると、また旅行のページが開けるようになります。")) return;
  toast("確定前ページを作っています…");
  const people = new Map();
  const pids = [...S.profiles.keys()].filter((x) => x !== ROOT && x !== LOBBY);
  const snaps = await Promise.all([getDocs(collection(db, "members")), ...pids.map((p) => getDocs(collection(db, "profiles", p, "members")))]);
  snaps.forEach((snap) => snap.forEach((d) => { if (!people.has(d.id)) people.set(d.id, d.data()); }));
  const b = writeBatch(db);
  b.set(doc(db, "profiles", LOBBY), { name: LOBBY_NAME, order: -1, lobby: true, createdAt: serverTimestamp() });
  b.set(LD("config", "app"), { title: LOBBY_NAME });
  for (const [uid, m] of people) b.set(LD("members", uid), { loginId: m.loginId ?? null, name: m.name ?? "", trips: {}, createdAt: serverTimestamp() });
  await b.commit();
  toast(`確定前ページを作りました（${people.size}人を未確定で登録）`);
  switchProfile(LOBBY);
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
        S.isAdmin && !S.profiles.has(LOBBY) ? h("button", { class: "cell cell-button", onclick: () => guard(null, createLobby) }, icon("people"), "確定前ページを作る（今の参加者を全員未確定にする）") : null,
      ], S.isAdmin ? "新しい旅行は中身が空の状態で作られます。参加者のIDは旅行をまたいで使い回せます。確定前ページでは、参加者の管理と旅行の割り当て・確定ができます。" : null));
    },
  };
}

function settingsView({ withTitle = true } = {}) {
  const cur = h("input", { type: "password", autocomplete: "current-password", placeholder: "必須", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", minlength: "6", placeholder: "6文字以上", required: true });
  const btn = h("button", { class: "cell cell-button", type: "submit" }, "パスワードを変更");
  const adminBox = h("div");
  const profiles = profilesGroup();
  const myId = emailToId(S.user.email);
  const spec = S.isAdmin && !altSession ? (ACCOUNT_SWITCH ?? {})[myId] : null;
  const switchBox = h("div");
  // 切り替え先：ID で書いてあればそのまま、名前で書いてあれば参加者の一覧（なければアカウントの一覧）から ID を探す
  const paintSwitch = (target, label) => setKids(switchBox, target
    ? group("アカウントの切り替え", h("button", { class: "cell cell-button", onclick: () => switchAccount(true, myId, target) }, icon("people"), `参加者アカウント（${label ? `${label}・` : ""}${target}）に切り替える`),
      "初回だけパスワードを入れてログインします。管理者のログインはそのまま残るので、戻るときは入力不要です。")
    : altSession ? group("アカウントの切り替え", h("button", { class: "cell cell-button", onclick: () => switchAccount(false) }, icon("people"), `管理者アカウント（${adminName(idToEmail(switchFrom ?? "admin1"))}）に戻る`))
    : spec ? group("アカウントの切り替え", cell(h("span", { class: "secondary" }, `「${spec.name}」さんのアカウントが見つかりません（名前が変わっていないか確認してください）`)))
    : null);
  if (typeof spec === "string") paintSwitch(spec);
  else if (spec?.name) {
    const pools = [S.members, S.lobbyMembers, ...S.extMembers.values()].filter(Boolean);
    const hits = [...new Set(pools.flatMap((m) => [...m.values()].filter((x) => x.name === spec.name && x.loginId).map((x) => x.loginId)))];
    if (hits.length === 1) paintSwitch(hits[0], spec.name);
    else if (hits.length > 1) setKids(switchBox, group("アカウントの切り替え", hits.map((id) => h("button", { class: "cell cell-button", onclick: () => switchAccount(true, myId, id) }, icon("people"), `参加者アカウント（${spec.name}・${id}）に切り替える`)), `「${spec.name}」さんが${hits.length}人いるので、IDで選んでください。`));
    else getDocs(query(collection(db, "accounts"), where("name", "==", spec.name))).then((qs) => paintSwitch(qs.docs[0]?.id ?? spec.id ?? null, spec.name)).catch(() => paintSwitch(spec.id ?? null, spec.name));
  } else paintSwitch(null);
  const el = h("div", null,
    withTitle ? largeTitle("設定") : null,
    switchBox,
    profiles.el,
    group(null, [
      cell("ID", emailToId(S.user.email)),
      cell("名前", S.isAdmin ? adminName(S.user.email) : S.me?.name ?? ""),
    ]),
    adminBox,
    h("form", {
      onsubmit: (e) => {
        e.preventDefault();
        guard(btn, async () => {
          await reauthenticateWithCredential(S.user, EmailAuthProvider.credential(S.user.email, cur.value));
          await updatePassword(S.user, next.value);
          markPasswordChanged();
          cur.value = next.value = "";
          toast("パスワードを変更しました");
        });
      },
    }, group("パスワード", [field("現在", cur), field("新規", next), btn], "変更したパスワードは管理者にもわかりません。忘れないようにしてください。")),
    group(null, h("button", { class: "cell cell-button destructive", onclick: () => { if (confirm("ログアウトしますか？")) signOut(auth); } }, "ログアウト"), "バージョン v63"),
  );
  let built = false;
  const locGroupsBox = locGroupsEditor();
  return {
    el,
    update() {
      profiles.update();
      locGroupsBox.update();
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
      ], "位置の共有をオンにすると、参加者がアプリを開いている間、現在地が届きます（30m 以上動いたとき・止まっていても2分に1回。地図を開いている人だけが受け取ります）。「参加者同士でも見られる」をオンにすると、参加者の地図にも全員が表示されます。オフのときは、下の「位置の共有グループ」で同じグループの人どうしだけ見えます。共有をオフにすると、位置のデータは消えます。"),
        locGroupsBox.el,
        exportBox(),
        S.pid !== ROOT ? group(null, h("button", { class: "cell cell-button destructive", onclick: () => guard(null, () => deleteProfile(S.pid)) }, "この旅行を削除")) : null);
    },
  };
}

// ---------------------------------------------------------------- 画面：管理者

function adminAnnouncements() {
  const title = h("input", { type: "text", maxlength: "100", placeholder: "タイトル", required: true, class: "plain title-input" });
  const body = h("textarea", { rows: "4", placeholder: "本文", class: "plain" });
  const scope = segmented([{ value: "all", label: "全員" }, ...(inLobby() ? [] : [{ value: "team", label: "チーム" }]), { value: "user", label: "個人" }]);
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

  const ongoing = adminOngoing();
  const el = h("div", null, largeTitle("お知らせ"), ongoing.el, form, h("div", { class: "group-header standalone" }, "投稿済み"), list);
  return {
    el,
    update() {
      ongoing.update();
      refreshTarget();
      const page = paged("adminAnn", sortAnnouncements(merged(S.annSrc)), 20);
      setKids(list, page.items.length ? page.items.map((a) => announcementCard(a, { admin: true })) : emptyState("megaphone", "まだありません"), page.more);
    },
  };
}

// 管理者のお知らせページの一番上：いま動いているもの（受付中のアンケート・集金中・未精算の立て替え・クイズ）
// 押すと、その画面（出欠・集金 / クイズ）を開く。何もないときは欄ごと隠す
function adminOngoing() {
  const body = h("div", { class: "group-body" });
  const el = h("section", { class: "group ongoing" }, h("div", { class: "group-header" }, "実施中"), body);
  const row = (ic, title, sub, tag, onclick) => h("button", { class: "cell cell-button ongoing-row", onclick },
    icon(ic), h("span", { class: "cell-main" }, h("b", null, title), h("small", null, sub)),
    tag ? h("span", { class: `ongoing-tag ${tag.cls ?? ""}` }, tag.text) : null, icon("chevron", "ongoing-go"));
  return {
    el,
    update() {
      const rows = [];
      // クイズ
      const L = S.live;
      if (!inLobby() && L && L.phase && L.phase !== "off") {
        const qz = S.quizzes.get(L.quizId);
        rows.push(row("quiz", `クイズ「${qz?.title ?? "クイズ"}」`, L.phase === "lobby" ? "参加者の入場待ち" : L.phase === "results" ? "結果発表中" : "出題中", { text: "実施中", cls: "live" },
          () => openAdminTab("quiz")));
      }
      // 出欠・アンケート（受付中）：回答した人数
      const answered = new Map();
      for (const v of S.votes.values()) { if (!answered.has(v.pollId)) answered.set(v.pollId, new Set()); answered.get(v.pollId).add(v.uid); }
      for (const p of sortedPolls().filter((x) => relevantHere(x) && pollOpen(x))) {
        const ts2 = pollTargets(p);
        const got = ts2.filter((m) => answered.get(p.id)?.has(m.id)).length;
        rows.push(row("check", p.question, [`回答 ${got} / ${ts2.length}人`, p.deadline ? `締切 ${fmtDeadline(p.deadline)}` : "締切なし"].join(" ・ "), { text: "受付中" },
          () => openAdminMoney("polls")));
      }
      const reqs = pendingPollReqs();
      if (reqs.length) rows.push(row("check", "アンケートの申請", reqs.map((r) => `${memberName(r.uid)}「${r.question}」`).join(" ・ "), { text: `${reqs.length}件`, cls: "warn" }, () => openAdminMoney("polls")));
      // 集金：まだ全員そろっていないもの
      const pend = pendingReports();
      for (const p of sortedPayments()) {
        const t = payTargets(p);
        const { expect, got, paidN, n } = payTotals(p);
        if (!t.length || paidN >= n) continue;
        const reports = pend.filter((x) => x.p.id === p.id).length;
        const over = p.due && p.due < new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
        rows.push(row("yen", isExt(p.id) ? `${p.title}（${pageName(extPid(p.id))}より）` : p.title, [`入金 ${paidN} / ${n}人`, `${yen(got)} / ${yen(expect)}`, p.due ? `期限 ${p.due.slice(5).replace("-", "/")}` : null, reports ? `確認待ち ${reports}件` : null].filter(Boolean).join(" ・ "),
          over ? { text: "期限切れ", cls: "warn" } : { text: "集金中" }, () => openAdminMoney("pay")));
      }
      // 立て替え：まだ精算が残っているもの
      const st = settlements();
      if (st.length) {
        rows.push(row("arrows", "立て替えの精算", `残り ${st.length}件 ・ 合計 ${yen(st.reduce((a, x) => a + x.amount, 0))}`, { text: "未精算" }, () => openAdminMoney("exp")));
      }
      for (const { pid, st: xs } of extSettlements().filter((x) => x.st.length)) {
        rows.push(row("arrows", `立て替えの精算（${pageName(pid)}より）`, `残り ${xs.length}件 ・ 合計 ${yen(xs.reduce((a, x) => a + x.amount, 0))}`, { text: "未精算" }, () => openAdminMoney("exp")));
      }
      el.hidden = !rows.length;
      body.replaceChildren(...rows);
    },
  };
}

// 出欠・集金の画面を、指定した欄（polls / pay / exp）で開く。もう開いていれば欄だけ切り替える
let moneyTabHint = null;
let activeMoney = null;
function openAdminMoney(which) {
  if (activeMoney?.el.isConnected) { activeMoney.show(which); activeMoney.el.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
  moneyTabHint = which;
  openAdminTab("money");
}
function openAdminTab(key) {
  const t = (inLobby() ? LOBBY_ADMIN_TABS : ADMIN_TABS).find((x) => x.key === key);
  if (t) openSheet(t);
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
    // 初期パスワードは accounts（管理者だけが読める）に控えておき、あとから印刷できるようにする
    await setDoc(doc(db, "accounts", loginId), { uid: cred.user.uid, name: displayName, pw: password });
    printCache.at = 0; // 次の印刷前に読み直す
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
      h("button", { class: "cell cell-button", onclick: () => printCredentials(created.map((c) => ({ name: c.name, loginId: c.loginId, password: c.password, reused: !c.password })), "cards") }, icon("note"), "この人たちのカードを印刷"),
      h("button", { class: "cell cell-button secondary-btn", onclick: () => { if (confirm("パスワードを保存しましたか？表示を消します。")) { created.length = 0; renderResult(); } } }, "表示を消す"),
    ], h("span", { class: "warn" }, "パスワードは「ID・パスワードを印刷」からあとでも印刷できます（本人が変更した場合は「変更済み」と出ます）。別の旅行で作ったIDは、そのまま追加されます（パスワードは前と同じ）。")));
  }

  // 確定前ページがあるときは、IDの作成・追加は確定前ページだけで行い、旅行には確定した人だけを入れる
  const lobbyNote = h("div");
  const createBox = h("div");
  const el = h("div", null,
    withTitle ? largeTitle("参加者") : null,
    lobbyNote,
    createBox);
  createBox.append(
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
    }, group("1人ずつ追加", [field("ID", id), field("名前", name), field("パスワード", pw), addBtn])));
  el.append(
    group("ID・パスワードを印刷", [
      h("button", { class: "cell cell-button", onclick: () => guard(null, () => printAllCredentials("cards")) }, icon("note"), "配る用カード（切り取り線つき）"),
      h("button", { class: "cell cell-button", onclick: () => guard(null, () => printAllCredentials("list")) }, icon("table"), "一覧表（管理者の控え）"),
    ], "この旅行の参加者全員分を印刷します。この機能を入れる前に作ったIDはパスワードの記録がないので、空欄（手書き用）になります。"),
    listEmpty,
    listGroup,
  );

  let prefetched = false;
  return {
    el,
    update() {
      // 印刷の準備を、画面が落ち着いてから先に済ませておく
      if (!prefetched) { prefetched = true; (window.requestIdleCallback ?? setTimeout)(() => prefetchPrint(), { timeout: 3000 }); }
      const ms = sortedMembers();
      const lobbyMode = !inLobby() && S.profiles.has(LOBBY);
      createBox.hidden = lobbyMode;
      if (lobbyMode) {
        const notYet = S.lobbyMembers ? ms.filter((m) => tripsOf(S.lobbyMembers.get(m.id))[S.pid] !== true) : [];
        setKids(lobbyNote, group(null, [
          cell(h("span", { class: "secondary" }, "参加者のID は確定前ページで作成・管理します。この旅行には、確定前ページで割り当てて「確定」した人が自動で追加されます。")),
          notYet.length ? h("button", { class: "cell cell-button destructive", onclick: () => {
            if (!confirm(`この旅行で確定していない ${notYet.length}人（${notYet.map((m) => m.name).join("・")}）を、この旅行の参加者から外しますか？\nIDは確定前ページに残ります。あとで割り当てて確定すれば、また追加されます（チームの振り分けは外れます）。`)) return;
            const b = writeBatch(db);
            for (const m of notYet) {
              b.delete(D("members", m.id));
              membershipsOf((x) => x.uid === m.id).forEach((x) => b.delete(D("memberships", x.id)));
            }
            fire(b.commit(), `${notYet.length}人を外しました`);
          } }, `確定していない人をこの旅行から外す（${notYet.length}人）`) : null,
        ]));
      } else lobbyNote.replaceChildren();
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
              if (!confirm(inLobby()
                ? `${cur?.name}（${m.loginId}）を確定前ページから外しますか？\n旅行に登録がある場合は、その旅行が（確定しなくても）開けるようになります。`
                : `${cur?.name}（${m.loginId}）を削除しますか？\nこの人は何も見られなくなります。`)) return;
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

// ---- 参加者の属性（チーム分けの参考。管理者の画面だけに出す）
const sortedAttrDefs = () => [...S.attrDefs.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const attrOf = (uid, defId) => S.memberAttrs.get(uid)?.values?.[defId] ?? "";
function attrChips(uid) {
  const xs = sortedAttrDefs().map((d) => [d, attrOf(uid, d.id)]).filter(([, v]) => v !== "");
  return xs.length ? h("span", { class: "attr-chips" }, xs.map(([d, v]) => h("span", { class: "attr-chip", title: d.name }, v))) : null;
}
// チームの属性の内訳（選択肢のある項目だけ）
function teamAttrSummary(ms) {
  const parts = sortedAttrDefs().filter((d) => d.options?.length).map((d) => {
    const cnt = d.options.map((o) => [o, ms.filter((m) => attrOf(m.id, d.id) === o).length]).filter(([, n]) => n);
    return cnt.length ? `${d.name}：${cnt.map(([o, n]) => `${o}${n}`).join("・")}` : null;
  }).filter(Boolean);
  return parts.length ? h("div", { class: "attr-summary" }, parts.join(" ／ ")) : null;
}
function attrEditor() {
  const name = h("input", { type: "text", class: "plain", placeholder: "例：性別 / 学年 / 運動の得意さ", maxlength: "20" });
  const opts = h("input", { type: "text", placeholder: "例：男 / 女（空欄なら自由記入）" });
  const add = h("form", { onsubmit: (e) => {
    e.preventDefault();
    if (!name.value.trim()) return;
    fire(addDoc(C("attrDefs"), { name: name.value.trim(), options: opts.value.split(/[/／,、]/).map((x) => x.trim()).filter(Boolean), order: Date.now() }), "属性を追加しました");
    name.value = ""; opts.value = "";
  } }, h("div", { class: "group-body" }, h("div", { class: "cell" }, name), field("選択肢", opts), h("button", { class: "cell cell-button", type: "submit" }, icon("plus"), "属性を追加")));
  const defsBox = h("div");
  const table = h("div", { class: "attr-table-wrap" });
  const el = h("div", { class: "attr-editor" },
    h("div", { class: "group-header standalone" }, "参加者の属性（チーム分けの参考・管理者だけに表示）"),
    keptFold("attr-defs", "属性の項目を作る・直す", h("div", null, defsBox, add), false),
    keptFold("attr-values", "参加者ごとに属性を入れる", table, false));
  redrawOnLeave(el);
  return {
    el,
    update() {
      if (typingIn(el)) return;
      const defs = sortedAttrDefs();
      setKids(defsBox, defs.length ? group(null, defs.map((d) => {
        const nm = h("input", { type: "text", value: d.name, class: "plain", maxlength: "20" });
        const op = h("input", { type: "text", value: (d.options ?? []).join(" / "), placeholder: "空欄なら自由記入" });
        return h("div", { class: "cell attr-def-row" }, h("div", { class: "cell-main" }, nm, op),
          h("button", { class: "text-btn", onclick: () => fire(updateDoc(D("attrDefs", d.id), { name: nm.value.trim() || d.name, options: op.value.split(/[/／,、]/).map((x) => x.trim()).filter(Boolean) }), "保存しました") }, "保存"),
          h("button", { class: "text-btn destructive", onclick: () => { if (confirm(`属性「${d.name}」を削除しますか？（入れた値も見えなくなります）`)) fire(deleteDoc(D("attrDefs", d.id)), "削除しました"); } }, "削除"));
      })) : null);
      const ms = sortedMembers();
      if (!defs.length) return setKids(table, h("p", { class: "cell-sub" }, "先に「属性の項目」を作ってください。"));
      const set = (uid, defId, v) => fire(setDoc(D("memberAttrs", uid), { values: { [defId]: v } }, { merge: true }));
      setKids(table, h("table", { class: "attr-table" },
        h("thead", null, h("tr", null, h("th", null, "名前"), defs.map((d) => h("th", null, d.name)))),
        h("tbody", null, ms.map((m) => h("tr", null, h("td", null, m.name), defs.map((d) => {
          const v = attrOf(m.id, d.id);
          let input;
          if (d.options?.length) {
            input = h("select", { class: "inline-select" }, h("option", { value: "" }, "—"), d.options.map((o) => h("option", { value: o, selected: v === o }, o)));
            input.addEventListener("change", () => set(m.id, d.id, input.value));
          } else {
            input = h("input", { type: "text", value: v, maxlength: "20" });
            input.addEventListener("change", () => set(m.id, d.id, input.value.trim()));
          }
          return h("td", null, input);
        }))))));
    },
  };
}

function adminTeams() {
  const attrs = attrEditor();
  const balanceSel = h("select", { class: "inline-select", "aria-label": "偏らないようにする属性" });
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
    const by = S.attrDefs.get(balanceSel.value);
    if (!confirm(`${ms.length}人を${teams.length}チームにランダムで振り分けます${by ? `（「${by.name}」が偏らないように）` : ""}。このチーム表の今の振り分けとスパイ登録は上書きされます。`)) return;
    const shuffle = (xs) => {
      for (let i = xs.length - 1; i > 0; i--) {
        const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
        [xs[i], xs[j]] = [xs[j], xs[i]];
      }
      return xs;
    };
    // 属性を選んだときは、同じ値の人をまとめてから順に配る（値ごとに各チームへ均等に散らばる）
    let shuffled;
    if (by) {
      const groups = new Map();
      for (const m of shuffle([...ms])) { const v = attrOf(m.id, by.id); groups.set(v, [...(groups.get(v) ?? []), m]); }
      shuffled = [...groups.values()].sort((a, b) => b.length - a.length).flat();
    } else shuffled = shuffle([...ms]);
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
      h("span", { class: "balance-wrap" }, balanceSel, h("button", { class: "text-btn", onclick: () => randomAssign() }, icon("shuffle"), "ランダム"))),
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

  const el = h("div", null, largeTitle("チーム"), setBar, noSets, detail, attrs.el);

  return {
    el,
    update() {
      attrs.update();
      fillSelect(balanceSel, sortedAttrDefs().filter((d) => d.options?.length).map((d) => ({ value: d.id, label: `${d.name}で均等` })), "属性なし");
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
        const leader = h("select", { class: "inline-select team-leader", "aria-label": "リーダー" });
        const memList = h("ul", { class: "team-members" });
        const attrSum = h("div");
        leader.addEventListener("change", () => fire(updateDoc(D("teams", t.id), { leader: leader.value || null }), leader.value ? `リーダーを ${memberName(leader.value)} にしました` : "リーダーを外しました"));
        const el = h("div", { class: "cell team-row" },
          d,
          h("div", { class: "cell-main" }, nm, count, attrSum, memList, h("label", { class: "team-leader-wrap" }, h("span", null, "👑 リーダー"), leader)),
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
        return { el, nm, d, count, leader, memList, attrSum };
      }, (row, t) => {
        row.d.style.setProperty("--c", t.color);
        row.nm.sync(t.name);
        const tm = membersOfTeam(t.id);
        row.count.textContent = `${tm.length}人`;
        setKids(row.attrSum, teamAttrSummary(tm));
        // メンバーを1人ずつ改行して並べる（リーダーが先頭）
        const L = teamLeader(t);
        setKids(row.memList, [...tm].sort((a, b) => (b.id === L) - (a.id === L)).map((m) => h("li", { class: m.id === L ? "leader" : null }, m.id === L ? `👑 ${withRole(t, m)}` : withRole(t, m), attrChips(m.id))));
        fillSelect(row.leader, tm.map((m) => ({ value: m.id, label: m.name })), "リーダーなし");
        if (document.activeElement !== row.leader) row.leader.value = teamLeader(t) ?? "";
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
        // 役職は手入力（空欄なら役職なし）。入力欄から離れたときに保存する
        const role = h("input", { type: "text", class: "role-input", placeholder: "役職なし", maxlength: "12", "aria-label": "役職" });
        role.addEventListener("change", () => {
          const v = role.value.trim();
          fire(updateDoc(D("teamSets", sel.dataset.set), { [`roles.${m.id}`]: v || deleteField() }), v ? `${m.name} の役職を「${v}」にしました` : `${m.name} の役職をなしにしました`);
        });
        return { el: h("div", { class: "cell assign-row" }, label, role, sel), label, sel, role };
      }, (row, m) => {
        const teamId = teamOfIn(m.id, setId);
        const real = trueTeamOf(m.id, setId);
        setKids(row.label, dot(S.teams.get(teamId)?.color), m.name, attrChips(m.id),
          real ? h("span", { class: "spy-tag" }, icon("spy"), `本当は${S.teams.get(real)?.name ?? ""}`) : null);
        if (document.activeElement !== row.role || row.sel.dataset.set !== setId) row.role.value = roleOf(setId, m.id);
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
  const ptAdmin = ptQrAdmin();
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
    ptAdmin.el,
  );

  const breakdown = (ls, keys) => keys.map((k) => `${{ public: "公開", team: "チーム内", private: "本人" }[k]} ${sum(ls.filter((l) => l.visibility === k))}`).join(" · ");
  const totalCell = (labelEl, ls, keys) => h("div", { class: "cell" },
    h("div", { class: "cell-main" }, labelEl, h("div", { class: "cell-sub" }, breakdown(ls, keys))),
    h("div", { class: "rank-value" }, sum(ls), h("small", null, " pt")));

  return {
    el,
    update() {
      ptAdmin.update();
      refreshForm();
      refreshTransfer();
      const logs = merged(S.logSrc).sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
      // 人・チームごとの履歴を1回で振り分けておく（人数×履歴件数の繰り返しにしない）
      const byTarget = new Map();
      for (const l of logs) { const k = `${l.kind}|${l.target}`; if (!byTarget.has(k)) byTarget.set(k, []); byTarget.get(k).push(l); }
      const logsOf = (kind, id) => byTarget.get(`${kind}|${id}`) ?? [];
      const setGroups = sortedSets().map((s) => {
        const teams = teamsInSet(s.id);
        return group(`${s.name} の集計`, teams.length
          ? teams.map((t) => totalCell(h("span", { class: "team-label" }, dot(t.color), t.name), logsOf("team", t.id), ["public", "team"]))
          : none("チームがありません"));
      });
      const ms = sortedMembers();
      summary.replaceChildren(
        ...setGroups,
        group("個人の集計", ms.length
          ? ms.map((m) => totalCell(m.name, logsOf("user", m.id), ["public", "team", "private"]))
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

// ---- 区切り（セッション）・妨害・賭けの設定
//
//   quizzes/{id}.sessions : [{ id, name, perUser, perTarget: { 種類: 回数 } }]   … A問題・B問題 などの区切り
//                           問題は questions[i].session で区切りに属する（無ければ最初の区切り）
//   quizzes/{id}.sabo     : 妨害の設定 { on, pay: "user"|"team", setId, who: "spectators"|"all", streak2x, types: { 種類: { on, price } } }
//   quizzes/{id}.bet      : 賭けの設定 { on, pay, setId, rate(払戻率%), max(1人の上限), kinds: { 券種: { on } } }
//   quizSabo/{自動}       : 妨害の申し込み { uid, quizId, forIndex, target, type, at, status: pending|ok|ng, reason, price }
//   quizBets/{自動}       : 賭け { uid, quizId, kind, pick: [uid…], amount, at, status: pending|ok|ng|win|lose|refund, payout }
//
// 妨害の種類を増やすときは、SABO_TYPES に1行足して、効果（effectOn を見ている所）を書く。
// for はその妨害が使える問題の種類、needsTime は「4択・記述では制限時間がある問題だけ」。
const SABO_TYPES = {
  seal: { label: "封印", mark: "封", desc: "その問題に解答できない", price: 10, for: ["choice", "text", "buzz", "order", "vote"], on: true },
  time: { label: "時間短縮", mark: "短", desc: "解答できる時間が半分になる（早押しは入力6秒→3秒）", price: 5, for: ["choice", "text", "buzz", "order", "vote"], needsTime: true, on: true },
  blind: { label: "目隠し", mark: "隠", desc: "スマホに問題文と選択肢の文字が出ない", price: 3, for: ["choice", "text", "buzz", "order", "vote"], on: true },
  late: { label: "出遅れ", mark: "遅", desc: "出題から5秒間は解答できない（早押しも押せない）", price: 4, for: ["choice", "text", "buzz", "order", "vote"], on: false },
  shuffle: { label: "シャッフル", mark: "混", desc: "スマホの選択肢の並びがバラバラ・色が全部灰色になる", price: 3, for: ["choice"], on: false },
  flip: { label: "逆さま", mark: "逆", desc: "スマホの問題と解答欄が上下逆さまになる", price: 2, for: ["choice", "text", "buzz", "order", "vote"], on: false },
};
const SABO_KEYS = Object.keys(SABO_TYPES);
const LATE_SEC = 5;

// 賭けの券種（競馬と同じ考え方）。増やすときはここに1行足す（n = 何人を選ぶか、ordered = 順番どおりか）
const BET_KINDS = {
  win: { label: "単勝", desc: "1位を当てる", n: 1, ordered: true, on: true },
  exacta: { label: "2連単", desc: "1位・2位を順番どおりに当てる", n: 2, ordered: true, on: false },
  trifecta: { label: "3連単", desc: "1位・2位・3位を順番どおりに当てる", n: 3, ordered: true, on: true },
  trio: { label: "3連複", desc: "1〜3位の3人を当てる（順番は問わない）", n: 3, ordered: false, on: false },
};
const BET_KEYS = Object.keys(BET_KINDS);

const SESSION_NAMES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const newSession = (k = 0) => ({ id: `s${Date.now().toString(36)}${k}`, name: `${SESSION_NAMES[k] ?? k + 1}問題`, perUser: 3, perTarget: Object.fromEntries(SABO_KEYS.map((t) => [t, 1])) });
function quizSessions(qz) {
  const ss = qz?.sessions?.length ? qz.sessions : [{ ...newSession(0), id: "s0" }];
  return ss.map((s, k) => ({ ...newSession(k), ...s, perTarget: { ...newSession(k).perTarget, ...(s.perTarget ?? {}) } }));
}
function saboCfg(qz) {
  const s = qz?.sabo ?? {};
  return {
    on: !!s.on, pay: s.pay === "team" ? "team" : "user", setId: s.setId ?? null, who: s.who === "all" ? "all" : "spectators", streak2x: s.streak2x !== false,
    types: Object.fromEntries(SABO_KEYS.map((k) => [k, { on: s.types?.[k]?.on ?? SABO_TYPES[k].on, price: Number(s.types?.[k]?.price ?? SABO_TYPES[k].price) || 0 }])),
  };
}
function betCfg(qz) {
  const s = qz?.bet ?? {};
  return {
    on: !!s.on, pay: s.pay === "team" ? "team" : "user", setId: s.setId ?? null,
    rate: Math.min(100, Math.max(1, Number(s.rate ?? 100) || 100)), max: Math.max(1, Number(s.max ?? 30) || 30),
    kinds: Object.fromEntries(BET_KEYS.map((k) => [k, { on: s.kinds?.[k]?.on ?? BET_KINDS[k].on }])),
  };
}
// 進行中の状態（live/quiz）に載せる設定。参加者のスマホはクイズ本体を読まないので、必要なものをここに入れる
function liveBase(qz) {
  const sessions = quizSessions(qz);
  return {
    quizId: qz.id, title: qz.title, total: qz.questions.length, answerers: qz.answerers ?? null,
    sabo: saboCfg(qz), bet: betCfg(qz), sessions,
    qMeta: qz.questions.map((q) => ({ s: sessions.some((s) => s.id === q.session) ? q.session : sessions[0].id, t: q.type, time: Number(q.time) || 0 })),
  };
}
const sessionAt = (L, i) => { const id = L?.qMeta?.[i]?.s; return L?.sessions?.find((s) => s.id === id) ?? L?.sessions?.[0] ?? null; };
const isAnswererIn = (L, uid) => !L?.answerers || L.answerers.includes(uid);
const effectOn = (L, uid) => (L && L.phase !== "lobby" && L.phase !== "results" ? L.effects?.[uid]?.type ?? null : null);
const myEffect = () => effectOn(S.live, S.user?.uid);

// 支払う元（個人 or チーム）
function payerOf(cfg, uid) {
  if (cfg.pay === "team") {
    const teamId = cfg.setId ? teamOfIn(uid, cfg.setId) : null;
    return teamId ? { kind: "team", id: teamId, key: `t:${teamId}`, label: S.teams.get(teamId)?.name ?? "チーム" } : null;
  }
  return { kind: "user", id: uid, key: `u:${uid}`, label: "個人" };
}
const balanceOf = (payer) => (payer ? ptTotal(payer.kind, payer.id) : 0);

// ---- 妨害の判定（スマホの事前チェックと、操作用の画面での確定で同じものを使う）
//   accepted: 成功した妨害（status ok）の一覧、spent: この確定処理の中ですでに使った分
function saboCheck(L, req, accepted, spent = new Map()) {
  const cfg = L.sabo;
  const T = SABO_TYPES[req.type];
  const st = cfg?.types?.[req.type];
  const no = (reason) => ({ ok: false, reason });
  if (!cfg?.on) return no("妨害はオフです");
  if (!T || !st?.on) return no("この妨害は使えません");
  const qm = L.qMeta?.[req.forIndex];
  if (!qm) return no("問題がありません");
  if (!T.for.includes(qm.t) || (T.needsTime && qm.t !== "buzz" && !qm.time)) return no("この問題には使えません");
  if (!req.target || req.target === req.uid) return no("自分には使えません");
  if (!isAnswererIn(L, req.target)) return no("相手が解答者ではありません");
  if (cfg.who !== "all" && isAnswererIn(L, req.uid)) return no("解答者は妨害できません");
  if (accepted.some((a) => a.forIndex === req.forIndex && a.target === req.target)) return no("その人はこの問題ですでに妨害を受けています");
  const sess = sessionAt(L, req.forIndex);
  const inSess = accepted.filter((a) => L.qMeta?.[a.forIndex]?.s === qm.s);
  const lim = Number(sess?.perTarget?.[req.type] ?? 1);
  if (inSess.filter((a) => a.target === req.target && a.type === req.type).length >= lim) {
    return no(lim === 0 ? `${sess.name}では「${T.label}」は使えません` : `${sess.name}では、この人への「${T.label}」はあと0回です`);
  }
  if (inSess.filter((a) => a.uid === req.uid).length >= Number(sess?.perUser ?? 3)) return no(`${sess?.name ?? ""}で妨害できる回数を使い切りました`);
  const streak = cfg.streak2x && accepted.some((a) => a.uid === req.uid && a.target === req.target && a.forIndex === req.forIndex - 1);
  const price = (Number(st.price) || 0) * (streak ? 2 : 1);
  const payer = payerOf(cfg, req.uid);
  if (!payer) return no("チームに入っていないので使えません");
  const bal = balanceOf(payer) - (spent.get(payer.key) ?? 0);
  if (bal < price) return no(`ポイントが足りません（残り ${bal}pt・必要 ${price}pt）`);
  return { ok: true, price, payer, streak };
}
const canSabotage = (L) => !!(L?.sabo?.on && S.me && !S.isAdmin && (L.sabo.who === "all" || !isAnswererIn(L, S.user.uid)));
const canBet = (L) => !!(L?.bet?.on && S.me && !S.isAdmin);

// ---- 賭け（パリミュチュエル方式：券種ごとに賭け金を全部集め、払戻率をかけて、当たった人で賭け金に応じて分ける）
const betKey = (kind, pick) => (BET_KINDS[kind]?.ordered ? pick.join(">") : [...pick].sort().join("+"));
// 券種ごとのプール（取り消し・失敗したものは除く）
function betPools(bets, kind) {
  const list = bets.filter((b) => b.kind === kind && b.status !== "ng");
  const total = list.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const byKey = new Map();
  for (const b of list) byKey.set(betKey(kind, b.pick), (byKey.get(betKey(kind, b.pick)) ?? 0) + (Number(b.amount) || 0));
  return { total, byKey };
}
// オッズ（倍率）。まだ誰も賭けていない組み合わせは「仮に1pt賭けたら」で出す
function betOdds(pools, key, rate) {
  const on = pools.byKey.get(key) ?? 0;
  const total = pools.total + (on ? 0 : 1);
  return Math.max(1, Math.floor(((total * rate) / 100 / (on || 1)) * 10) / 10);
}
// 結果の順位（同点は同じ順位）から、当たりになる組み合わせを全部出す（同着があると当たりが複数になる）
function winningKeys(kind, rows) {
  const K = BET_KINDS[kind];
  // 順位 = 自分より点が高い人の数 + 1。同点が k 人いれば、その人たちは rank 〜 rank+k-1 番のどれにも入りうる
  const ranked = rows.map((r) => ({ ...r, rank: rows.filter((x) => x.score > r.score).length + 1, ties: rows.filter((x) => x.score === r.score).length }));
  const slots = [];
  for (let pos = 1; pos <= K.n; pos++) slots.push(ranked.filter((r) => r.rank <= pos && pos <= r.rank + r.ties - 1).map((r) => r.uid));
  const keys = new Set();
  const walk = (pos, used) => {
    if (pos === K.n) { keys.add(betKey(kind, used)); return; }
    for (const uid of slots[pos]) if (!used.includes(uid)) walk(pos + 1, [...used, uid]);
  };
  walk(0, []);
  return keys;
}
// 払い戻しを計算する（当たりの組み合わせが複数あるときは、プールを組み合わせの数で等分してから賭け金に応じて分ける）
function settleBets(bets, rows, cfg) {
  const out = new Map(); // betId -> { status, payout }
  for (const kind of BET_KEYS) {
    const list = bets.filter((b) => b.kind === kind && b.status === "ok");
    if (!list.length) continue;
    const pool = Math.floor((list.reduce((s, b) => s + b.amount, 0) * cfg.rate) / 100);
    const wins = winningKeys(kind, rows);
    const hitKeys = [...wins].filter((k) => list.some((b) => betKey(kind, b.pick) === k));
    if (!hitKeys.length) { list.forEach((b) => out.set(b.id, { status: "refund", payout: b.amount })); continue; } // 誰も当たらなければ全額返す
    const share = pool / hitKeys.length;
    for (const b of list) {
      const k = betKey(kind, b.pick);
      if (!hitKeys.includes(k)) { out.set(b.id, { status: "lose", payout: 0 }); continue; }
      const onKey = list.filter((x) => betKey(kind, x.pick) === k).reduce((s, x) => s + x.amount, 0);
      out.set(b.id, { status: "win", payout: Math.floor((share * b.amount) / onKey) });
    }
  }
  return out;
}
const QTYPE = { choice: "4択", text: "記述", buzz: "早押し", order: "並べ替え", vote: "投票当て" };
// 並べ替え（order）：q.choices を「正しい順番」で登録しておき、スマホにはバラバラに出す。答えは元の番号の並び（正解は 0,1,2…）
// 投票当て（vote） ：事前のアンケート（q.pollId）の結果が正解。voteMode "top" は1位を当てる、"rank" は上位 rankN 位までの順番を当てる
const isSeqType = (q) => q?.type === "order" || (q?.type === "vote" && q.voteMode === "rank");
const seqLen = (q) => (q.type === "order" ? (q.choices ?? []).length : Math.max(2, Math.min(5, Number(q.rankN) || 3)));
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
  unlisten("quizSabo");
  unlisten("quizBets");
  S.quizAnswers = new Map();
  S.quizSabo = new Map();
  S.quizBets = new Map();
  QZ.answersKey = key;
  if (!key) return;
  listen("quizAnswers", query(C("quizAnswers"), where("quizId", "==", key)), (s) => {
    if (s) S.quizAnswers = toMap(s);
    paintQuizLive();
  });
  // 妨害と賭け（1回のクイズで数十件程度）
  listen("quizSabo", query(C("quizSabo"), where("quizId", "==", key)), (s) => { if (s) S.quizSabo = toMap(s); paintQuizLive(); });
  listen("quizBets", query(C("quizBets"), where("quizId", "==", key)), (s) => { if (s) S.quizBets = toMap(s); paintQuizLive(); });
}

const normAnswer = (t) => String(t ?? "").normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");
const acceptedAnswers = (q) => String(q.answer ?? "").split(/[/／,、]/).map(normAnswer).filter(Boolean);

// 投票の結果（管理者の端末で、アンケートの回答から数える）。同票は選択肢の順で並べる
function voteResult(q) {
  if (q?.answer && typeof q.answer === "object" && !Array.isArray(q.answer)) return q.answer; // 発表後にスマホへ届いた結果
  const poll = S.polls.get(q?.pollId);
  const options = poll?.options ?? [];
  const votes = poll ? [...S.votes.values()].filter((v) => v.pollId === poll.id && isTarget(poll, v.uid)) : [];
  const pts = poll ? pollScores(poll, votes) : new Map();
  const counts = options.map((o) => pts.get(o) ?? 0);
  const rank = options.map((_, i) => i).sort((a, b) => counts[b] - counts[a] || a - b);
  const max = Math.max(0, ...counts);
  return { counts, rank, top: max > 0 ? rank.filter((i) => counts[i] === max) : [], texts: options, total: votes.length, unit: poll ? pollUnit(poll) : "票" };
}
// 並べ替え・順位当ての正解の並び
const correctSeq = (q) => (q.type === "order" ? (q.choices ?? []).map((_, i) => i) : voteResult(q).rank.slice(0, seqLen(q)));
// 順位当ては、同じ票数どうしならどちらの順でも合っているとする（例：3位が同票なら、どちらを3位にしても正解）
function seqMarks(q, order) {
  const c = correctSeq(q);
  const r = q.type === "vote" ? voteResult(q) : null;
  return (order ?? []).map((x, i) => c[i] != null && (r ? r.counts[x] === r.counts[c[i]] : x === c[i]));
}
const seqHits = (q, a) => seqMarks(q, a?.order).filter(Boolean).length;
// 票数での順位（同じ票数は同じ順位）
const voteRankOf = (r, k) => 1 + r.counts.filter((n) => n > r.counts[k]).length;

// 自動採点（早押しは管理者が判定するので null）
function autoJudge(q, a) {
  if (!q || !a) return null;
  if (q.type === "choice") return a.choice === q.answer;
  if (q.type === "text") return acceptedAnswers(q).includes(normAnswer(a.text));
  if (isSeqType(q)) return Array.isArray(a.order) && a.order.length === seqLen(q) && seqHits(q, a) === seqLen(q);
  if (q.type === "vote") return typeof a.choice === "number" && voteResult(q).top.includes(a.choice);
  return null;
}
// 早押しで時間切れ（6秒以内に送れなかった）は誤答扱い
const judged = (q, a) => (typeof a.judge === "boolean" ? a.judge : q?.type === "buzz" && a.timeout ? false : autoJudge(q, a));
const buzzText = (a) => (a.text ? a.text : a.timeout ? "時間切れ" : "");
function answerPoints(q, a) {
  const j = judged(q, a);
  if (j === true) return Number(q.points ?? 10) || 0;
  // 部分点（並べ替え・順位当て）：合っている位置の数に応じて（切り捨て）
  if (j === false && q.partial && isSeqType(q) && typeof a.judge !== "boolean") return Math.floor(((Number(q.points ?? 10) || 0) * seqHits(q, a)) / seqLen(q));
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

// 並べ替えの選択肢をバラバラにする順番（正しい順と同じにはしない）
function shuffledIdx(n) {
  const a = [...Array(n).keys()];
  for (let tries = 0; tries < 10; tries++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    if (n < 2 || a.some((x, i) => x !== i)) break;
  }
  return a;
}
// スマホに渡す問題（正解は入れない）。並べ替えはバラバラの順（perm[表示の位置] = 元の番号）、投票当てはアンケートの選択肢
function publicQuestion(q) {
  const base = {
    type: q.type, text: q.text ?? "", choices: q.type === "choice" ? q.choices ?? [] : [],
    time: Number(q.time) || 0, points: Number(q.points ?? 10) || 0, phone: q.phone !== false, speed: Number(q.speed) || READ_SPEED,
  };
  if (q.type === "order") {
    const list = (q.choices ?? []).filter((c) => c !== undefined);
    const perm = shuffledIdx(list.length);
    Object.assign(base, { choices: perm.map((i) => list[i]), perm, partial: !!q.partial });
  }
  if (q.type === "vote") Object.assign(base, { choices: S.polls.get(q.pollId)?.options ?? [], voteMode: q.voteMode === "rank" ? "rank" : "top", rankN: seqLen(q), partial: !!q.partial });
  return base;
}
// 発表のときに全員へ渡す正解（並べ替えは正しい順の文字、投票当ては集計結果）
function revealAnswerOf(q) {
  if (q?.type === "order") return { order: (q.choices ?? []).map((_, i) => i), texts: q.choices ?? [] };
  if (q?.type === "vote") return voteResult(q);
  return q?.answer ?? null;
}
// 正解を文字にする（A は revealAnswerOf の形。スマホでは発表で届いたもの）
function answerLabel(q, A) {
  if (A == null || A === "") return "";
  if (q?.type === "order") return (A.texts ?? []).join(" → ");
  if (q?.type === "vote") {
    if (!A.total) return "（まだ投票がありません）";
    if (q.voteMode === "rank") {
      // 同じ票数のものは「／」でまとめる（どちらの順でも正解なので）
      const out = [];
      for (let i = 0; i < seqLen(q) && i < A.rank.length;) {
        const c = A.counts[A.rank[i]];
        const g = A.rank.filter((k) => A.counts[k] === c);
        out.push(`${g.map((k) => A.texts[k]).join("／")}（${c}${A.unit ?? "票"}）`);
        i += g.length;
      }
      return out.join(" → ");
    }
    return `${A.top.map((k) => A.texts[k]).join("・")}（${A.counts[A.top[0]]}${A.unit ?? "票"}）`;
  }
  return typeof A === "object" ? "" : String(A);
}
// 1人の回答を文字にする（管理者側。並べ替えは元の番号で入っている）
function answerTextOf(q, a) {
  if (!a) return "";
  const texts = q.type === "vote" ? voteResult(q).texts : q.choices ?? [];
  if (isSeqType(q)) return (a.order ?? []).map((k) => texts[k] ?? "?").join(" → ");
  if (q.type === "vote") return texts[a.choice] ?? "?";
  if (q.type === "choice") return `${CHOICE_MARKS[a.choice] ?? "?"}：${q.choices?.[a.choice] ?? ""}`;
  return a.text ?? "";
}

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

// 解答権の残り秒数（「時間短縮」の妨害を受けている人は半分）
const turnSecs = (uid) => (effectOn(S.live, uid) === "time" ? BUZZ_ANSWER_SEC / 2 : BUZZ_ANSWER_SEC);
const turnLeft = (uid) => Math.max(0, turnSecs(uid) - (performance.now() - QZ.turnT0) / 1000);
// 「出遅れ」の残り秒数（自分のスマホだけ）
const lateLeft = () => (myEffect() === "late" && S.live?.phase === "question" ? Math.max(0, LATE_SEC - (performance.now() - QZ.t0) / 1000) : 0);

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
  if (a && !a.text && !a.timeout && typeof a.judge !== "boolean" && turnLeft(a.uid) === 0
    && performance.now() - QZ.turnT0 > (turnSecs(a.uid) + 2.5) * 1000 && !QZ.timeoutSent.has(`${a.id}:${L.turn.seq}`)) {
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
  const base = liveBase(qz);
  const b = writeBatch(db);
  // 受付中の妨害・賭けは、この問題を出す瞬間に先着順で確定してポイントを引く
  // 妨害と賭けは同じ持ちポイントから引くので、使った分（spent）を共有して残高を超えないようにする
  const spent = new Map();
  const effects = resolveSabo(qz, i, b, base, spent);
  if (S.live?.betWin?.open) resolveBets(qz, b, base, spent);
  b.set(liveRef(), {
    ...base, run: S.live?.run ?? null,
    index: i, phase: reading ? "reading" : "question", seq: Date.now(), openedAt: serverTimestamp(), q: publicQuestion(q), answer: null, scores: null,
    read: !!read, fullText: false, turn: null, readStop: null, effects, saboWin: null, betWin: null, slide: null,
  });
  fire(b.commit());
}

// ---- 妨害・賭けの受付と確定（操作用の画面）

const runOf = (r) => r.quizId === S.live?.quizId && r.run === S.live?.run;
const runSabo = () => [...S.quizSabo.values()].filter(runOf);
const runBets = () => [...S.quizBets.values()].filter(runOf);
const byArrival = (x, y) => (ts(x.at) || Infinity) - (ts(y.at) || Infinity) || (x.id < y.id ? -1 : 1);

// 受付中の妨害を先着順に確定する。失敗したものはポイントを引かない。成功したものはその問題の効果として返す
function resolveSabo(qz, i, b, base, spent = new Map()) {
  const L = S.live;
  const all = runSabo();
  const accepted = all.filter((r) => r.status === "ok");
  const open = L?.saboWin?.open && L.saboWin.index === i;
  const logs = [];
  for (const r of all.filter((x) => x.status === "pending").sort(byArrival)) {
    if (!open || r.forIndex !== i) { b.update(D("quizSabo", r.id), { status: "ng", reason: "受付時間外でした（ポイントは引かれていません）" }); continue; }
    const c = saboCheck({ ...base, run: L.run }, r, accepted, spent);
    if (!c.ok) { b.update(D("quizSabo", r.id), { status: "ng", reason: c.reason }); continue; }
    accepted.push({ ...r, status: "ok" });
    spent.set(c.payer.key, (spent.get(c.payer.key) ?? 0) + c.price);
    b.update(D("quizSabo", r.id), { status: "ok", price: c.price, streak: c.streak, payKind: c.payer.kind, payId: c.payer.id });
    if (c.price) logs.push({
      kind: c.payer.kind, target: c.payer.id, teamId: c.payer.kind === "team" ? c.payer.id : null, visibility: "public", delta: -c.price,
      reason: `クイズ妨害：${memberName(r.uid)} → ${memberName(r.target)}「${SABO_TYPES[r.type].label}」（${qz.title} 第${i + 1}問）`,
      createdAt: serverTimestamp(), author: emailToId(S.user.email),
    });
  }
  logs.forEach((x) => b.set(doc(C("pointLogs")), x));
  addStats(b, logs);
  const effects = {};
  accepted.filter((a) => a.forIndex === i).forEach((a) => { effects[a.target] = { type: a.type, by: a.uid }; });
  return effects;
}

// 賭けの事前チェック・確定で使う
function betCheck(L, bet, accepted, spent = new Map()) {
  const cfg = L.bet;
  const K = BET_KINDS[bet.kind];
  const no = (reason) => ({ ok: false, reason });
  if (!cfg?.on) return no("賭けはオフです");
  if (!K || !cfg.kinds?.[bet.kind]?.on) return no("この券種は使えません");
  const pick = bet.pick ?? [];
  if (pick.length !== K.n || new Set(pick).size !== K.n) return no(`${K.n}人を選んでください`);
  if (pick.some((u) => !isAnswererIn(L, u))) return no("解答者ではない人が入っています");
  const amount = Math.floor(Number(bet.amount) || 0);
  if (amount < 1) return no("1pt 以上賭けてください");
  const used = accepted.filter((a) => a.uid === bet.uid).reduce((x, a) => x + (Number(a.amount) || 0), 0);
  if (used + amount > cfg.max) return no(`1人 ${cfg.max}pt までです（あと ${Math.max(0, cfg.max - used)}pt）`);
  const payer = payerOf(cfg, bet.uid);
  if (!payer) return no("チームに入っていないので賭けられません");
  const bal = balanceOf(payer) - (spent.get(payer.key) ?? 0);
  if (bal < amount) return no(`ポイントが足りません（残り ${bal}pt）`);
  return { ok: true, amount, payer };
}

// 受付中の賭けを確定する（賭け金を引く）。確定後の一覧を返す
function resolveBets(qz, b, base, spent = new Map()) {
  const L = S.live;
  const all = runBets().map((x) => ({ ...x }));
  const accepted = all.filter((x) => x.status === "ok");
  const logs = [];
  for (const r of all.filter((x) => x.status === "pending").sort(byArrival)) {
    const c = L?.betWin?.open ? betCheck({ ...base, run: L.run }, r, accepted, spent) : { ok: false, reason: "受付時間外でした" };
    if (!c.ok) { r.status = "ng"; b.update(D("quizBets", r.id), { status: "ng", reason: c.reason }); continue; }
    Object.assign(r, { status: "ok", amount: c.amount, payKind: c.payer.kind, payId: c.payer.id });
    accepted.push(r);
    spent.set(c.payer.key, (spent.get(c.payer.key) ?? 0) + c.amount);
    b.update(D("quizBets", r.id), { status: "ok", amount: c.amount, payKind: c.payer.kind, payId: c.payer.id });
    logs.push({
      kind: c.payer.kind, target: c.payer.id, teamId: c.payer.kind === "team" ? c.payer.id : null, visibility: "public", delta: -c.amount,
      reason: `クイズの賭け：${memberName(r.uid)}「${BET_KINDS[r.kind].label} ${r.pick.map(memberName).join("→")}」（${qz.title}）`,
      createdAt: serverTimestamp(), author: emailToId(S.user.email),
    });
  }
  logs.forEach((x) => b.set(doc(C("pointLogs")), x));
  addStats(b, logs);
  return all;
}

// 結果発表のときに払い戻す
function settleInto(b, qz, bets, rows, cfg) {
  const out = settleBets(bets.filter((x) => x.status === "ok"), rows, cfg);
  const logs = [];
  for (const [id, r] of out) {
    const bet = bets.find((x) => x.id === id);
    b.update(D("quizBets", id), r);
    if (r.payout > 0) logs.push({
      kind: bet.payKind, target: bet.payId, teamId: bet.payKind === "team" ? bet.payId : null, visibility: "public", delta: r.payout,
      reason: `クイズの賭け${r.status === "refund" ? "（的中者なしで返金）" : "的中"}：${memberName(bet.uid)}「${BET_KINDS[bet.kind].label} ${bet.pick.map(memberName).join("→")}」（${qz.title}）`,
      createdAt: serverTimestamp(), author: emailToId(S.user.email),
    });
  }
  logs.forEach((x) => b.set(doc(C("pointLogs")), x));
  addStats(b, logs);
}

function quizFinish(qz) {
  const rows = quizScores(qz);
  const base = liveBase(qz);
  const b = writeBatch(db);
  let bets = runBets();
  if (S.live?.betWin?.open) bets = resolveBets(qz, b, base);
  if (S.live?.bet?.on) settleInto(b, qz, bets, rows, base.bet);
  b.update(liveRef(), { phase: "results", scores: rows.map(({ uid, score }) => ({ uid, score })), saboWin: null, betWin: null, slide: null });
  fire(b.commit());
}

const quizLiveUpdate = (patch) => fire(updateDoc(liveRef(), patch));
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
    return quizFinish(qz);
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
  if (L.phase === "results" && quizEndArmed()) return "もう一度押して終了";
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
    phase: "reveal", answer: revealAnswerOf(qz.questions[L.index]),
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

// 終了は「2回押す」で確認する（ブラウザの確認ダイアログは、全画面表示中や「ダイアログを表示しない」を選んだあとだと
// 出ずに「キャンセル」扱いになり、押しても何も起きないことがあるため）
const quizEndArmed = () => Date.now() - (QZ.endArm ?? 0) < 5000;
function quizEnd() {
  if (!quizEndArmed()) {
    QZ.endArm = Date.now();
    toast("もう一度押すとクイズを終了します");
    paintQuizLive();
    setTimeout(() => paintQuizLive(), 5100);
    return;
  }
  QZ.endArm = 0;
  updateDoc(liveRef(), { phase: "off" })
    .then(() => toast("クイズを終了しました"))
    .catch((e) => { console.error(e); toast(`終了できませんでした：${errMsg(e)}`, true); });
  if (!navigator.onLine) toast("オフラインです。電波が戻ったら終了が送信されます");
  closePresenter();
}

async function quizStart(quizId, mode = "operator") {
  const qz = S.quizzes.get(quizId);
  if (!qz?.questions?.length) return toast("問題がありません", true);
  if (S.live && S.live.phase !== "off" && S.live.quizId !== quizId && !confirm("別のクイズが進行中です。終了して、このクイズを始めますか？")) return;
  // run：このクイズを何回目に始めたか（前に同じクイズをやったときの妨害・賭けと混ざらないように）
  fire(setDoc(liveRef(), {
    ...liveBase(qz), run: Date.now(),
    index: 0, phase: "lobby", seq: Date.now(), q: null, answer: null, scores: null, effects: {}, saboWin: null, betWin: null, slide: null,
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
  type, text: "", choices: ["", "", "", ""], answer: type === "choice" ? 0 : "", points: 10, time: type === "buzz" ? 0 : type === "order" || type === "vote" ? 30 : 20, penalty: 0, phone: true,
  ...(type === "order" ? { partial: false } : {}), ...(type === "vote" ? { pollId: null, voteMode: "top", rankN: 3, partial: false } : {}),
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
    draft = JSON.parse(JSON.stringify({ title: qz.title, answerers: qz.answerers ?? null, questions: qz.questions ?? [], sessions: quizSessions(qz), sabo: saboCfg(qz), bet: betCfg(qz) }));
    // 区切りが無い問題は最初の区切りへ
    draft.questions.forEach((q) => { if (!draft.sessions.some((x) => x.id === q.session)) q.session = draft.sessions[0].id; });
    paintEditor();
  }
  const touch = () => { dirty = true; editor.classList.add("dirty"); };
  async function save() {
    await updateDoc(D("quizzes", editing), { title: draft.title.trim() || "クイズ", answerers: draft.answerers, questions: draft.questions, sessions: draft.sessions, sabo: draft.sabo, bet: draft.bet });
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
        h("button", { class: "cell cell-button destructive", onclick: () => { quizEnd(); paintList(); setTimeout(paintList, 5100); } }, icon("xmark"), quizEndArmed() ? "もう一度押すとクイズを終了" : "クイズを終了する"),
      ], "表示用と操作用は、別の管理者アカウント・別の端末で開けます（例：admin1 で表示用、admin2 で操作用）。") : null,
      quizzes.length ? quizzes.map((qz) => h("article", { class: "card quiz-card", "data-quiz": qz.id },
        h("div", { class: "quiz-card-title" }, icon("quiz"), qz.title),
        h("div", { class: "cell-sub" }, [`${qz.questions?.length ?? 0}問`, quizSessions(qz).length > 1 ? `${quizSessions(qz).length}区切り` : null, `解答者：${qz.answerers ? `${qz.answerers.length}人` : "全員"}`,
          qz.sabo?.on ? "妨害あり" : null, qz.bet?.on ? "賭けあり" : null].filter(Boolean).join(" ・ ")),
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
    who.addEventListener("change", () => { d.answerers = who.value === "pick" ? [] : null; touch(); paintPicks(); paintSettings(); });
    paintPicks();

    const qList = h("div");
    // 問題は区切りの順に並べておく（同じ区切りの中の順番はそのまま）
    const normalize = () => {
      const order = new Map(d.sessions.map((x, k) => [x.id, k]));
      d.questions.forEach((q) => { if (!order.has(q.session)) q.session = d.sessions[0].id; });
      d.questions = d.questions.map((q, k) => [q, k]).sort((a, b) => order.get(a[0].session) - order.get(b[0].session) || a[1] - b[1]).map(([q]) => q);
    };
    const numIn = (val, onset, attrs = {}) => {
      const inp = h("input", { type: "number", value: String(val ?? 0), inputmode: "numeric", min: "0", ...attrs });
      inp.addEventListener("input", () => { onset(Math.max(0, Number(inp.value) || 0)); touch(); });
      return inp;
    };
    function sessionEditor(sx, k) {
      const name = h("input", { type: "text", value: sx.name, class: "plain session-name", placeholder: "区切りの名前（例：A問題）" });
      name.addEventListener("input", () => { sx.name = name.value; touch(); });
      const qs = d.questions.map((q, i) => [q, i]).filter(([q]) => q.session === sx.id);
      const onTypes = SABO_KEYS.filter((t) => d.sabo.types[t]?.on);
      return h("section", { class: "session-block" },
        h("div", { class: "session-head" }, name,
          d.sessions.length > 1 ? h("button", { class: "text-btn destructive", onclick: () => {
            if (!confirm(`「${sx.name}」を削除しますか？中の問題は1つ前の区切りに移ります。`)) return;
            const to = d.sessions[k - 1] ?? d.sessions[k + 1];
            d.questions.forEach((q) => { if (q.session === sx.id) q.session = to.id; });
            d.sessions.splice(k, 1); normalize(); touch(); paintQuestions();
          } }, "区切りを削除") : null),
        d.sabo.on ? h("div", { class: "group-body q-nums" },
          field("1人が妨害できる回数", numIn(sx.perUser, (v) => { sx.perUser = v; })),
          onTypes.map((t) => field(`1人が受ける「${SABO_TYPES[t].label}」の上限`, numIn(sx.perTarget?.[t] ?? 1, (v) => { sx.perTarget = { ...sx.perTarget, [t]: v }; })))) : null,
        d.sabo.on ? h("div", { class: "cell-sub q-hint" }, "この区切りの中での回数です。0 にするとこの区切りでは使えません。") : null,
        qs.length ? qs.map(([q, i]) => questionEditor(q, i)) : h("div", { class: "cell-sub q-hint" }, "まだ問題がありません"),
        h("div", { class: "quiz-add" }, Object.entries(QTYPE).map(([type, label]) =>
          h("button", { class: "pill", onclick: () => { d.questions.push({ ...newQuestion(type), session: sx.id }); normalize(); touch(); paintQuestions(); } }, icon("plus"), `${label}の問題`))));
    }
    const paintQuestions = () => setKids(qList, d.sessions.map((sx, k) => sessionEditor(sx, k)),
      h("button", { class: "btn-small ghost add-session", onclick: () => { d.sessions.push(newSession(d.sessions.length)); touch(); paintQuestions(); } }, icon("plus"), "区切りを追加（B問題…）"));
    function questionEditor(q, i) {
      const type = segmented(Object.entries(QTYPE).map(([value, label]) => ({ value, label })), q.type);
      type.addEventListener("change", () => {
        q.type = type.value;
        if (q.type === "choice" && typeof q.answer !== "number") q.answer = 0;
        if (q.type !== "choice" && typeof q.answer === "number") q.answer = "";
        if (q.type === "buzz" && !q.time) q.time = 0;
        if (q.type === "order") { q.choices = (q.choices ?? []).filter((c) => String(c ?? "").trim()); while (q.choices.length < 3) q.choices.push(""); q.partial ??= false; }
        if (q.type === "vote") { q.pollId ??= null; q.voteMode ??= "top"; q.rankN ??= 3; q.partial ??= false; }
        if (isSeqType(q) || q.type === "vote") { q.answer = ""; if (!q.time) q.time = 30; }
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
      } else if (q.type === "order") {
        if (!Array.isArray(q.choices)) q.choices = ["", "", ""];
        const partial = toggle(!!q.partial);
        partial.addEventListener("change", () => { q.partial = partial.checked; touch(); });
        body = h("div", { class: "seq-edit" },
          h("div", { class: "cell-sub q-hint" }, "正しい順番で上から入れてください（2〜8個）。スマホにはバラバラの順で表示され、タップした順が答えになります。"),
          q.choices.map((c, k) => {
            const inp = h("input", { type: "text", value: c, placeholder: `${k + 1}番目` });
            inp.addEventListener("input", () => { q.choices[k] = inp.value; touch(); });
            return h("div", { class: "seq-row" }, h("span", { class: "seq-no" }, k + 1), inp,
              h("button", { class: "icon-btn", title: "上へ", disabled: k === 0, onclick: () => { [q.choices[k - 1], q.choices[k]] = [q.choices[k], q.choices[k - 1]]; touch(); paintQuestions(); } }, "↑"),
              q.choices.length > 2 ? h("button", { class: "text-btn destructive", onclick: () => { q.choices.splice(k, 1); touch(); paintQuestions(); } }, "削除") : null);
          }),
          q.choices.length < 8 ? h("button", { class: "btn-small ghost", onclick: () => { q.choices.push(""); touch(); paintQuestions(); } }, icon("plus"), "項目を追加") : null,
          h("div", { class: "group-body" }, field("部分点（合っている位置の数に応じて）", partial)));
      } else if (q.type === "vote") {
        const polls = sortedPolls();
        const poll = S.polls.get(q.pollId);
        const sel = h("select", { class: "inline-select" }, h("option", { value: "" }, "アンケートを選ぶ"),
          polls.map((p) => h("option", { value: p.id, selected: p.id === q.pollId }, p.question.length > 24 ? `${p.question.slice(0, 24)}…` : p.question)));
        sel.addEventListener("change", () => { q.pollId = sel.value || null; touch(); paintQuestions(); });
        const mode = segmented([{ value: "top", label: "1位を当てる" }, { value: "rank", label: "上位の順番を当てる" }], q.voteMode === "rank" ? "rank" : "top");
        mode.addEventListener("change", () => { q.voteMode = mode.value; touch(); paintQuestions(); });
        const partial = toggle(!!q.partial);
        partial.addEventListener("change", () => { q.partial = partial.checked; touch(); });
        const r = poll ? voteResult(q) : null;
        const maxN = Math.max(2, Math.min(5, poll?.options?.length ?? 5));
        body = h("div", { class: "vote-edit" },
          h("div", { class: "group-body" },
            field("もとにするアンケート", polls.length ? sel : h("span", { class: "secondary" }, "アンケートがありません（「出欠・集金」で作れます）")),
            h("div", { class: "cell" }, mode),
            q.voteMode === "rank" ? field(`何位まで当てるか（2〜${maxN}）`, num(seqLen(q), (v) => { q.rankN = Math.max(2, Math.min(maxN, v)); }, { min: "2", max: String(maxN) })) : null,
            q.voteMode === "rank" ? field("部分点（合っている順位の数に応じて）", partial) : null),
          poll ? h("div", { class: "vote-now" },
            h("div", { class: "cell-sub" }, `いまの集計（${r.total}人が回答${isRankPoll(poll) ? "・順位投票の点数" : ""}${pollOpen(poll) ? "・受付中" : "・締切済み"}）`),
            r.rank.slice(0, 5).map((k, n) => h("div", { class: "vote-now-row" }, h("span", { class: "seq-no" }, n + 1), h("span", null, r.texts[k]), h("b", null, `${r.counts[k]}${r.unit}`)))) : null,
          h("div", { class: "cell-sub q-hint" }, [
            "アンケートの結果が正解になります（順位投票のアンケートは、1位＝多い点…の合計点で順位を決めます）。同じ票数（点数）のものは、どちらを選んでも（どちらの順でも）正解です。",
            poll?.showResults ? "⚠ このアンケートは参加者に集計を見せる設定です。答えがばれるので「集計を参加者に見せない」にしてください。" : null,
            poll && pollOpen(poll) ? "クイズの前にアンケートを締め切っておくと、答えが動きません。" : null,
          ].filter(Boolean).join(" ")));
      } else {
        const ans = h("input", { type: "text", value: q.answer ?? "", placeholder: q.type === "text" ? "正解（「/」で区切ると複数OK）" : "正解のメモ（自分用）" });
        ans.addEventListener("input", () => { q.answer = ans.value; touch(); });
        body = h("div", { class: "group-body" }, field("正解", ans));
      }
      const move = (dir) => {
        const j = i + dir;
        if (j < 0 || j >= d.questions.length || d.questions[j].session !== q.session) return;
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
          d.sessions.length > 1 ? field("区切り", (() => {
            const sel = h("select", { class: "inline-select" }, d.sessions.map((x) => h("option", { value: x.id, selected: x.id === q.session }, x.name)));
            sel.addEventListener("change", () => { q.session = sel.value; normalize(); touch(); paintQuestions(); });
            return sel;
          })()) : null,
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

    // 妨害・賭けの設定
    const settings = h("div");
    const paySel = (cfg) => {
      const pay = segmented([{ value: "user", label: "個人のポイント" }, { value: "team", label: "チームのポイント" }], cfg.pay);
      pay.addEventListener("change", () => { cfg.pay = pay.value; if (cfg.pay === "team" && !cfg.setId) cfg.setId = sortedSets()[0]?.id ?? null; touch(); paintSettings(); });
      const set = h("select", { class: "inline-select" }, sortedSets().map((x) => h("option", { value: x.id, selected: x.id === cfg.setId }, x.name)));
      set.addEventListener("change", () => { cfg.setId = set.value; touch(); });
      return [h("div", { class: "cell" }, pay), cfg.pay === "team" ? field("どのチーム表のチームか", sortedSets().length ? set : h("span", { class: "secondary" }, "チーム表がありません")) : null];
    };
    const sw = (val, onset, repaint) => { const t = toggle(val); t.addEventListener("change", () => { onset(t.checked); touch(); if (repaint) { paintSettings(); paintQuestions(); } }); return t; };
    function paintSettings() {
      const sb = d.sabo, bt = d.bet;
      const who = segmented([{ value: "spectators", label: "解答者以外" }, { value: "all", label: "全員" }], sb.who);
      who.addEventListener("change", () => { sb.who = who.value; touch(); paintSettings(); });
      setKids(settings,
        group("妨害システム", [
          field("妨害を使う", sw(sb.on, (v) => { sb.on = v; }, true)),
          ...(sb.on ? [
            h("div", { class: "cell" }, who),
            ...paySel(sb),
            field("同じ人を2問続けて狙うと値段2倍", sw(sb.streak2x, (v) => { sb.streak2x = v; })),
            ...SABO_KEYS.map((t) => h("div", { class: "cell sabo-type" },
              h("div", { class: "cell-main" }, h("b", null, SABO_TYPES[t].label), h("div", { class: "cell-sub" }, SABO_TYPES[t].desc + (SABO_TYPES[t].for.length < 3 ? `（${SABO_TYPES[t].for.map((x) => QTYPE[x]).join("・")}のみ）` : ""))),
              numIn(sb.types[t].price, (v) => { sb.types[t].price = v; }, { class: "price-input", "aria-label": `${SABO_TYPES[t].label}の値段` }), h("span", { class: "secondary" }, "pt"),
              sw(sb.types[t].on, (v) => { sb.types[t].on = v; }, true))),
          ] : []),
        ], sb.on ? (sb.who === "spectators" && !d.answerers ? "⚠ 解答者が「全員」なので、このままだと妨害できる人がいません。解答者を選ぶか「全員」にしてください。"
          : "1問で1人が受ける妨害は1つまで（早い者勝ち）。回数の上限は区切りごとに下で決めます。") : "オンにすると、問題と問題の間にポイントで解答者を妨害できます。"),
        group("順位予想（賭け）", [
          field("賭けを使う", sw(bt.on, (v) => { bt.on = v; }, true)),
          ...(bt.on ? [
            ...paySel(bt),
            field("払戻率（%）", numIn(bt.rate, (v) => { bt.rate = Math.min(100, Math.max(1, v)); }, { min: "1", max: "100" })),
            field("1人が賭けられる上限（pt）", numIn(bt.max, (v) => { bt.max = Math.max(1, v); }, { min: "1" })),
            ...BET_KEYS.map((k) => field(`${BET_KINDS[k].label}（${BET_KINDS[k].desc}）`, sw(bt.kinds[k].on, (v) => { bt.kinds[k].on = v; }))),
          ] : []),
        ], bt.on ? "オッズは賭け金の合計で決まります（パリミュチュエル方式）。払戻率100%なら、集まったポイントが全部当たった人に分けられます。" : "オンにすると、クイズの最終順位を予想してポイントを賭けられます。"));
    }
    paintSettings();

    setKids(editor,
      h("div", { class: "row-between" },
        h("button", { class: "text-btn", onclick: closeEditor }, "‹ 一覧へ戻る"),
        h("button", { class: "text-btn", onclick: () => guard(null, save) }, "保存")),
      h("div", { class: "card" }, title),
      group("解答者", [h("div", { class: "cell" }, who)], "「選ぶ」にすると、チェックした人だけが解答できます。"),
      picks,
      settings,
      qList,
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
  if (L?.phase === "lobby" && L.slide != null && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    const n = ruleSlides(L).length;
    quizLiveUpdate({ slide: Math.min(n - 1, Math.max(0, L.slide + (e.key === "ArrowRight" ? 1 : -1))) });
    return;
  }
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); quizPrimaryAction(); }
  if (qz && e.key === "ArrowRight" && L.index + 1 < qz.questions.length) quizOpenQuestion(qz, L.index + 1);
  if (qz && e.key === "ArrowLeft" && L.index > 0) quizOpenQuestion(qz, L.index - 1);
});

// 制限時間の秒数。自分のスマホでは「時間短縮」の妨害を受けていると半分
const myQTime = (L, local) => (L?.q?.time ? (local && !S.isAdmin && L.q.type !== "buzz" && myEffect() === "time" ? L.q.time / 2 : L.q.time) : 0);
function remainingSec(L, local) {
  if (!L?.q?.time) return null;
  const start = local ? QZ.t0 : ts(L.openedAt) || Date.now();
  const elapsed = local ? (performance.now() - start) / 1000 : (Date.now() - start) / 1000;
  return Math.max(0, myQTime(L, local) - elapsed);
}

function paintPresenter(full = true) {
  const P = QZ.presenter;
  const L = S.live;
  if (!P) return;
  const qz = L && S.quizzes.get(L.quizId);
  if (L?.phase === "off") { closePresenter(); return; }
  // 開いた直後で、進行状態やクイズがまだ届いていない
  if (!L || !qz) {
    // 通知が届かないまま待ち続けないように、3秒たったら直接読みに行く
    if (P.dataset.state !== "wait") QZ.waitSince = Date.now();
    if (!L && Date.now() - (QZ.waitSince ?? 0) > 3000 && !QZ.waitFetch) {
      QZ.waitFetch = true;
      getDoc(liveRef()).then((d) => { if (!S.live && d.exists()) { S.live = d.data({ serverTimestamps: "estimate" }); syncQuizAnswers(); paintQuizLive(); } })
        .catch(() => {}).finally(() => { QZ.waitFetch = false; QZ.waitSince = Date.now(); });
    }
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
    const ansLabel = q.type === "choice" ? CHOICE_MARKS[a?.choice] ?? "?" : q.type === "text" ? a?.text
      : isSeqType(q) ? `${seqHits(q, a)}/${seqLen(q)}` : q.type === "vote" ? answerTextOf(q, a) : rank ? `${rank}番` : "✓";
    const fx = effectOn(L, m.id);
    return h("div", { class: `pr-chip${a ? " done" : ""}${ok === true ? " ok" : ok === false ? " ng" : ""}${turn ? " turn" : ""}${pop ? " pop" : ""}${fx ? " fx" : ""}` },
      fx ? h("span", { class: "mk2", title: SABO_TYPES[fx]?.label }, SABO_TYPES[fx]?.mark ?? "!") : null,
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
    resultsExtras(),
    withButton ? h("button", { class: "pr-btn ghost", onclick: () => quizToPoints(qz) }, "この得点を個人ポイントに加算") : null);
}

// ---- 妨害・賭け・スライドの操作（操作用の画面）
function betCloseNow(qz) {
  const b = writeBatch(db);
  resolveBets(qz, b, liveBase(qz));
  b.update(liveRef(), { betWin: null });
  fire(b.commit(), "賭けを締め切りました");
}

// 受付中の妨害を、確定したときと同じ順番・同じルールで仮に判定する（操作用の画面での確認用）
function previewSabo(L) {
  const all = runSabo();
  const accepted = all.filter((r) => r.status === "ok");
  const spent = new Map();
  return all.filter((r) => r.status === "pending").sort(byArrival).map((r) => {
    const c = L.saboWin?.open && r.forIndex === L.saboWin.index ? saboCheck(L, r, accepted, spent) : { ok: false, reason: "受付時間外" };
    if (c.ok) { accepted.push({ ...r, status: "ok" }); spent.set(c.payer.key, (spent.get(c.payer.key) ?? 0) + c.price); }
    return { r, c };
  });
}

function opExtras(L, qz) {
  const between = ["lobby", "closed", "reveal"].includes(L.phase);
  const nextIndex = L.phase === "lobby" ? 0 : L.index + 1;
  const hasNext = nextIndex < qz.questions.length;
  const rows = [];
  if (L.phase === "lobby") {
    const n = ruleSlides(L).length;
    rows.push(L.slide == null
      ? h("button", { class: "btn-small ghost", onclick: () => quizLiveUpdate({ slide: 0 }) }, "ルール説明（スライド）を表示")
      : h("div", { class: "op-slidectl" },
        h("b", null, "ルール説明"),
        h("button", { class: "btn-small ghost", disabled: L.slide <= 0, onclick: () => quizLiveUpdate({ slide: L.slide - 1 }) }, "← 前"),
        h("span", null, `${L.slide + 1} / ${n}`),
        h("button", { class: "btn-small ghost", disabled: L.slide >= n - 1, onclick: () => quizLiveUpdate({ slide: L.slide + 1 }) }, "次 →"),
        h("button", { class: "btn-small ghost", onclick: () => quizLiveUpdate({ slide: null }) }, "説明を閉じる")));
  }
  if (L.sabo?.on) {
    if (L.saboWin?.open) {
      const pv = previewSabo(L);
      rows.push(h("div", { class: "op-win sabo" },
        h("div", { class: "op-win-head" }, h("span", { class: "live-dot" }), `妨害受付中（第${L.saboWin.index + 1}問）${pv.length}件`,
          h("button", { class: "btn-small ghost", onclick: () => quizLiveUpdate({ saboWin: null }) }, "受付を中止")),
        pv.length ? pv.map(({ r, c }) => h("div", { class: `op-win-row${c.ok ? " ok" : " ng"}` },
          `${memberName(r.uid)} → ${memberName(r.target)}「${SABO_TYPES[r.type]?.label}」`, h("small", null, c.ok ? `${c.price}pt` : c.reason))) : h("div", { class: "op-win-row" }, "まだ申し込みはありません"),
        h("div", { class: "cell-sub" }, "次の問題を出した瞬間に、この順番で確定します（失敗したものはポイントを引きません）。")));
    } else if (between && hasNext) {
      rows.push(h("button", { class: "btn-small", onclick: () => quizLiveUpdate({ saboWin: { index: nextIndex, open: true } }) }, `妨害受付を開始（第${nextIndex + 1}問）`));
    }
  }
  if (L.bet?.on && L.phase !== "results") {
    if (L.betWin?.open) {
      const bets = runBets().filter((b) => b.status === "pending");
      rows.push(h("div", { class: "op-win bet" },
        h("div", { class: "op-win-head" }, h("span", { class: "live-dot" }), `賭け受付中 ${bets.length}件（${bets.reduce((x, b) => x + (Number(b.amount) || 0), 0)}pt）`,
          h("button", { class: "btn-small", onclick: () => betCloseNow(qz) }, "締め切る（賭け金を確定）")),
        h("div", { class: "cell-sub" }, "次の問題を出したときにも自動で締め切ります。")));
    } else if (between) {
      rows.push(h("button", { class: "btn-small ghost", onclick: () => quizLiveUpdate({ betWin: { open: true } }) }, "賭け受付を開始"));
    }
  }
  return rows.length ? h("div", { class: "card op-ctl" }, rows) : null;
}

// ---- 表示用：妨害・賭けのパネル
function oddsBoard(L, compact) {
  const cfg = L.bet;
  const bets = runBets().filter((b) => b.status !== "ng");
  const kinds = BET_KEYS.filter((k) => cfg.kinds[k]?.on);
  const people = quizAudience(L.answerers);
  const win = cfg.kinds.win?.on ? betPools(bets, "win") : null;
  return h("div", { class: `pr-odds${compact ? " compact" : ""}` },
    h("div", { class: "pr-side-title" }, "オッズ"),
    h("div", { class: "pr-pools" }, kinds.map((k) => h("span", null, BET_KINDS[k].label, h("b", null, `${betPools(bets, k).total}pt`)))),
    win ? h("ol", { class: "pr-oddlist" }, people.map((m) => ({ m, o: betOdds(win, betKey("win", [m.id]), cfg.rate), on: win.byKey.get(m.id) ?? 0 }))
      .sort((a, b) => a.o - b.o).slice(0, compact ? 6 : 10).map(({ m, o, on }) => h("li", null, h("span", null, m.name), h("small", null, `${on}pt`), h("b", null, `${o}倍`)))) : null,
    kinds.filter((k) => k !== "win").map((k) => {
      const p = betPools(bets, k);
      const top = [...p.byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      return top.length ? h("div", { class: "pr-combos" }, h("div", { class: "pr-side-sub" }, `${BET_KINDS[k].label} 人気`),
        top.map(([key, amt]) => h("div", null, h("span", null, key.split(/[>+]/).map(memberName).join(BET_KINDS[k].ordered ? "→" : "・")), h("b", null, `${betOdds(p, key, cfg.rate)}倍`)))) : null;
    }));
}

function displaySide(L) {
  const parts = [];
  if (L.saboWin?.open) {
    const reqs = runSabo().filter((r) => r.status === "pending" && r.forIndex === L.saboWin.index).sort(byArrival);
    parts.push(h("div", { class: "pr-side-card sabo" },
      h("div", { class: "pr-side-title" }, h("span", { class: "live-dot" }), `妨害受付中 ・ 第${L.saboWin.index + 1}問`),
      reqs.length ? h("ol", { class: "pr-reqs" }, reqs.map((r) => h("li", { class: firstTime(`rq:${r.id}`) ? "enter" : null },
        h("b", null, memberName(r.uid)), " → ", h("b", null, memberName(r.target)), h("span", { class: "mk2" }, SABO_TYPES[r.type]?.mark ?? "!"), SABO_TYPES[r.type]?.label)))
        : h("div", { class: "pr-side-sub" }, "スマホから申し込んでください")));
  }
  if (L.betWin?.open) parts.push(h("div", { class: "pr-side-card bet" }, h("div", { class: "pr-side-title" }, h("span", { class: "live-dot" }), "賭け受付中"), oddsBoard(L, !!L.saboWin?.open)));
  return parts.length ? h("aside", { class: "pr-side" }, parts) : null;
}

// 今の問題で発動している妨害（表示用の画面の上に並べる）
function effectRow(L) {
  const fxs = effectList(L);
  if (!fxs.length || L.phase === "lobby" || L.phase === "results") return null;
  return h("div", { class: `pr-fxrow${firstTime(`fxr:${L.seq}`) ? " enter" : ""}` }, h("span", { class: "pr-fx-label" }, "妨害発動"),
    fxs.map((f) => h("span", { class: "pr-fx" }, h("span", { class: "mk2" }, SABO_TYPES[f.type]?.mark ?? "!"), `${memberName(f.by)} → `, h("b", null, memberName(f.target)), `「${SABO_TYPES[f.type]?.label ?? f.type}」`)));
}

// 結果発表で出す：妨害の記録と賭けの結果
function resultsExtras() {
  const sabo = runSabo().filter((r) => r.status === "ok").sort((a, b) => a.forIndex - b.forIndex || byArrival(a, b));
  const bets = runBets().filter((b) => ["win", "lose", "refund"].includes(b.status));
  const hits = bets.filter((b) => b.status === "win").sort((a, b) => b.payout - a.payout);
  const cards = [];
  if (sabo.length) cards.push(h("div", { class: "pr-res-card" }, h("div", { class: "pr-side-title" }, `妨害の記録 ${sabo.length}件`),
    h("ol", null, sabo.map((r) => h("li", null, h("small", null, `第${r.forIndex + 1}問`), `${memberName(r.uid)} → ${memberName(r.target)}「${SABO_TYPES[r.type]?.label}」`, h("em", null, `−${r.price}pt`))))));
  if (bets.length) cards.push(h("div", { class: "pr-res-card" }, h("div", { class: "pr-side-title" }, hits.length ? `賭けの的中 ${hits.length}件` : "賭け：的中なし（全額返金）"),
    h("ol", null, (hits.length ? hits : []).map((b) => h("li", null, h("b", null, memberName(b.uid)), `${BET_KINDS[b.kind]?.label} ${b.pick.map(memberName).join("→")}`, h("em", null, `+${b.payout}pt（${b.amount}pt）`))))));
  return cards.length ? h("div", { class: "pr-res-extra" }, cards) : null;
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
        : L.phase === "question" ? h("div", { class: "pr-turn-count", "data-turncount": "" }, Math.ceil(turnLeft(cur.uid))) : null,
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
      (L.sessions?.length ?? 0) > 1 ? h("span", { class: "pr-badge session" }, sessionAt(L, L.index)?.name ?? "") : null,
      h("span", { class: "pr-badge" }, `第${L.index + 1}問 / ${qz.questions.length}`),
      h("span", { class: `pr-badge type-${q?.type}` }, QTYPE[q?.type] ?? ""),
      h("span", { class: "pr-badge" }, `${q?.points ?? 10}点`),
      L.phase === "closed" ? h("span", { class: "pr-badge closed" }, "締切") : null,
      L.phase === "reading" ? h("span", { class: "pr-badge reading" }, "問題") : null),
    rem != null ? h("div", { class: `pr-timer${rem <= 5 ? " hurry" : ""}` }, Math.ceil(rem)) : null,
    h("button", { class: "pr-exit", title: "表示用画面を閉じる", onclick: closePresenter }, icon("xmark")));

  let body;
  if (L.phase === "lobby" && L.slide != null) {
    body = slideView(L, "sl-display");
  } else if (L.phase === "lobby") {
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
    } else if (q.type === "order") {
      detail = revealed
        ? h("ol", { class: `pr-seq correct${firstTime(`so:${L.seq}`) ? " enter" : ""}` }, (q.choices ?? []).map((c, k) => h("li", { style: `--d:${k * 0.35}s` }, h("span", { class: "seq-no" }, k + 1), h("span", null, c))))
        : h("div", { class: "pr-seq-items" }, (L.q?.choices ?? []).map((c) => h("span", null, c)));
    } else if (q.type === "vote") {
      const r = voteResult(q);
      const n = q.voteMode === "rank" ? seqLen(q) : 0;
      const picks = q.voteMode === "rank" ? null : r.texts.map((_, k) => answers.filter((a) => a.choice === k).length);
      const max = Math.max(1, ...r.counts);
      detail = revealed
        ? h("div", { class: `pr-vote${firstTime(`sv:${L.seq}`) ? " enter" : ""}` }, r.rank.map((k, i) => {
          const pos = voteRankOf(r, k);
          const hit = n ? pos <= n : r.top.includes(k);
          return h("div", { class: `pr-vote-row${hit ? " hit" : ""}`, style: `--d:${(r.rank.length - i) * 0.25}s` },
            h("span", { class: "pr-vote-no" }, n && pos <= n ? `${pos}位` : ""), h("span", { class: "pr-vote-txt" }, r.texts[k]),
            h("span", { class: "pr-vote-track" }, h("span", { style: `width:${(r.counts[k] / max) * 100}%` })), h("b", null, `${r.counts[k]}${r.unit}`));
        }))
        : h("div", { class: "pr-seq-items" }, r.texts.map((c, k) => h("span", null, c, picks && L.phase === "reveal" && L.showAns === "all" ? h("small", null, ` ${picks[k]}人`) : null)));
    }
    body = h("div", { class: "pr-q" },
      readTextEl(L, `pr-text-q${firstTime(`dq:${L.seq}`) ? " enter" : ""}`),
      detail,
      revealed && q.type !== "choice" && q.answer ? h("div", { class: `pr-answer${firstTime(`da:${L.seq}`) ? " enter" : ""}` }, "正解：", q.answer) : null);
  }
  const side = displaySide(L);
  setKids(P, head, effectRow(L), side ? h("div", { class: "pr-row" }, body, side) : body, L.phase === "lobby" || L.phase === "results" ? null : answerBar(L, qz));
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
      h("div", { class: "op-sub" }, L.phase === "lobby" || L.phase === "results" ? phaseLabel : `${sessionAt(L, L.index)?.name ?? ""} 第${L.index + 1}問 / ${qz.questions.length} ・ ${QTYPE[q?.type]} ・ ${phaseLabel}`)),
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
        : h("div", { class: "op-next-sub" }, "正解：", (nq.type === "order" || nq.type === "vote" ? answerLabel(nq, revealAnswerOf(nq)) : nq.answer) || "（未設定）"),
      h("label", { class: "op-next-read" }, t, h("span", null, "問題読み画面を入れる")));
  })() : null;

  let body;
  if (L.phase === "lobby") {
    body = h("div", { class: "op-body" },
      h("p", { class: "op-note" }, "表示用の画面（プロジェクター）は、もう1台の端末で「クイズ」→「表示用の画面を開く」から開いてください。"),
      opExtras(L, qz),
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
      const shown = q.type !== "buzz" ? answerTextOf(q, a) + (isSeqType(q) ? `（${seqHits(q, a)}/${seqLen(q)}）` : "")
        : buzzText(a) ? `「${buzzText(a)}」` : hasTurn ? "入力中…" : "待機";
      return h("div", { class: `cell op-ans${ok === true ? " ok" : ok === false ? " ng" : ""}${hasTurn ? " turn" : ""}` },
        order ? h("span", { class: "op-rank" }, i + 1) : null,
        h("div", { class: "cell-main" },
          h("b", null, memberName(a.uid), hasTurn ? h("span", { class: "op-turn" }, "解答権") : null),
          h("div", { class: "cell-sub" }, `${shown} ・ ${fmtSec(a.reactionMs)}`, match ? h("span", { class: "op-match" }, "正解と一致") : null),
          hasTurn && !a.text ? h("div", { class: "op-turn-count", "data-turncount": "" }, `残り ${Math.ceil(turnLeft(a.uid))} 秒`) : null),
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
    const fxs = effectList(L);
    body = h("div", { class: "op-body" },
      opExtras(L, qz),
      fxs.length ? h("div", { class: "op-fx" }, "妨害：", fxs.map((f) => `${memberName(f.by)}→${memberName(f.target)}「${SABO_TYPES[f.type]?.label}」`).join("　")) : null,
      h("div", { class: "card op-q" },
        h("div", { class: "op-qtext" }, q.text || "（問題文なし）"),
        reading ? h("div", { class: "op-readline" }, "画面の表示：", readTextEl(L, "op-readprog"),
          h("button", { class: "btn-small ghost", onclick: () => quizSetPhase(L.phase, { fullText: true }) }, "全文を表示")) : null,
        q.type === "choice" ? h("div", { class: "op-choices" }, (q.choices ?? []).map((c, k) =>
          h("div", { class: `op-choice${q.answer === k ? " correct" : ""}`, style: `--c:${CHOICE_COLORS[k]}` }, `${CHOICE_MARKS[k]} ${c}`))) : null,
        isSeqType(q) || q.type === "vote" ? h("div", { class: "op-correct" }, "正解：", answerLabel(q, revealAnswerOf(q)) || "（アンケートを選んでください）",
          q.type === "vote" ? h("small", null, `（アンケート「${S.polls.get(q.pollId)?.question ?? "なし"}」の今の集計）`) : null)
          : q.type !== "choice" ? h("div", { class: "op-correct" }, "正解：", q.answer || "（未設定）") : null,
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
    h("button", { class: "pr-btn danger", onclick: quizEnd }, quizEndArmed() ? "もう一度押して終了" : "終了"));
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
  if (myEffect() === "seal") return toast("封印されているので解答できません", true);
  if (lateLeft() > 0) return toast(`出遅れ中：あと${Math.ceil(lateLeft())}秒`, true);
  const reactionMs = Math.round(performance.now() - QZ.t0);
  fire(setDoc(D("quizAnswers", `${L.quizId}_${L.index}_${uid}`), {
    uid, quizId: L.quizId, index: L.index, reactionMs, at: serverTimestamp(), ...data,
  }));
}

// 並べ替え・順位当て：項目をタップした順に番号が付き、そろったら送信する。
// 並べ替えはスマホにバラバラの順（q.perm[表示の位置] = 元の番号）で出ているので、送るときに元の番号へ戻す
QZ.seqDraft = { key: null, seq: [] };
function seqBuilder(L, q, mine, locked, blind) {
  const need = seqLen(q);
  const toVal = (p) => (q.type === "order" ? q.perm?.[p] ?? p : p);
  const toPos = (v) => (q.type === "order" ? (q.perm ?? []).indexOf(v) : v);
  const D0 = QZ.seqDraft;
  if (D0.key !== L.seq) { D0.key = L.seq; D0.seq = (mine?.order ?? []).map(toPos).filter((p) => p >= 0); }
  const seq = D0.seq;
  const repaint = () => paintMemberQuiz(true);
  const tap = (p) => {
    if (locked) return;
    const at = seq.indexOf(p);
    if (at >= 0) seq.splice(at, 1);
    else if (seq.length < need) {
      seq.push(p);
      // 並べ替えで残り1つになったら、最後は自動で入れる
      if (q.type === "order" && seq.length === need - 1) seq.push([...Array(need).keys()].find((x) => !seq.includes(x)));
    }
    repaint();
  };
  const sent = mine?.order && mine.order.length === seq.length && mine.order.every((v, i) => v === toVal(seq[i]));
  const label = (p) => (blind ? `${p + 1}` : q.choices?.[p] ?? "");
  const unit = q.type === "order" ? "番目" : "位";
  // 正解の発表後は、送った答えの各位置に ○× を付ける
  const marks = answerVisible(L) && L.answer && sent ? seqMarks({ ...q, answer: L.answer }, mine.order) : null;
  return h("div", { class: "ql-seq" },
    h("ol", { class: "ql-seq-slots" }, [...Array(need).keys()].map((n) =>
      h("li", { class: `${seq[n] != null ? "on" : ""}${marks ? (marks[n] ? " ok" : " ng") : ""}` }, h("span", { class: "seq-no" }, n + 1), seq[n] != null ? label(seq[n]) : h("span", { class: "secondary" }, `${n + 1}${unit}をタップ`),
        marks ? h("span", { class: "seq-mark" }, marks[n] ? "○" : "×") : null))),
    h("div", { class: "ql-seq-items" }, (q.choices ?? []).map((c, p) => {
      const at = seq.indexOf(p);
      return h("button", { class: `ql-seq-item${at >= 0 ? " picked" : ""}`, disabled: locked || (at < 0 && seq.length >= need), onclick: () => tap(p) },
        at >= 0 ? h("span", { class: "seq-badge" }, at + 1) : null, label(p));
    })),
    h("div", { class: "ql-seq-actions" },
      h("button", { class: "ql-seq-reset", disabled: locked || !seq.length, onclick: () => { seq.length = 0; repaint(); } }, "やり直す"),
      h("button", { class: "ql-send", disabled: locked || seq.length !== need || sent, onclick: () => quizAnswer({ order: seq.map(toVal) }) }, sent ? "送信済み" : mine ? "送り直す" : "送信")));
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
    if (!text || ui.sent || L2?.turn?.uid !== uid || L2.phase !== "question" || turnLeft(uid) === 0) return;
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
  const late = lateLeft();
  const open = L.phase === "question" && rem !== 0 && myEffect() !== "seal" && late === 0;
  const order = buzzOrder(L.index);
  const rank = order.findIndex((a) => a.uid === uid) + 1;
  const myTurn = L.phase === "question" && L.turn?.uid === uid;
  const verdict = mine ? (typeof mine.judge === "boolean" ? mine.judge : mine.timeout ? false : null) : null;
  const sent = ui.sent || !!mine?.text;
  const left = myTurn ? turnLeft(uid) : null;
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
  else if (!pressed) msg = late > 0 ? `出遅れ中：あと ${Math.ceil(late)} 秒` : open ? "" : "締め切りました";
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
  ui.input.oninput = () => { ui.send.disabled = !(S.live?.turn?.uid === uid && turnLeft(uid) > 0 && ui.input.value.trim()); };
}

// ---- ルール説明のスライド（表示用・スマホで同じ内容を出す）
function ruleSlides(L) {
  const slides = [];
  const ss = L.sessions ?? [];
  const range = (s) => {
    const idx = (L.qMeta ?? []).map((m, i) => (m.s === s.id ? i + 1 : null)).filter(Boolean);
    return idx.length ? (idx.length === 1 ? `第${idx[0]}問` : `第${idx[0]}〜${idx[idx.length - 1]}問`) : "問題なし";
  };
  const types = new Set((L.qMeta ?? []).map((m) => m.t));
  const setName = (cfg) => (cfg.pay === "team" ? `チームのポイント（${S.sets.get(cfg.setId)?.name ?? "チーム表"}）` : "自分の個人ポイント");
  slides.push({ title: L.title, sub: "ルール説明", body: h("div", { class: "sl-list" },
    h("div", { class: "sl-big" }, `全${L.total}問`),
    ss.length > 1 ? h("div", { class: "sl-chips" }, ss.map((s) => h("span", null, h("b", null, s.name), range(s)))) : null) });
  slides.push({ title: "答え方", body: h("div", { class: "sl-cards" },
    types.has("choice") ? h("div", { class: "sl-card" }, h("b", null, "4択"), "スマホで A〜D を選ぶ。締切までは変えられる") : null,
    types.has("text") ? h("div", { class: "sl-card" }, h("b", null, "記述"), "スマホに答えを入力して送信。締切までは送り直せる") : null,
    types.has("buzz") ? h("div", { class: "sl-card" }, h("b", null, "早押し"), `問題を読んでいる途中でも押せる。押した順に解答権 → ${BUZZ_ANSWER_SEC}秒以内に答えを入力。間違い・時間切れは次の人へ（減点あり）`) : null,
    types.has("order") ? h("div", { class: "sl-card" }, h("b", null, "並べ替え"), "バラバラに出る項目を、正しいと思う順にタップして送信。全部合って正解（部分点の問題もある）") : null,
    types.has("vote") ? h("div", { class: "sl-card" }, h("b", null, "投票当て"), "事前のアンケートで多かった答えを当てる。1位を選ぶ問題と、上位の順番をタップで並べる問題がある") : null) });
  const sb = L.sabo;
  if (sb?.on) {
    const on = SABO_KEYS.filter((k) => sb.types[k]?.on);
    slides.push({ title: "妨害システム", body: h("ul", { class: "sl-points" },
      h("li", null, h("b", null, sb.who === "all" ? "全員" : "解答者以外の人"), "が、ポイントを使って解答者を妨害できる"),
      h("li", null, "使うのは ", h("b", null, setName(sb))),
      h("li", null, "問題と問題の間の「妨害受付」の時間に、スマホから相手と種類を選んで申し込む"),
      h("li", null, "次の問題が出た瞬間に発動。", h("b", null, "誰が誰を妨害したかは画面に出る"))) });
    slides.push({ title: "妨害の種類", body: h("div", { class: "sl-cards" }, on.map((k) => h("div", { class: "sl-card sabo" },
      h("div", { class: "sl-mark" }, SABO_TYPES[k].mark), h("b", null, SABO_TYPES[k].label), h("span", null, SABO_TYPES[k].desc), h("em", null, `${sb.types[k].price}pt`)))) });
    slides.push({ title: "妨害のルール", body: h("div", null,
      h("ul", { class: "sl-points" },
        h("li", null, "1問で1人が受ける妨害は ", h("b", null, "1つまで"), "（早い者勝ち）"),
        h("li", null, "失敗した申し込みは ", h("b", null, "ポイントが引かれない")),
        sb.streak2x ? h("li", null, "同じ人を2問続けて妨害すると ", h("b", null, "値段が2倍")) : null),
      h("table", { class: "sl-table" },
        h("caption", null, "区切りごとの上限（種類の列は、同じ人が受けられる回数）"),
        h("tr", null, h("th", null, "区切り"), h("th", null, "1人が妨害できる"), on.map((k) => h("th", null, SABO_TYPES[k].label))),
        ss.map((s) => h("tr", null, h("td", null, s.name), h("td", null, `${s.perUser}回`), on.map((k) => h("td", null, s.perTarget?.[k] ? `${s.perTarget[k]}回` : "なし")))))) });
  }
  const bt = L.bet;
  if (bt?.on) {
    slides.push({ title: "順位予想（賭け）", body: h("div", null,
      h("div", { class: "sl-cards" }, BET_KEYS.filter((k) => bt.kinds[k]?.on).map((k) => h("div", { class: "sl-card" }, h("b", null, BET_KINDS[k].label), BET_KINDS[k].desc))),
      h("ul", { class: "sl-points" },
        h("li", null, "最終順位を予想して ", h("b", null, setName(bt)), " を賭ける（1人 ", h("b", null, `${bt.max}pt`), " まで）"),
        h("li", null, "オッズは全員の賭け金で決まる（多く賭けられた予想ほど低い）。払戻率 ", h("b", null, `${bt.rate}%`)),
        h("li", null, "同点のときはどちらの順番でも当たり。誰も当たらなければ全額返す"))) });
  }
  return slides;
}

function slideView(L, cls) {
  const slides = ruleSlides(L);
  const n = Math.min(Math.max(0, L.slide ?? 0), slides.length - 1);
  const sl = slides[n];
  return h("div", { class: `sl ${cls}${firstTime(`sl:${cls}:${L.seq}:${n}`) ? " enter" : ""}` },
    h("div", { class: "sl-head" }, h("div", { class: "sl-title" }, sl.title), sl.sub ? h("div", { class: "sl-sub" }, sl.sub) : null),
    h("div", { class: "sl-body" }, sl.body),
    h("div", { class: "sl-dots" }, slides.map((_, i) => h("span", { class: i === n ? "on" : null }))));
}

// 自分がまだ確定していない妨害・賭けで使う予定のポイント（支払い元ごと）。残高の表示と事前チェックで引いておく
function myPendingSpend(L, uid) {
  const m = new Map();
  const add = (payer, n) => { if (payer && n) m.set(payer.key, (m.get(payer.key) ?? 0) + n); };
  if (L.sabo?.on) for (const r of runSabo()) if (r.uid === uid && r.status === "pending") add(payerOf(L.sabo, uid), Number(L.sabo.types[r.type]?.price) || 0);
  if (L.bet?.on) for (const r of runBets()) if (r.uid === uid && r.status === "pending") add(payerOf(L.bet, uid), Number(r.amount) || 0);
  return m;
}

// ---- 妨害の申し込み（スマホ）
QZ.saboSel = { target: null, type: null };
function saboPanel(L) {
  const uid = S.user.uid;
  const idx = L.saboWin.index;
  const qm = L.qMeta?.[idx];
  const sess = sessionAt(L, idx);
  const all = runSabo();
  const mine = all.filter((r) => r.uid === uid && r.forIndex === idx);
  const accepted = all.filter((r) => r.status === "ok" || (r.status === "pending" && r.uid === uid));
  const spent = myPendingSpend(L, uid);
  const payer = payerOf(L.sabo, uid);
  const used = all.filter((r) => r.uid === uid && (r.status === "ok" || r.status === "pending") && L.qMeta?.[r.forIndex]?.s === qm?.s).length;
  const targets = quizAudience(L.answerers).filter((m) => m.id !== uid);
  const sel = QZ.saboSel;
  if (sel.target && !targets.some((m) => m.id === sel.target)) sel.target = null;
  const types = SABO_KEYS.filter((k) => L.sabo.types[k]?.on && SABO_TYPES[k].for.includes(qm?.t));
  const check = (type) => (sel.target ? saboCheck(L, { uid, target: sel.target, type, forIndex: idx }, accepted, spent) : null);
  const cur = sel.type ? check(sel.type) : null;
  const earlier = sel.target && all.some((r) => r.status === "pending" && r.uid !== uid && r.forIndex === idx && r.target === sel.target);
  const send = () => {
    if (!cur?.ok) return;
    fire(addDoc(C("quizSabo"), { uid, quizId: L.quizId, run: L.run, forIndex: idx, target: sel.target, type: sel.type, at: serverTimestamp(), status: "pending" }), "申し込みました");
    sel.type = null;
  };
  return h("section", { class: "ql-panel sabo" },
    h("div", { class: "ql-panel-head" }, h("span", { class: "live-dot" }), `妨害受付中 ・ 第${idx + 1}問（${sess?.name ?? ""}・${QTYPE[qm?.t] ?? ""}）`),
    h("div", { class: "ql-panel-sub" }, payer ? `${payer.label}：${balanceOf(payer) - (spent.get(payer.key) ?? 0)}pt ・ ${sess?.name}であと ${Math.max(0, (sess?.perUser ?? 0) - used)} 回` : "チームに入っていないので妨害できません"),
    h("div", { class: "ql-label" }, "だれを？"),
    h("div", { class: "ql-picks" }, targets.map((m) => h("button", { class: `ql-pick${sel.target === m.id ? " on" : ""}`, onclick: () => { sel.target = m.id; paintMemberQuiz(); } }, m.name))),
    h("div", { class: "ql-label" }, "なにを？"),
    h("div", { class: "ql-types" }, types.map((k) => {
      const c = check(k);
      return h("button", { class: `ql-type${sel.type === k ? " on" : ""}${c && !c.ok ? " ng" : ""}`, disabled: !sel.target, onclick: () => { sel.type = k; paintMemberQuiz(); } },
        h("span", { class: "mk2" }, SABO_TYPES[k].mark), h("b", null, SABO_TYPES[k].label), h("em", null, c?.ok ? `${c.price}pt${c.streak ? "（2倍）" : ""}` : `${L.sabo.types[k].price}pt`),
        h("small", null, c && !c.ok ? c.reason : SABO_TYPES[k].desc));
    })),
    earlier ? h("div", { class: "ql-warn" }, "この人には先に申し込んだ人がいます（早い者勝ち）") : null,
    h("button", { class: "ql-send", disabled: !cur?.ok, onclick: send }, cur?.ok ? `${memberName(sel.target)} に「${SABO_TYPES[sel.type].label}」（${cur.price}pt）` : "相手と種類を選んでください"),
    mine.length ? h("div", { class: "ql-mylist" }, mine.map((r) => h("div", { class: `ql-myrow ${r.status}` },
      h("span", null, `${memberName(r.target)}「${SABO_TYPES[r.type]?.label}」`),
      r.status === "pending" ? h("button", { class: "text-btn", onclick: () => fire(deleteDoc(D("quizSabo", r.id)), "取り消しました") }, "取り消す")
        : h("small", null, r.status === "ok" ? `成功 −${r.price}pt` : r.reason ?? "失敗")))) : null,
    h("div", { class: "ql-note" }, "次の問題が出た瞬間に先着順で確定します。失敗したらポイントは引かれません。"));
}

// ---- 賭け（スマホ）
QZ.betSel = { kind: null, pick: [], amount: 5 };
function betPanel(L) {
  const uid = S.user.uid;
  const cfg = L.bet;
  const kinds = BET_KEYS.filter((k) => cfg.kinds[k]?.on);
  const sel = QZ.betSel;
  if (!kinds.includes(sel.kind)) { sel.kind = kinds[0]; sel.pick = []; }
  const K = BET_KINDS[sel.kind];
  const all = runBets();
  const live = all.filter((b) => b.status !== "ng");
  const mine = all.filter((b) => b.uid === uid);
  const usedAmt = mine.filter((b) => b.status === "ok" || b.status === "pending").reduce((x, b) => x + (Number(b.amount) || 0), 0);
  const payer = payerOf(cfg, uid);
  const spentAll = myPendingSpend(L, uid);
  const pendingAmt = payer ? spentAll.get(payer.key) ?? 0 : 0;
  const people = quizAudience(L.answerers);
  const pools = betPools(live, sel.kind);
  const full = sel.pick.length === K.n;
  const key = full ? betKey(sel.kind, sel.pick) : null;
  const odds = full ? betOdds(pools, key, cfg.rate) : null;
  const accepted = mine.filter((b) => b.status === "ok" || b.status === "pending");
  const spent = new Map(payer ? [[payer.key, pendingAmt]] : []);
  const checkNow = () => (sel.pick.length === K.n ? betCheck(L, { uid, kind: sel.kind, pick: sel.pick, amount: sel.amount }, accepted, spent) : null);
  // 金額を変えたときは、画面全体を作り直さずに、関係する所だけ書き換える
  // （作り直すと、入力欄から「賭ける」ボタンへ移るときにボタンが入れ替わって押せないことがある）
  const payoutNote = h("div", { class: "ql-note" });
  const warn = h("div", { class: "ql-warn" });
  const sendBtn = h("button", { class: "ql-send" }, "賭ける");
  const refresh = () => {
    const cc = checkNow();
    payoutNote.textContent = full && cc?.ok ? `当たれば 約 ${Math.floor(cc.amount * odds)}pt（オッズはこの後の賭けで変わります）` : "";
    payoutNote.hidden = !payoutNote.textContent;
    warn.textContent = cc && !cc.ok ? cc.reason : "";
    warn.hidden = !warn.textContent;
    sendBtn.disabled = !cc?.ok;
  };
  const amount = h("input", { type: "number", class: "ql-input ql-amount", min: "1", inputmode: "numeric", value: String(sel.amount) });
  amount.addEventListener("input", () => { sel.amount = Math.max(0, Math.floor(Number(amount.value) || 0)); refresh(); });
  const toggle = (id) => {
    const i = sel.pick.indexOf(id);
    if (i >= 0) sel.pick.splice(i, 1);
    else if (sel.pick.length < K.n) sel.pick.push(id);
    paintMemberQuiz();
  };
  const send = () => {
    const cc = checkNow();
    if (!cc?.ok) return;
    fire(addDoc(C("quizBets"), { uid, quizId: L.quizId, run: L.run, kind: sel.kind, pick: [...sel.pick], amount: cc.amount, at: serverTimestamp(), status: "pending" }), "賭けました");
    sel.pick = [];
    amount.blur();
    paintMemberQuiz();
  };
  sendBtn.addEventListener("click", send);
  refresh();
  return h("section", { class: "ql-panel bet" },
    h("div", { class: "ql-panel-head" }, h("span", { class: "live-dot" }), "順位予想・賭け受付中"),
    h("div", { class: "ql-panel-sub" }, payer ? `${payer.label}：${balanceOf(payer) - pendingAmt}pt ・ あと ${Math.max(0, cfg.max - usedAmt)}pt 賭けられます` : "チームに入っていないので賭けられません"),
    h("div", { class: "seg ql-seg" }, kinds.map((k) => h("button", { type: "button", "aria-selected": String(sel.kind === k), onclick: () => { sel.kind = k; sel.pick = []; paintMemberQuiz(); } }, BET_KINDS[k].label))),
    h("div", { class: "ql-note" }, K.desc),
    h("div", { class: "ql-picks" }, people.map((m) => {
      const pos = sel.pick.indexOf(m.id);
      const win1 = sel.kind === "win" ? betOdds(pools, betKey("win", [m.id]), cfg.rate) : null;
      return h("button", { class: `ql-pick${pos >= 0 ? " on" : ""}`, onclick: () => toggle(m.id) },
        pos >= 0 ? h("span", { class: "pos" }, K.ordered ? `${pos + 1}着` : "✓") : null, m.name, win1 ? h("small", null, `${win1}倍`) : null);
    })),
    full ? h("div", { class: "ql-odds" }, h("span", null, sel.pick.map(memberName).join(K.ordered ? " → " : "・")), h("b", null, `${odds}倍`)) : h("div", { class: "ql-note" }, `あと ${K.n - sel.pick.length} 人選んでください`),
    h("div", { class: "ql-amountrow" }, amount, h("span", null, "pt"),
      [1, 5, 10].map((v) => h("button", { class: "pill", onclick: () => { sel.amount = (sel.amount || 0) + v; paintMemberQuiz(); } }, `+${v}`))),
    payoutNote,
    warn,
    sendBtn,
    mine.length ? h("div", { class: "ql-mylist" }, mine.map((b) => h("div", { class: `ql-myrow ${b.status}` },
      h("span", null, `${BET_KINDS[b.kind]?.label} ${b.pick.map(memberName).join("→")} ・ ${b.amount}pt`),
      b.status === "pending" ? h("button", { class: "text-btn", onclick: () => fire(deleteDoc(D("quizBets", b.id)), "取り消しました") }, "取り消す")
        : h("small", null, { ok: "確定", ng: b.reason ?? "失敗", win: `的中 +${b.payout}pt`, lose: "はずれ", refund: `返金 +${b.payout}pt` }[b.status] ?? "")))) : null,
    h("div", { class: "ql-note" }, "締め切った時点で賭け金が引かれます（それまでは取り消せます）。"));
}

// 自分が受けた妨害のお知らせ（スマホ）
function effectBanner(L) {
  const fx = L.effects?.[S.user.uid];
  if (!fx || L.phase === "lobby" || L.phase === "results") return null;
  const T = SABO_TYPES[fx.type];
  return h("div", { class: `ql-fx${firstTime(`fx:${L.seq}`) ? " enter" : ""}` }, h("span", { class: "mk2" }, T?.mark ?? "!"),
    h("div", null, h("b", null, `${memberName(fx.by)} から「${T?.label ?? fx.type}」！`), h("small", null, T?.desc ?? "")));
}

// 今の問題での妨害（表示用・スマホ共通の一覧）
const effectList = (L) => Object.entries(L.effects ?? {}).map(([target, fx]) => ({ target, ...fx }));

// 自分のスマホでの選択肢の並び（「シャッフル」の妨害を受けたときだけ並べ替える。問題ごとに同じ並び）
function choiceOrder(L) {
  const base = [0, 1, 2, 3];
  if (myEffect() !== "shuffle") return base;
  let seed = [...`${L.seq}:${S.user.uid}`].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let i = base.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [base[i], base[j]] = [base[j], base[i]]; }
  return base;
}

// 結果発表で出す：自分の賭けの結果
function myBetResults() {
  const mine = runBets().filter((b) => b.uid === S.user.uid && b.status !== "ng");
  if (!mine.length) return null;
  return h("div", { class: "ql-mylist" }, h("div", { class: "ql-label" }, "賭けの結果"), mine.map((b) => h("div", { class: `ql-myrow ${b.status}` },
    h("span", null, `${BET_KINDS[b.kind]?.label} ${b.pick.map(memberName).join("→")} ・ ${b.amount}pt`),
    h("small", null, { win: `的中 +${b.payout}pt`, lose: "はずれ", refund: `返金 +${b.payout}pt`, ok: "集計中…", pending: "集計中…" }[b.status] ?? ""))));
}

const quizActiveForMe = (L) => !!(L && L.phase !== "off" && (amAnswerer() || canSabotage(L) || canBet(L)));

function paintMemberQuiz(full = true) {
  if (!full) { updateQuizTicks(); return; }
  // 答えを入力している最中は、同じ問題・同じ段階のあいだ作り直さない（キーボードが閉じないように）
  // 早押しの出題中と問題読みの間も、動く部分（文字・ボタン・秒数）は個別に書き換えるので作り直さない
  // （押した直後に作り直すと、入力欄にキーボードが出ないことがある）
  const typing = document.activeElement?.classList?.contains("ql-input");
  const live = S.live;
  const steady = live && ((live.phase === "question" && live.q?.type === "buzz") || live.phase === "reading") && amAnswerer();
  if ((typing || steady) && QZ.lastPaint === `${live?.seq}:${live?.phase}` && !QZ.hidden && quizActiveForMe(live) && document.querySelector(".quiz-live")) { updateQuizTicks(); return; }
  QZ.lastPaint = `${S.live?.seq}:${S.live?.phase}`;
  let el = document.querySelector(".quiz-live");
  let fab = document.querySelector(".quiz-fab");
  const L = S.live;
  if (!quizActiveForMe(L)) { el?.remove(); fab?.remove(); return; }
  if (QZ.hidden) {
    el?.remove();
    if (!fab) document.body.append(h("button", { class: "quiz-fab", onclick: () => { QZ.hidden = false; paintMemberQuiz(); } }, icon("quiz"), "クイズに戻る"));
    return;
  }
  fab?.remove();
  if (!el) { el = h("div", { class: "quiz-live", role: "dialog", "aria-label": "クイズ" }); document.body.append(el); }
  const scroll = el.scrollTop;

  const uid = S.user.uid;
  const answerer = amAnswerer();
  const q = L.q;
  const fx = answerer ? myEffect() : null;
  el.classList.toggle("flip", fx === "flip" && (L.phase === "question" || L.phase === "reading"));
  const mine = L.phase === "lobby" || L.phase === "results" ? null : S.quizAnswers.get(`${L.quizId}_${L.index}_${uid}`);
  const rem = answerer && L.phase === "question" ? remainingSec(L, true) : null;
  const late = lateLeft();
  const locked = L.phase !== "question" || rem === 0 || fx === "seal" || late > 0;
  const readingNow = L.phase === "reading";

  const head = h("div", { class: "ql-head" },
    h("div", { class: "ql-title" }, L.title, answerer ? null : h("span", { class: "ql-watch" }, "観戦")),
    L.phase === "lobby" || L.phase === "results" ? null : h("div", { class: "ql-meta" }, `${sessionAt(L, L.index)?.name ?? ""} 第${L.index + 1}問 / ${L.total} ・ ${QTYPE[q?.type] ?? ""} ・ ${q?.points ?? 10}点`),
    h("button", { class: "ql-close", "aria-label": "閉じる", onclick: () => { QZ.hidden = true; paintMemberQuiz(); } }, icon("xmark")));
  const qt = myQTime(L, true) || 1;
  const timer = rem != null ? h("div", { class: "ql-timer" }, h("div", { class: "bar", style: `width:${(rem / qt) * 100}%` }), h("span", null, `${Math.ceil(rem)}秒`)) : null;
  const panels = [
    L.phase !== "question" && L.phase !== "reading" && L.saboWin?.open && canSabotage(L) ? saboPanel(L) : null,
    L.phase !== "question" && L.phase !== "reading" && L.betWin?.open && canBet(L) ? betPanel(L) : null,
  ];

  let body;
  if (L.phase === "lobby" && L.slide != null) {
    body = slideView(L, "sl-phone");
  } else if (L.phase === "lobby") {
    body = h("div", { class: "ql-center" }, h("div", { class: `ql-big${firstTime(`ml:${L.seq}`) ? " enter" : ""}` }, "まもなく始まります"),
      h("div", { class: "ql-sub" }, answerer ? `${S.me?.name ?? ""} さん、準備はいいですか？` : "観戦モードです。妨害・賭けの受付が始まると、ここから参加できます"));
  } else if (L.phase === "results") {
    const rows = (L.scores ?? []).map((r) => ({ ...r, name: memberName(r.uid) }));
    const me = rows.findIndex((r) => r.uid === uid);
    body = h("div", { class: "ql-center" },
      answerer ? h("div", { class: "ql-sub" }, "あなたの得点") : h("div", { class: "ql-sub" }, "結果発表"),
      answerer ? h("div", { class: `ql-score${firstTime(`ms:${L.seq}`) ? " enter" : ""}` }, me >= 0 ? rows[me].score : 0, h("small", null, "点")) : null,
      answerer && me >= 0 ? h("div", { class: "ql-sub" }, `${rows.filter((r) => r.score > rows[me].score).length + 1}位 / ${rows.length}人`) : null,
      h("ol", { class: "ql-top" }, rows.slice(0, 3).map((r) => h("li", null, h("span", null, r.name), h("b", null, `${r.score}点`)))),
      myBetResults());
  } else if (!answerer) {
    // 観戦（解答者ではない人）
    const fxs = effectList(L);
    body = h("div", { class: "ql-q" },
      h("div", { class: "ql-sub" }, readingNow ? "問題読み中" : L.phase === "question" ? "出題中 — 前の画面を見てください" : L.phase === "closed" ? "締切" : "正解発表"),
      fxs.length ? h("div", { class: "ql-fxlist" }, fxs.map((f) => h("div", null, `${memberName(f.by)} → ${memberName(f.target)}「${SABO_TYPES[f.type]?.label ?? f.type}」`))) : null);
  } else {
    const myShown = isShown(L, uid);
    const correctNow = myShown ? (q.type === "buzz" ? (typeof mine?.judge === "boolean" ? mine.judge : mine?.timeout ? false : null) : autoJudge({ ...q, answer: L.answer }, mine ?? {}) && !!mine) : null;
    const judgeOverride = typeof mine?.judge === "boolean" ? mine.judge : null;
    const verdict = myShown ? (judgeOverride ?? correctNow) : null;
    const partialHits = myShown && isSeqType(q) && mine && L.answer && judgeOverride == null ? seqHits({ ...q, answer: L.answer }, mine) : 0;
    const blind = fx === "blind";
    let input;
    if (readingNow) {
      input = h("div", { class: "ql-reading" }, h("span", { class: "live-dot" }), "問題を読んでいます。まもなく解答開始です");
    } else if (fx === "seal" && L.phase === "question") {
      input = h("div", { class: "ql-sealed" }, h("div", { class: "mk2 big" }, "封"), "封印されています。この問題は解答できません");
    } else if (q.type === "choice") {
      const gray = fx === "shuffle";
      input = h("div", { class: "ql-choices" }, choiceOrder(L).map((k) => h("button", {
        class: `ql-choice${mine?.choice === k ? " picked" : ""}${answerVisible(L) && L.answer === k ? " correct" : ""}`,
        style: `--c:${gray ? "#8E8E93" : CHOICE_COLORS[k]}`, disabled: locked,
        onpointerdown: (e) => { e.preventDefault(); quizAnswer({ choice: k }); },
      }, gray ? null : h("span", { class: "mark" }, CHOICE_MARKS[k]), q.phone !== false && !blind ? h("span", { class: "txt" }, q.choices?.[k] ?? "") : gray ? h("span", { class: "txt" }, "？") : null)));
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
    } else if (q.type === "vote" && q.voteMode !== "rank") {
      const A = answerVisible(L) ? L.answer : null;
      input = h("div", { class: "ql-options" }, (q.choices ?? []).map((c, k) => h("button", {
        class: `ql-option${mine?.choice === k ? " picked" : ""}${A?.top?.includes(k) ? " correct" : ""}`, disabled: locked,
        onclick: () => quizAnswer({ choice: k }),
      }, blind ? `${k + 1}` : c, A ? h("small", null, `${A.counts?.[k] ?? 0}${A.unit ?? "票"}`) : null)));
    } else if (isSeqType(q)) {
      input = seqBuilder(L, q, mine, locked, blind);
    } else {
      input = buzzPanel(L);
    }
    const status = q.type === "buzz" ? (L.phase === "closed" ? "締め切りました。正解発表を待っています…" : "") : L.phase === "question"
      ? (mine ? (q.type === "choice" || q.type === "vote" ? "回答しました（締切まで変えられます）" : q.type === "text" || isSeqType(q) ? "送信しました（締切まで送り直せます）" : "") : rem === 0 ? "時間切れ" : "")
      : L.phase === "closed" ? "締め切りました。正解発表を待っています…" : "";
    body = h("div", { class: "ql-q" },
      effectBanner(L),
      blind && L.phase !== "reveal" ? h("div", { class: "ql-qtext muted" }, "目隠し中：問題文は表示されません")
        : q.phone !== false ? readTextEl(L, `ql-qtext${firstTime(`mq:${L.seq}`) ? " enter" : ""}`) : h("div", { class: "ql-qtext muted" }, "問題は前の画面を見てください"),
      late > 0 && q.type !== "buzz" ? h("div", { class: "ql-late", "data-late": "" }, `出遅れ中：あと ${Math.ceil(late)} 秒`) : null,
      input,
      status ? h("div", { class: "ql-status" }, status) : null,
      L.phase === "reveal" ? h("div", { class: `ql-verdict${verdict === true ? " ok" : verdict === false ? " ng" : ""}${firstTime(`mv:${L.seq}:${myShown}`) ? " enter" : ""}` },
        myShown ? markSvg(verdict, firstTime(`me:${L.seq}:${verdict}`), "mark-phone") : null,
        h("div", { class: "ql-vtext" }, !myShown ? "発表を待っています…" : verdict === true ? "正解！" : verdict === false ? (partialHits ? `おしい！ ${partialHits}/${seqLen(q)}` : "不正解…") : mine ? "判定を待っています" : "未回答"),
        myShown && partialHits && verdict === false && q.partial ? h("div", { class: "ql-sub" }, `部分点 ${Math.floor(((Number(q.points) || 0) * partialHits) / seqLen(q))}点`) : null,
        answerVisible(L) && q.type !== "choice" && answerLabel(q, L.answer) ? h("div", { class: "ql-ans" }, `正解：${answerLabel(q, L.answer)}`) : null) : null);
  }
  setKids(el, head, timer, body, panels);
  el.scrollTop = scroll;
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
    const n = Math.ceil(turnLeft(S.live?.turn?.uid));
    el.textContent = el.classList.contains("op-turn-count") ? `残り ${n} 秒` : n;
    el.classList.toggle("hurry", n <= 3);
  }
  if (!S.isAdmin) {
    updateBuzzPanel();
    const late = lateLeft();
    for (const el of document.querySelectorAll("[data-late]")) el.textContent = `出遅れ中：あと ${Math.ceil(late)} 秒`;
    // 出遅れが終わった瞬間に、ボタンを押せるように描き直す
    if (myEffect() === "late" && late === 0 && QZ.lateDone !== L.seq && L.phase === "question") { QZ.lateDone = L.seq; QZ.lastPaint = null; paintMemberQuiz(true); }
  }
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
    if (bar) bar.style.width = `${(rem / (myQTime(L, true) || 1)) * 100}%`;
    if (txt) txt.textContent = `${Math.ceil(rem)}秒`;
  }
}

// 解答者側：時間切れになった瞬間だけ全体を描き直してボタンを止める。それ以外はタイマー・問題読み・解答権の秒数だけ
setInterval(() => {
  const L = S.live;
  if (S.isAdmin || !(L?.phase === "question" || L?.phase === "reading") || !quizActiveForMe(L) || QZ.hidden) return;
  if (L.phase === "question" && L.q?.time && remainingSec(L, true) === 0 && QZ.lockedSeq !== L.seq) { QZ.lockedSeq = L.seq; paintMemberQuiz(true); return; }
  updateQuizTicks();
}, 200);

// ---------------------------------------------------------------- 出欠（アンケート）と集金
//
//   polls/{id}       { question, options: [..], deadline: "YYYY-MM-DDTHH:mm" | null, open, showResults, allowComment, createdAt }
//   votes/{pollId}_{uid}  { uid, pollId, choice, comment, at, byAdmin }   … 参加者が自分で書く（管理者が代わりに入れることもできる）
//   payments/{id}    { title, amount, due, note, targets: [uid] | null(=全員), createdAt,
//                      records: { uid: { status: "paid" | "unpaid" | "exempt", method, amount, at } } }   … 入金済みなどは管理者が付ける
//
//   payReports/{paymentId}_{uid}  { uid, paymentId, method, note, image(縮小した画像) | null, at }
//                    … 参加者の「送金しました」の報告。入金済みにするのは管理者（報告はあくまで確認のきっかけ）
//
// 1件のアンケート・集金に参加者全員分がぶら下がるだけなので、件数は少ない（読み取り回数も少ない）。

// 入力中（文字を打っている最中）は描き直さない。描き直すと入力欄が入れ替わって、打った内容やキーボードが消えるため。
// 入力欄から離れたら描き直す
const typingIn = (root) => root.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && !["checkbox", "file"].includes(document.activeElement.type);
const redrawOnLeave = (root) => root.addEventListener("focusout", () => setTimeout(() => scheduleRender(), 0));
const yen = (n) => `¥${(Number(n) || 0).toLocaleString("ja-JP")}`;
const PAY_METHODS = ["現金", "振込", "PayPay", "その他"];
const PAY_STATUS = { unpaid: "未入金", paid: "入金済み", exempt: "免除" };
const pollDeadlinePassed = (p) => !!p.deadline && Date.now() > new Date(p.deadline).getTime();
const pollOpen = (p) => p.open !== false && !pollDeadlinePassed(p);
const fmtDeadline = (s) => { if (!s) return ""; const d = new Date(s); return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
const sortedPolls = () => [...S.polls.values()].sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
// 終わった集金も消さずに残す（ほかのページの分も）。管理者の一覧では、終わったものを後ろに回す
const payAllDone = (p) => { const { paidN, n } = payTotals(p); return n > 0 && paidN >= n; };
const sortedPaymentsMemo = memo(() => [...S.payments.values()].sort((a, b) => ts(b.createdAt) - ts(a.createdAt)));
const sortedPayments = () => [...sortedPaymentsMemo()];
// ほかのページの集金は、そのページの参加者が対象（この旅行に入っていない人も含めて全員出す）
const payTargets = (p) => {
  const ms = (isExt(p.id) && pageMembers(extPid(p.id))) || sortedMembers();
  return p.targets ? ms.filter((m) => p.targets.includes(m.id)) : ms;
};
const pollTargets = (p) => (p.targets ? sortedMembers().filter((m) => p.targets.includes(m.id)) : sortedMembers()); // アンケートも同じ形（targets: [uid] | null(=全員)）
const isTarget = (x, uid) => !x.targets || x.targets.includes(uid);
// 回答順：最初に回答した時刻（firstAt）。回答を変えても順番は変わらない（firstAt がない古い回答は最後に変えた時刻）
const firstAtOf = (v) => (v ? v.firstAt ?? v.at ?? serverTimestamp() : serverTimestamp());
const fmtClock = (x) => {
  if (!x?.toDate) return "送信中…";
  const d = x.toDate();
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};
// 参加者：管理者が「ひとことを全員に見せる」にしたアンケートの、みんなのひとこと（匿名のアンケートは名前を出さない）
function pollComments(p, tally) {
  const list = tally.filter((v) => v.comment).sort((a, b) => ts(a.at) - ts(b.at));
  // 件数が増えると長くなるので開け閉めできるようにする（最初は閉じる）
  return h("div", { class: "poll-comments" }, keptFold(`pcom:${p.id}`, `みんなのひとこと（${list.length}件）`, h("div", { class: "poll-comments-list" },
    list.length ? list.map((v) => h("div", { class: "poll-comment-item" },
      p.anonymous ? null : h("b", null, memberName(v.uid)),
      h("span", null, v.comment))) : h("div", { class: "cell-sub" }, "まだひとことはありません"))));
}
// 管理者：アンケートの回答順と回答時刻
function voteOrderList(p, votes) {
  const first = (v) => ts(v.firstAt ?? v.at) || Date.now();
  const list = [...votes].sort((a, b) => first(a) - first(b) || ts(a.at) - ts(b.at));
  if (!list.length) return null;
  const answer = (v) => (isRankPoll(p) ? (v.order ?? [v.choice]).map((o, i) => `${i + 1}位 ${o}`).join("・") : v.choice);
  return keptFold(`order:${p.id}`, `回答順・回答時刻（${list.length}人）`, h("ol", { class: "vote-order" }, list.map((v, i) => {
    const changed = v.firstAt && v.at && ts(v.at) - ts(v.firstAt) > 1000;
    return h("li", null,
      h("span", { class: "vo-rank" }, `${i + 1}`),
      h("span", { class: "vo-name" }, memberName(v.uid), v.byAdmin ? h("small", null, "（管理者が入力）") : null),
      h("span", { class: "vo-choice" }, answer(v)),
      h("span", { class: "vo-time" }, fmtClock(v.firstAt ?? v.at), changed ? h("small", null, `変更 ${fmtClock(v.at)}`) : null));
  })));
}

// 順位投票（polls.rank = true）：各自が選択肢に 1位〜depth位 を付けて投票する（votes.order に順番、choice は1位）。
// 集計は点数（ボルダ式）：depth 位まで付けるとき、1位 = depth 点、2位 = depth−1 点 … depth位 = 1点
//   optionUids : 選択肢を参加者から選んだとき、選択肢と同じ順の uid（「自分には投票できない」に使う）
const isRankPoll = (p) => !!p?.rank;
const selfOption = (p, uid) => { const i = (p.optionUids ?? []).indexOf(uid); return i >= 0 ? p.options[i] : null; };
const pollDepth = (p) => Math.max(1, Math.min(Number(p.depth) || p.options.length, p.options.length - (p.noSelf && p.optionUids ? 1 : 0)));
function pollScores(p, votes) {
  const d = pollDepth(p);
  const pts = new Map(p.options.map((o) => [o, 0]));
  for (const v of votes) {
    if (isRankPoll(p)) (v.order ?? []).slice(0, d).forEach((o, i) => { if (pts.has(o)) pts.set(o, pts.get(o) + d - i); });
    else if (pts.has(v.choice)) pts.set(v.choice, pts.get(v.choice) + 1);
  }
  return pts;
}
const pollUnit = (p) => (isRankPoll(p) ? "点" : "票");

// アカウントにチェックを付けて対象者を選ぶ欄。選んだ状態は手元に持つので、描き直してもチェックは消えない
function memberChecks(initial) {
  const sel = new Set(initial ?? []);
  const list = h("div", { class: "pick-list" });
  const count = h("span", { class: "secondary" });
  const paint = () => {
    const ms = sortedMembers();
    count.textContent = `${ms.filter((m) => sel.has(m.id)).length} / ${ms.length}人`;
    setKids(list, ms.map((m) => {
      const cb = h("input", { type: "checkbox", checked: sel.has(m.id) });
      cb.addEventListener("change", () => { if (cb.checked) sel.add(m.id); else sel.delete(m.id); paint(); });
      return h("label", { class: "pick" }, cb, m.name);
    }));
  };
  const tools = h("div", { class: "pick-tools" }, count,
    h("button", { type: "button", class: "text-btn", onclick: () => { sortedMembers().forEach((m) => sel.add(m.id)); paint(); } }, "全員にチェック"),
    h("button", { type: "button", class: "text-btn", onclick: () => { sel.clear(); paint(); } }, "全部外す"));
  paint();
  return { el: h("div", { class: "member-checks" }, tools, list), value: () => [...sel], refresh: paint, set: (ids) => { sel.clear(); (ids ?? []).forEach((x) => sel.add(x)); paint(); } };
}

// 対象者：「全員（あとから増えた人も）」か「選ぶ」
function targetPicker(initial = null) {
  const mode = segmented([{ value: "all", label: "全員" }, { value: "pick", label: "アカウントから選ぶ" }], initial ? "pick" : "all");
  const checks = memberChecks(initial ?? sortedMembers().map((m) => m.id));
  const paint = () => { checks.el.hidden = mode.value !== "pick"; checks.refresh(); };
  mode.addEventListener("change", paint);
  paint();
  return {
    el: h("div", { class: "target-picker" }, mode, checks.el),
    value: () => (mode.value === "pick" ? checks.value() : null),
    refresh: paint,
    reset: () => { mode.value = "all"; checks.set(sortedMembers().map((m) => m.id)); paint(); },
  };
}

// 作ったあとで対象者を変える欄（集金・アンケート共通）。
// 一度作った欄は使い回す（描き直しのたびに作り直すと、開いた欄が閉じたり付けたチェックが消えたりするため）
const targetEditors = new Map();
function targetEditor(item, coll) {
  const key = `${coll}:${item.id}`;
  const cached = targetEditors.get(key);
  if (cached) { cached.label.textContent = cached.labelText(item); cached.picker.refresh(); return cached.el; }
  const picker = targetPicker(item.targets ?? null);
  const save = () => {
    const v = picker.value();
    if (v && !v.length) return toast("1人以上選んでください", true);
    fire(updateDoc(DX(coll, item.id), { targets: v }), v ? `対象を ${v.length}人にしました` : "対象を全員にしました");
  };
  const labelText = (it) => `対象者を変える・追加する（いま：${it.targets ? `${it.targets.length}人` : "全員"}）`;
  const el = fold(labelText(item),
    h("div", { class: "target-edit" }, picker.el, h("div", { class: "poll-actions" }, h("button", { class: "btn-small", type: "button", onclick: save }, "対象者を保存")),
      h("div", { class: "cell-sub" }, coll === "payments" ? "外した人の入金記録は消えずに残ります（もう一度入れると元に戻ります）。" : "外した人の回答は消えずに残ります（集計には入りません）。")));
  const label = el.querySelector("summary span");
  targetEditors.set(key, { el, label, labelText, picker });
  return el;
}

// 開いた折りたたみ欄を、描き直しても開いたままにする
const openFolds = new Set();
function keptFold(key, title, content, defaultOpen = false) {
  const el = fold(title, content, openFolds.has(key) || defaultOpen);
  el.addEventListener("toggle", () => { if (el.open) openFolds.add(key); else openFolds.delete(key); });
  return el;
}
const recordOf = (p, uid) => ({ status: "unpaid", ...(p.records?.[uid] ?? {}) });
const amountOf = (p, uid) => Number(p.records?.[uid]?.amount ?? p.amount) || 0;
// 1件の集金の合計（免除の人は数えない）
function payTotals(p) {
  const ms = payTargets(p);
  let expect = 0, got = 0, paidN = 0, n = 0;
  for (const m of ms) {
    const r = recordOf(p, m.id);
    if (r.status === "exempt") continue;
    n++;
    expect += amountOf(p, m.id);
    if (r.status === "paid") { got += amountOf(p, m.id); paidN++; }
  }
  return { expect, got, paidN, n };
}
// その人が対象か（ほかのページの集金で対象が「全員」のときは、そのページの参加者が対象）
const payFor = (p, uid) => (p.targets ? p.targets.includes(uid) : !isExt(p.id) || !pageMembers(extPid(p.id)) || pageMembers(extPid(p.id)).some((m) => m.id === uid));
// 自分の未入金の合計
const myUnpaid = (uid) => sortedPayments().filter((p) => payFor(p, uid))
  .reduce((s, p) => s + (recordOf(p, uid).status === "unpaid" ? amountOf(p, uid) : 0), 0);
const reportOf = (p, uid) => S.payReports.get(`${p.id}_${uid}`) ?? null;
const pendingCount = (p) => payTargets(p).filter((m) => reportOf(p, m.id) && recordOf(p, m.id).status === "unpaid").length;
// 報告はあるが、まだ入金済みにしていないもの（管理者の確認待ち）
const pendingReports = () => sortedPayments().flatMap((p) => payTargets(p).map((m) => ({ p, m, rep: reportOf(p, m.id) })))
  .filter((x) => x.rep && recordOf(x.p, x.m.id).status === "unpaid");
const reportLine = (rep) => [rep.method, rep.at ? fmtDate(rep.at) : "送信中…", rep.note].filter(Boolean).join(" ・ ");
const myUnanswered = (uid) => sortedPolls().filter((p) => isTarget(p, uid) && pollOpen(p) && !S.votes.has(`${p.id}_${uid}`)).length;

// 順位投票の集計（点数の多い順）。withVoters なら各自の順番も出す
function rankPollResult(p, votes, withVoters) {
  const pts = pollScores(p, votes);
  const rows = p.options.map((o, i) => ({ o, i, pt: pts.get(o) ?? 0 })).sort((a, b) => b.pt - a.pt || a.i - b.i);
  const max = Math.max(1, ...rows.map((r) => r.pt));
  const d = pollDepth(p);
  return h("div", { class: "poll-bars" },
    h("div", { class: "cell-sub" }, `順位投票（${d > 1 ? `${d}位まで・1位${d}点 … ${d}位1点` : "1位だけ・1点"}）・${votes.length}人が回答`),
    votes.length ? null : h("div", { class: "cell-sub" }, "まだ回答がありません"),
    // 順位の一覧（青いバー）は長くなるので開け閉めできるようにする（最初は閉じる。見出しに1位を出す）
    !votes.length ? null : keptFold(`rankres:${p.id}`, `順位を見る（1位：${rows.filter((r) => r.pt === rows[0].pt).map((r) => r.o).join("・")}）`, h("div", { class: "poll-bars" }, rows.map((r) => {
      const pos = 1 + rows.filter((x) => x.pt > r.pt).length;
      return h("div", { class: "poll-bar" },
        h("div", { class: "poll-bar-top" }, h("span", null, h("b", { class: "rank-pos" }, `${pos}位`), r.o), h("b", null, `${r.pt}点`)),
        h("div", { class: "poll-track" }, h("div", { style: `width:${(r.pt / max) * 100}%` })));
    }))),
    withVoters && votes.length ? keptFold(`rankv:${p.id}`, `各自の順番（${votes.length}人）`, h("div", { class: "rank-voters" }, votes.map((v) =>
      h("div", null, h("b", null, memberName(v.uid)), (v.order ?? []).map((o, i) => `${i + 1}.${o}`).join("　"), v.comment ? h("small", null, `「${v.comment}」`) : null)))) : null);
}

// 順位投票の入力（参加者）：タップした順に 1位・2位… が付き、そろったら「この順で投票」。
// 並べている途中の順番は手元に持つので、画面が描き直されても消えない
const rankDrafts = new Map(); // pollId -> { order: [選択肢], key: 最後に合わせた自分の回答 }
function rankPicker(p, mine, open, vote) {
  const uid = S.user.uid;
  const self = p.noSelf ? selfOption(p, uid) : null;
  const choices = p.options.filter((o) => o !== self);
  const d = Math.min(pollDepth(p), choices.length);
  const mineKey = JSON.stringify(mine?.order ?? null);
  let dr = rankDrafts.get(p.id);
  if (!dr || (dr.key !== mineKey && !dr.dirty)) { dr = { order: [...(mine?.order ?? [])].filter((o) => choices.includes(o)).slice(0, d), key: mineKey, dirty: false }; rankDrafts.set(p.id, dr); }
  const redraw = () => scheduleRender();
  const tap = (o) => {
    if (!open) return;
    dr.sel = null;
    const at = dr.order.indexOf(o);
    if (at >= 0) dr.order.splice(at, 1);
    else if (dr.order.length < d) {
      dr.order.push(o);
      // 全部に順位を付けるときは、残り1つを自動で最下位にする
      if (d === choices.length && dr.order.length === d - 1) dr.order.push(choices.find((x) => !dr.order.includes(x)));
    }
    dr.dirty = true;
    redraw();
  };
  const same = mine?.order && JSON.stringify(mine.order) === JSON.stringify(dr.order);
  return h("div", { class: "rank-pick" },
    h("div", { class: "cell-sub" }, `${d === choices.length ? "全員" : `上位${d}位まで`}に順位を付けてください（タップした順に1位・2位…。もう一度タップで外せます）${self ? "。自分には投票できません" : ""}`),
    // 順位の一覧は開け閉めできる（最初は閉じておく。選択肢のボタンにも順位の数字が付く）
    // 埋まった枠を2つ続けてタップすると入れ替わる（最初からタップし直さなくても順番を直せる）
    keptFold(`rankslots:${p.id}`, `あなたの順位（${dr.order.length} / ${d}位）`, [
      open && dr.order.length > 1 ? h("div", { class: "cell-sub rank-swap-help" }, dr.sel != null ? `「${dr.order[dr.sel]}」と入れ替える枠をタップ（もう一度タップでやめる）` : "埋まった枠を2つタップすると順位を入れ替えられます") : null,
      // 枠は本物のボタンにする（li のままだと、端末によってはタップに反応しない）
      h("ol", { class: "rank-slots" }, [...Array(d).keys()].map((n) => h("li", {
        class: [dr.order[n] ? "on" : "", dr.sel === n ? "sel" : ""].join(" ").trim() || null,
      }, h("button", {
        type: "button", class: "rank-slot-btn", disabled: !open || !dr.order[n],
        "aria-label": dr.order[n] ? `${n + 1}位 ${dr.order[n]}（タップして入れ替え）` : `${n + 1}位（空き）`,
        onclick: (e) => {
          e.preventDefault(); e.stopPropagation();
          if (!open || !dr.order[n]) return;
          if (dr.sel == null) dr.sel = n;
          else if (dr.sel === n) dr.sel = null;
          else { [dr.order[dr.sel], dr.order[n]] = [dr.order[n], dr.order[dr.sel]]; dr.sel = null; dr.dirty = true; }
          redraw();
        },
      }, h("span", { class: "seq-no" }, n + 1), dr.order[n] ?? h("span", { class: "secondary" }, `${n + 1}位`)))))]),
    h("div", { class: "poll-choices" }, choices.map((o) => {
      const at = dr.order.indexOf(o);
      return h("button", { class: `poll-choice${at >= 0 ? " ranked" : ""}`, disabled: !open || (at < 0 && dr.order.length >= d), onclick: () => tap(o) },
        at >= 0 ? h("span", { class: "rank-badge" }, at + 1) : null, o);
    })),
    open ? h("div", { class: "rank-actions" },
      h("button", { class: "text-btn", disabled: !dr.order.length, onclick: () => { dr.order = []; dr.sel = null; dr.dirty = true; redraw(); } }, "やり直す"),
      // 空いている枠を、選択肢の並び順で一度に埋める（あとは枠のタップで入れ替えるだけ）
      h("button", { class: "text-btn", disabled: dr.order.length >= d, onclick: () => {
        for (const o of choices) { if (dr.order.length >= d) break; if (!dr.order.includes(o)) dr.order.push(o); }
        dr.sel = null; dr.dirty = true; openFolds.add(`rankslots:${p.id}`); redraw();
      } }, "残りを順に埋める"),
      h("button", { class: "btn-small", disabled: dr.order.length !== d || same, onclick: () => { dr.dirty = false; dr.key = JSON.stringify(dr.order); vote([...dr.order]); } }, same ? "投票済み" : mine ? "この順で投票し直す" : "この順で投票")) : null);
}

// 旅行の集金を確定前ページへ移す（入金の記録・送金の報告もそのまま。移した後は確定前ページで管理し、確定した人には旅行のページにも出る）
async function movePaymentsToLobby(ids) {
  if (!ids.length) return;
  if (!S.profiles.has(LOBBY)) return toast("確定前ページがまだありません（設定から作れます）", true);
  const names = ids.map((id) => `「${S.payments.get(id)?.title ?? id}」`).join("");
  if (!confirm(`${names}を確定前ページへ移しますか？\n入金済みなどの記録と送金の報告もそのまま移ります。この旅行の「集金」からは消えます。`)) return;
  toast("移しています…");
  const [pays, reps] = await Promise.all([getDocs(C("payments")), getDocs(C("payReports"))]);
  let n = 0;
  for (const d of pays.docs.filter((x) => ids.includes(x.id))) {
    const b = writeBatch(db);
    b.set(LD("payments", d.id), d.data());
    b.delete(d.ref);
    for (const r of reps.docs.filter((x) => x.data().paymentId === d.id)) { b.set(LD("payReports", r.id), r.data()); b.delete(r.ref); }
    await b.commit(); // 送金の画像があると大きくなるので、集金1件ずつ書く
    n++;
  }
  toast(`${n}件を確定前ページへ移しました`);
}

// ---- 管理者
// ---- アンケートの申請（参加者 → 管理者が承認すると公開）
//   pollRequests/{自動}  { uid, question, options, deadline, allowComment, showResults, status: "pending" | "approved" | "rejected", reason, pollId, createdAt }
//   承認すると polls に { ..., proposedBy: uid } で作り、申請は status: "approved" にする
const sortedPollReqs = () => [...S.pollReqs.values()].sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
const pendingPollReqs = () => sortedPollReqs().filter((r) => r.status === "pending");
const splitOptions = (text) => [...new Set(String(text).split(/[/／,、\n]/).map((x) => x.trim()).filter(Boolean))];
// 提案者の名前は showProposer のときだけ参加者に出す（管理者には常に出す）
const proposedLabel = (p) => (!p.proposedBy ? null
  : p.showProposer !== false ? h("small", { class: "proposed-by" }, `${memberName(p.proposedBy)}さんの提案`)
  : S.isAdmin ? h("small", { class: "proposed-by off" }, `${memberName(p.proposedBy)}さんの提案（名前は非公開）`) : h("small", { class: "proposed-by" }, "参加者の提案"));

// 参加者：アンケートを申請する欄と、自分の申請の状況
function pollRequestBox() {
  const q = h("input", { type: "text", class: "plain", placeholder: "例：2日目の夜ごはん、何がいい？", maxlength: "100" });
  const opts = h("input", { type: "text", class: "plain", placeholder: "選択肢を / で区切る（例：焼肉 / 寿司 / カレー）", maxlength: "200" });
  const deadline = h("input", { type: "datetime-local" });
  const allowCom = toggle(true), showRes = toggle(true), showName = toggle(true);
  const form = h("form", { onsubmit: (e) => {
    e.preventDefault();
    const options = splitOptions(opts.value);
    if (!q.value.trim() || options.length < 2) return toast("質問と、選択肢を2つ以上入れてください", true);
    fire(addDoc(C("pollRequests"), { uid: S.user.uid, question: q.value.trim(), options, deadline: deadline.value || null, allowComment: allowCom.checked, showResults: showRes.checked, showName: showName.checked, status: "pending", createdAt: serverTimestamp() }),
      "申請しました。管理者が承認すると公開されます");
    q.value = opts.value = deadline.value = "";
  } },
    group(null, [h("div", { class: "cell" }, q), h("div", { class: "cell" }, opts), field("締切（任意）", deadline), field("ひとこと欄", allowCom), field("集計をみんなに見せる", showRes), field("自分の名前を出す", showName)],
      "管理者が内容を確認して承認すると、みんなに公開されます。「自分の名前を出す」をオフにすると「参加者の提案」とだけ表示されます（管理者には誰の申請かわかります）。"),
    h("button", { class: "btn-filled", type: "submit" }, "申請する"));
  const fold = keptFold("pollReqForm", "＋ アンケートを申請する", form);
  const mine = h("div");
  const el = h("div", { class: "poll-req-box" }, fold, mine);
  return {
    el,
    update() {
      const rs = sortedPollReqs().filter((r) => r.uid === S.user.uid).reverse();
      const label = { pending: "申請中（管理者の確認待ち）", approved: "承認されて公開されました", rejected: "見送られました" };
      setKids(mine, rs.length ? group("あなたの申請", rs.map((r) => h("div", { class: `cell poll-req mine ${r.status}` },
        h("div", { class: "cell-main" }, h("b", null, r.question), h("div", { class: "cell-sub" }, `${r.options.join(" / ")} ・ ${r.showName === false ? "名前を出さない" : "名前を出す"}`),
          h("div", { class: `poll-req-status ${r.status}` }, label[r.status] ?? r.status, r.status === "rejected" && r.reason ? `：${r.reason}` : "")),
        h("button", { class: "text-btn destructive", onclick: () => {
          if (!confirm(r.status === "pending" ? "この申請を取り下げますか？" : "この記録を消しますか？（公開されたアンケートは消えません）")) return;
          fire(deleteDoc(D("pollRequests", r.id)), r.status === "pending" ? "取り下げました" : "消しました");
        } }, r.status === "pending" ? "取り下げる" : "消す")))) : null);
    },
  };
}

// 管理者：参加者からの申請（内容を直してから承認できる）
const reqDrafts = new Map(); // 申請 id -> { q, opts }
function pollRequestReview() {
  const rs = pendingPollReqs();
  if (!rs.length) return null;
  return group(`参加者からの申請 ${rs.length}件`, rs.map((r) => {
    let d = reqDrafts.get(r.id);
    if (!d) {
      d = { q: editableInput({ class: "plain", maxlength: "100" }), opts: editableInput({ class: "plain", maxlength: "200" }), name: toggle(r.showName !== false) };
      reqDrafts.set(r.id, d);
    }
    d.q.sync(r.question);
    d.opts.sync(r.options.join(" / "));
    const approve = () => {
      const options = splitOptions(d.opts.value);
      if (!d.q.value.trim() || options.length < 2) return toast("質問と、選択肢を2つ以上にしてください", true);
      const b = writeBatch(db);
      const pref = doc(C("polls"));
      b.set(pref, { question: d.q.value.trim(), options, optionUids: null, noSelf: false, rank: false, depth: null, deadline: r.deadline ?? null, open: true,
        showResults: r.showResults !== false, allowComment: r.allowComment !== false, anonymous: false, targets: null, proposedBy: r.uid, showProposer: d.name.checked, createdAt: serverTimestamp() });
      b.update(D("pollRequests", r.id), { status: "approved", pollId: pref.id, reason: null });
      reqDrafts.delete(r.id);
      fire(b.commit(), "承認して公開しました");
    };
    const reject = () => {
      const reason = prompt("見送る理由（任意・申請した人に表示されます）", "");
      if (reason == null) return;
      reqDrafts.delete(r.id);
      fire(updateDoc(D("pollRequests", r.id), { status: "rejected", reason: reason.trim() || null }), "見送りました");
    };
    return h("div", { class: "cell poll-req" },
      h("div", { class: "cell-main" },
        h("div", { class: "cell-sub" }, `${memberName(r.uid)}さんから ・ ${fmtDate(r.createdAt)}`),
        h("div", { class: "poll-req-edit" }, d.q, d.opts),
        h("label", { class: "poll-req-name" }, d.name, `提案者の名前（${memberName(r.uid)}）を公開する`, r.showName === false ? h("small", null, "（本人は「出さない」を希望）") : null),
        h("div", { class: "cell-sub" }, [r.deadline ? `締切 ${fmtDeadline(r.deadline)}` : "締切なし", r.allowComment !== false ? "ひとこと欄あり" : "ひとこと欄なし", r.showResults !== false ? "集計を見せる" : "集計は見せない"].join(" ・ ")),
        h("div", { class: "poll-req-actions" },
          h("button", { class: "btn-small", onclick: approve }, "承認して公開"),
          h("button", { class: "text-btn destructive", onclick: reject }, "見送る"))));
  }), "質問や選択肢はここで直してから承認できます。承認すると全員が対象のアンケートとして公開されます（対象者はあとから変えられます）。");
}

function adminMoney({ withTitle = true } = {}) {
  const tab = segmented([{ value: "polls", label: "出欠・アンケート" }, { value: "pay", label: "集金" }, { value: "exp", label: "立て替え" }], moneyTabHint ?? "polls");
  moneyTabHint = null;
  const exp = expenseView({ admin: true });
  tab.addEventListener("change", () => scheduleRender());
  const body = h("div");

  // 新しいアンケート
  const q = h("input", { type: "text", class: "plain", placeholder: "例：8/10 のBBQに参加しますか？" });
  const opts = h("input", { type: "text", value: "参加 / 不参加 / 未定" });
  const deadline = h("input", { type: "datetime-local" });
  const showRes = toggle(true), allowCom = toggle(true), nameOpts = toggle(false), anon = toggle(false), rankT = toggle(false), noSelf = toggle(true);
  const depth = h("input", { type: "number", min: "1", inputmode: "numeric", placeholder: "全部" });
  const nameChecks = memberChecks([]);
  const nameCell = h("div", { class: "cell target-wrap" }, h("div", { class: "cell-sub" }, "選択肢にする人"), nameChecks.el);
  const noSelfCell = field("自分には投票できない", noSelf);
  const depthCell = field("何位まで付けるか", depth);
  const optsCell = field("選択肢（/ で区切る）", opts);
  const paintPollForm = () => {
    optsCell.hidden = nameOpts.checked;
    nameCell.hidden = noSelfCell.hidden = !nameOpts.checked;
    depthCell.hidden = !rankT.checked;
    if (nameOpts.checked) nameChecks.refresh();
  };
  nameOpts.addEventListener("change", () => { if (nameOpts.checked) nameChecks.set(sortedMembers().map((m) => m.id)); paintPollForm(); });
  rankT.addEventListener("change", paintPollForm);
  const pollWho = targetPicker(null);
  paintPollForm();
  const pollForm = h("form", { onsubmit: (e) => {
    e.preventDefault();
    let options, optionUids = null;
    if (nameOpts.checked) {
      // 選んだ参加者の名前を選択肢にする（同じ名前の人がいたら番号を付けて区別する）
      const picked = sortedMembers().filter((m) => nameChecks.value().includes(m.id));
      optionUids = picked.map((m) => m.id);
      options = [];
      for (const m of picked) { let n = m.name, k = 2; while (options.includes(n)) n = `${m.name}（${k++}）`; options.push(n); }
    } else options = [...new Set(opts.value.split(/[/／,、]/).map((x) => x.trim()).filter(Boolean))];
    if (!q.value.trim() || options.length < 2) return toast("質問と、選択肢を2つ以上入れてください", true);
    if (rankT.checked && nameOpts.checked && noSelf.checked && options.length < 3) return toast("「自分には投票できない」順位投票は、選択肢を3人以上にしてください", true);
    const targets = pollWho.value();
    if (targets && !targets.length) return toast("対象を1人以上選んでください", true);
    fire(addDoc(C("polls"), {
      question: q.value.trim(), options, optionUids, noSelf: nameOpts.checked && noSelf.checked,
      rank: rankT.checked, depth: rankT.checked && Math.floor(Number(depth.value)) > 0 ? Math.floor(Number(depth.value)) : null,
      deadline: deadline.value || null, open: true, showResults: showRes.checked, allowComment: allowCom.checked, anonymous: anon.checked, targets, createdAt: serverTimestamp(),
    }), "アンケートを作りました");
    q.value = ""; deadline.value = ""; pollWho.reset();
  } },
    group("新しいアンケート", [h("div", { class: "cell" }, q), optsCell, field("選択肢を参加者の名前にする", nameOpts), nameCell, noSelfCell,
      field("順位をつけて投票する", rankT), depthCell, field("締切（なしでもOK）", deadline),
      field("参加者にも集計を見せる", showRes), field("ひとことコメント欄", allowCom), field("誰が何に入れたかを出さない", anon)],
      "「参加者の名前にする」は「誰が一番〇〇？」のような投票向けで、選択肢にする人を選べます。「順位をつけて投票する」は、1人ずつ「優しいと思う順」のように順位を付けて投票し、1位＝多い点…の合計点で集計します（何位まで付けるかは空欄なら全部）。クイズの「投票当て」に使うアンケートは、答えがばれないよう「集計を見せる」をオフにしてください。「出さない」をオンにすると、管理者の画面でも点数・票数だけを表示します。"),
    group("答えてもらう人", [h("div", { class: "cell" }, pollWho.el)], "「全員」は、あとから追加した参加者も自動で対象になります。"),
    h("button", { class: "btn-filled", type: "submit" }, "アンケートを作る"));

  // 新しい集金
  const title = h("input", { type: "text", class: "plain", placeholder: "例：フェリー代" });
  const amount = h("input", { type: "number", min: "0", inputmode: "numeric", placeholder: "3000" });
  const due = h("input", { type: "date" });
  const note = h("textarea", { rows: "2", class: "plain", placeholder: "振込先・渡し方など（参加者に表示されます）" });
  const who = h("select", { class: "inline-select" });
  const payChecks = memberChecks([]);
  const payChecksCell = h("div", { class: "cell", hidden: true }, payChecks.el);
  who.addEventListener("change", () => {
    // アンケートの回答を選んだら、その回答をした人にチェックを付けた状態にする（そこから足したり外したりできる）
    if (who.value.startsWith("poll:")) {
      const [, pid, opt] = who.value.split(":");
      payChecks.set([...S.votes.values()].filter((v) => v.pollId === pid && v.choice === opt).map((v) => v.uid));
    } else if (who.value === "pick") payChecks.set([]);
    payChecksCell.hidden = who.value === "all";
  });
  const payForm = h("form", { onsubmit: (e) => {
    e.preventDefault();
    if (!title.value.trim()) return toast("名前を入れてください", true);
    let targets = null;
    if (who.value !== "all") {
      targets = payChecks.value();
      if (!targets.length) return toast("対象を1人以上選んでください", true);
    }
    fire(addDoc(C("payments"), { title: title.value.trim(), amount: Math.max(0, Number(amount.value) || 0), due: due.value || null, note: note.value.trim(), targets, records: {}, createdAt: serverTimestamp() }), "集金を作りました");
    title.value = ""; amount.value = ""; note.value = ""; who.value = "all"; payChecksCell.hidden = true;
  } },
    group("新しい集金", [h("div", { class: "cell" }, title), field("1人あたり（円）", amount), field("期限", due), h("div", { class: "cell" }, note), field("対象", who), payChecksCell],
      "「アカウントから選ぶ」でチェックした人だけが対象になります。「アンケートの回答」を選ぶと、その回答をした人にチェックが付いた状態になり、そこから足したり外したりできます。対象はあとからでも変えられます。"),
    h("button", { class: "btn-filled", type: "submit" }, "集金を作る"));

  const el = h("div", null, withTitle ? largeTitle("出欠・集金") : null, h("div", { class: "seg-wrap" }, tab), body);
  redrawOnLeave(el);

  function pollCard(p) {
    const ms = pollTargets(p);
    const votes = [...S.votes.values()].filter((v) => v.pollId === p.id && isTarget(p, v.uid));
    const none = ms.filter((m) => !votes.some((v) => v.uid === m.id));
    const setVote = (uid, choice) => fire(choice
      ? setDoc(DX("votes", `${p.id}_${uid}`), { uid, pollId: rawId(p.id), choice, comment: S.votes.get(`${p.id}_${uid}`)?.comment ?? "", at: serverTimestamp(), firstAt: firstAtOf(S.votes.get(`${p.id}_${uid}`)), byAdmin: true })
      : deleteDoc(DX("votes", `${p.id}_${uid}`)));
    return h("article", { class: "card poll-card" },
      h("div", { class: "poll-head" }, h("b", null, p.question, p.targets ? h("small", { class: "target-count" }, `対象 ${p.targets.length}人`) : null, proposedLabel(p)),
        h("span", { class: `tint${pollOpen(p) ? "" : " closed"}` }, pollOpen(p) ? (p.deadline ? `締切 ${fmtDeadline(p.deadline)}` : "受付中") : "締切済み")),
      isRankPoll(p) ? rankPollResult(p, votes, !p.anonymous) : (() => {
        const counts = p.options.map((o) => ({ o, n: votes.filter((v) => v.choice === o).length }));
        const top = Math.max(0, ...counts.map((c) => c.n));
        const lead = top ? counts.filter((c) => c.n === top).map((c) => `${c.o} ${c.n}人`).join("・") : "まだ回答なし";
        // 集計の青いバーも開け閉めできるようにする（最初は閉じる。見出しに一番多い選択肢）
        return keptFold(`pollbars:${p.id}`, `集計を見る（${votes.length}人回答・最多：${lead}）`, h("div", { class: "poll-bars" }, counts.map(({ o, n }) =>
          h("div", { class: "poll-bar" },
            h("div", { class: "poll-bar-top" }, h("span", null, o), h("b", null, `${n}人`)),
            h("div", { class: "poll-track" }, h("div", { style: `width:${ms.length ? (n / ms.length) * 100 : 0}%` }))))));
      })(),
      // 誰が何に入れたかは長くなるので折りたたむ（最初は閉じる）
      isRankPoll(p) || p.anonymous || !votes.length ? null : keptFold(`pollnames:${p.id}`, `選択肢ごとの回答者（${votes.length}人）`, h("div", { class: "poll-bars" }, p.options.map((o) => {
        const vs = votes.filter((v) => v.choice === o);
        return h("div", { class: "poll-bar" }, h("div", { class: "poll-bar-top" }, h("span", null, o), h("b", null, `${vs.length}人`)),
          vs.length ? h("div", { class: "poll-names" }, vs.map((v) => h("span", null, memberName(v.uid), v.comment ? h("small", null, `「${v.comment}」`) : null))) : h("div", { class: "cell-sub" }, "なし"));
      }))),
      !none.length ? h("div", { class: "poll-none ok" }, "全員回答しました")
        : none.length > 6 ? keptFold(`pollnone:${p.id}`, `未回答 ${none.length}人`, h("div", { class: "poll-none" }, none.map((m) => m.name).join("・")))
        : h("div", { class: "poll-none" }, h("b", null, `未回答 ${none.length}人：`), none.map((m) => m.name).join("・")),
      p.anonymous ? null : voteOrderList(p, votes),
      p.fromLobby ? h("div", { class: "cell-sub from-lobby" }, "確定前ページのアンケートです（この旅行の参加者の分だけ表示）。対象者の変更・削除は確定前ページで行ってください。") : null,
      p.anonymous ? h("div", { class: "cell-sub" }, "誰が何に入れたかは表示しません") : isRankPoll(p) ? null : keptFold(`proxy:${p.id}`, "回答を代わりに入れる・直す", h("div", { class: "group-body" }, ms.map((m) => {
        const sel = h("select", { class: "inline-select" }, h("option", { value: "" }, "未回答"), p.options.map((o) => h("option", { value: o, selected: S.votes.get(`${p.id}_${m.id}`)?.choice === o }, o)));
        sel.addEventListener("change", () => setVote(m.id, sel.value));
        return field(m.name, sel);
      }))),
      p.fromLobby ? null : targetEditor(p, "polls"),
      h("div", { class: "poll-actions" },
        h("button", { class: "text-btn", onclick: () => guard(null, () => printPollResult(p)) }, icon("table"), "結果を印刷"),
        h("button", { class: "text-btn", onclick: () => openShareImage("poll", p) }, icon("photo"), "報告用の画像"),
        h("button", { class: "text-btn", onclick: () => fire(updateDoc(DX("polls", p.id), { open: !(p.open !== false) })) }, p.open !== false ? "締め切る" : "受付を再開"),
        h("button", { class: "text-btn", onclick: () => fire(updateDoc(DX("polls", p.id), { showResults: !p.showResults })) }, p.showResults ? "集計を参加者に見せない" : "集計を参加者に見せる"),
        p.proposedBy ? h("button", { class: "text-btn", onclick: () => fire(updateDoc(DX("polls", p.id), { showProposer: p.showProposer === false }), p.showProposer === false ? "提案者の名前を公開しました" : "提案者の名前を隠しました") }, p.showProposer === false ? "提案者の名前を出す" : "提案者の名前を隠す") : null,
        p.allowComment || p.showComments || votes.some((v) => v.comment) ? h("button", { class: "text-btn", onclick: () => fire(updateDoc(DX("polls", p.id), { showComments: !p.showComments }), p.showComments ? "ひとことを非公開にしました" : "ひとことを全員に表示しました") }, p.showComments ? "ひとことを全員に見せない" : "ひとことを全員に見せる") : null,
        p.fromLobby ? null : h("button", { class: "text-btn destructive", onclick: () => {
          if (!confirm(`「${p.question}」を削除しますか？回答も消えます。`)) return;
          const b = writeBatch(db);
          b.delete(D("polls", p.id));
          votes.forEach((v) => b.delete(D("votes", v.id)));
          fire(b.commit(), "削除しました");
        } }, "削除")));
  }

  function payCard(p) {
    const t = payTotals(p);
    const filterKey = `payfilter:${p.id}`;
    const onlyUnpaid = SHOWN.get(filterKey) === 1;
    const ms = payTargets(p).filter((m) => !onlyUnpaid || recordOf(p, m.id).status === "unpaid");
    const setRec = (uid, patch) => fire(updateDoc(DX("payments", p.id), Object.fromEntries(Object.entries(patch).map(([k, v]) => [`records.${uid}.${k}`, v]))));
    return h("article", { class: "card pay-card" },
      h("div", { class: "poll-head" }, h("b", null, isExt(p.id) ? fromTag(extPid(p.id)) : null, p.title, h("small", { class: "target-count" }, p.targets ? `対象 ${p.targets.length}人` : "対象 全員")), h("span", { class: "tint" }, `${yen(p.amount)} / 人${p.due ? ` ・ 期限 ${p.due.replaceAll("-", "/")}` : ""}`)),
      p.note ? h("div", { class: "cell-sub pay-note" }, p.note) : null,
      h("div", { class: "pay-progress" },
        h("div", { class: "poll-track big" }, h("div", { style: `width:${t.expect ? (t.got / t.expect) * 100 : 0}%` })),
        h("div", { class: "pay-sum" }, h("b", null, yen(t.got)), ` / ${yen(t.expect)}`, h("span", null, `${t.paidN} / ${t.n}人 入金済み`))),
      // 対象者ごとの一覧は長くなるので開け閉めできるようにする（最初は閉じる。確認待ちの報告は上の欄にも出る）
      keptFold(`payrows:${p.id}`, `対象者ごとの入金（${t.paidN} / ${t.n}人 入金済み${pendingCount(p) ? `・確認待ち ${pendingCount(p)}件` : ""}）`, [
      h("label", { class: "pay-filter" }, (() => { const c = toggle(onlyUnpaid); c.addEventListener("change", () => { SHOWN.set(filterKey, c.checked ? 1 : 0); scheduleRender(); }); return c; })(), "未入金の人だけ表示"),
      h("div", { class: "group-body" }, ms.length ? ms.map((m) => {
        const r = recordOf(p, m.id);
        const st = segmented(Object.entries(PAY_STATUS).map(([value, label]) => ({ value, label })), r.status);
        st.classList.add(`pay-${r.status}`);
        st.addEventListener("change", () => setRec(m.id, { status: st.value, at: st.value === "paid" ? serverTimestamp() : null, method: st.value === "paid" ? r.method ?? "現金" : null }));
        const method = h("select", { class: "inline-select" }, PAY_METHODS.map((x) => h("option", { value: x, selected: r.method === x }, x)));
        method.addEventListener("change", () => setRec(m.id, { method: method.value }));
        const amt = h("input", { type: "number", class: "pay-amount", min: "0", inputmode: "numeric", value: String(amountOf(p, m.id)) });
        amt.addEventListener("change", () => setRec(m.id, { amount: Math.max(0, Number(amt.value) || 0) }));
        const rep = reportOf(p, m.id);
        const confirmPaid = () => setRec(m.id, { status: "paid", at: serverTimestamp(), method: PAY_METHODS.includes(rep?.method) ? rep.method : "その他" });
        return h("div", { class: `cell pay-row ${r.status}${rep && r.status === "unpaid" ? " reported" : ""}` },
          h("div", { class: "cell-main" }, h("b", null, m.name, isExt(p.id) && !S.members.has(m.id) ? fromTag(extPid(p.id)) : null), h("div", { class: "cell-sub" }, r.status === "paid" ? `${r.method ?? ""} ${r.at ? fmtDate(r.at) : ""}` : ""),
            rep ? h("div", { class: "pay-report" },
              h("span", { class: "pay-report-badge" }, r.status === "unpaid" ? "送金の報告あり" : "報告あり"), reportLine(rep),
              rep.image ? h("img", { src: rep.image, alt: "送金のスクリーンショット", class: "pay-shot", onclick: () => openLightbox(rep.image) }) : null,
              r.status === "unpaid" ? h("button", { class: "btn-small", onclick: confirmPaid }, "確認して入金済みにする") : null) : null),
          amt, r.status === "paid" ? method : null, st);
      }) : none(onlyUnpaid ? "未入金の人はいません" : "対象の人がいません"))]),
      isExt(p.id) ? h("div", { class: "cell-sub from-lobby" }, `${pageName(extPid(p.id))}の集金です（そのページの対象者を全員表示しています。このページにいない人には「${pageName(extPid(p.id))}より」と付けています）。入金の記録はここでも付けられます。対象者の変更・削除は${pageName(extPid(p.id))}で行ってください。`) : targetEditor(p, "payments"),
      isExt(p.id) ? null : h("div", { class: "poll-actions" },
        h("button", { class: "text-btn", onclick: () => openShareImage("pay", p) }, icon("photo"), "報告用の画像"),
        !inLobby() && S.profiles.has(LOBBY) ? h("button", { class: "text-btn", onclick: () => guard(null, () => movePaymentsToLobby([p.id])) }, "確定前ページへ移す") : null,
        h("button", { class: "text-btn destructive", onclick: () => {
          if (!confirm(`「${p.title}」を削除しますか？送金の報告も消えます。`)) return;
          const b = writeBatch(db);
          b.delete(D("payments", p.id));
          [...S.payReports.values()].filter((x) => x.paymentId === p.id).forEach((x) => b.delete(D("payReports", x.id)));
          fire(b.commit(), "削除しました");
        } }, "削除")));
  }

  // 人ごとの未入金
  function byPerson() {
    const rows = sortedMembers().map((m) => ({ m, owe: sortedPayments().filter((p) => payFor(p, m.id)).reduce((s, p) => s + (recordOf(p, m.id).status === "unpaid" ? amountOf(p, m.id) : 0), 0) }))
      .filter((r) => r.owe > 0).sort((a, b) => b.owe - a.owe);
    return keptFold("payByPerson", `人ごとの未入金（${rows.length}人）`, group(null, rows.length ? rows.map((r) => cell(r.m.name, h("b", { class: "owe" }, yen(r.owe)))) : none("未入金の人はいません")));
  }

  activeMoney = { el, show: (v) => { tab.value = v; scheduleRender(); } };
  return {
    el,
    update() {
      if (typingIn(el)) return;
      if (tab.value === "exp") {
        if (body.firstChild !== exp.el) body.replaceChildren(exp.el);
        exp.update();
      } else if (tab.value === "polls") {
        const ps = sortedPolls().filter(relevantHere);
        setKids(body, pollRequestReview(), keptFold("newPoll", "＋ 新しいアンケート", pollForm, !ps.length), ps.length ? ps.map(pollCard) : emptyState("check", "アンケートはまだありません", "「参加 / 不参加」の出欠などを取れます。"));
      } else {
        if (!payChecksCell.hidden) payChecks.refresh();
        const opts2 = [{ value: "all", label: "全員（あとから増えた人も）" }, { value: "pick", label: "アカウントから選ぶ" }, ...sortedPolls().filter((p) => !p.anonymous && !isRankPoll(p) && !p.fromLobby).flatMap((p) => p.options.map((o) => ({ value: `poll:${p.id}:${o}`, label: `「${o}」と答えた人（${p.question.slice(0, 14)}）`, group: "アンケートの回答" })))];
        fillSelect(who, opts2);
        const ps = sortedPayments().sort((a, b) => (payAllDone(a) ? 1 : 0) - (payAllDone(b) ? 1 : 0));
        const pend = pendingReports();
        const pendGroup = pend.length ? group(`確認待ちの送金報告 ${pend.length}件`, pend.map(({ p, m, rep }) => h("div", { class: "cell pay-row reported" },
          h("div", { class: "cell-main" }, h("b", null, `${m.name}：${p.title}（${yen(amountOf(p, m.id))}）`), h("div", { class: "cell-sub" }, reportLine(rep)),
            rep.image ? h("img", { src: rep.image, alt: "送金のスクリーンショット", class: "pay-shot", onclick: () => openLightbox(rep.image) }) : null),
          h("button", { class: "btn-small", onclick: () => fire(updateDoc(DX("payments", p.id), { [`records.${m.id}.status`]: "paid", [`records.${m.id}.at`]: serverTimestamp(), [`records.${m.id}.method`]: PAY_METHODS.includes(rep.method) ? rep.method : "その他" }), `${m.name} を入金済みにしました`) }, "入金済みにする"))),
          "参加者が「送金しました」を押したものです。入金を確かめてから「入金済みにする」を押してください。") : null;
        const own = ps.filter((x) => !isExt(x.id));
        const moveAll = own.length && !inLobby() && S.profiles.has(LOBBY)
          ? group(null, h("button", { class: "cell cell-button", onclick: () => guard(null, () => movePaymentsToLobby(own.map((x) => x.id))) }, icon("check"), `この旅行の集金をすべて確定前ページへ移す（${own.length}件）`),
            "入金済みなどの記録と送金の報告も一緒に移ります。移したあとは確定前ページで管理し、確定した人には旅行のページにも表示されます。")
          : null;
        setKids(body, keptFold("newPay", "＋ 新しい集金", payForm, !ps.length), ps.length ? [moveAll, pendGroup, byPerson(), ...ps.map(payCard)] : emptyState("check", "集金はまだありません", "旅費などの集金と、誰が払ったかを管理できます。"));
      }
    },
  };
}

// ---- 参加者
// ページの一番上（お知らせより上）に出すもの：受付中の出欠・アンケートと、次の集金。
// 集金：期限内（期限の日まで）はどの状態でも、期限を過ぎたら未入金（確認待ちを含む）のときだけ。
// 期限なしは未入金のときだけ
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const payPinned = (p, uid) => (recordOf(p, uid).status === "unpaid") || (!!p.due && localToday() <= p.due);

// pinned: "split" … 上に出す集金は top（ページの一番上に置く欄）に、残りはこの欄に出す（スマホ）
//         "only"  … 上に出す集金だけを top に出す（PC の画面上部）
//         "none"  … すべてこの欄に出す（PC の「出欠・集金」の小窓）
function memberMoney({ compact = false, pinned = "none" } = {}) {
  const body = h("div");
  const el = h("div", null, sectionTitle("出欠・集金", compact), body);
  const top = h("div", { class: "pay-top", id: "pay-top" });
  redrawOnLeave(top);
  const drafts = new Map(); // pollId -> コメント入力欄
  const exp = expenseView();
  const expGroup = h("section", { class: "expense-section" }, h("h3", { class: "sub-title" }, "立て替えの精算"), exp.el);
  const req = pinned === "only" ? null : pollRequestBox();
  redrawOnLeave(el);
  // 「送金しました」の入力欄（集金ごとに作って使い回す。描き直しても選んだ画像や入力が消えないように）
  const forms = new Map();
  function reportBox(p, rep) {
    const uid = S.user.uid;
    if (rep) {
      return h("div", { class: "pay-report mine" },
        h("span", { class: "pay-report-badge" }, "送金しましたと報告済み"), reportLine(rep),
        rep.image ? h("img", { src: rep.image, alt: "", class: "pay-shot", onclick: () => openLightbox(rep.image) }) : null,
        h("button", { class: "text-btn", onclick: () => { if (confirm("報告を取り消しますか？")) fire(deleteDoc(DX("payReports", rep.id)), "取り消しました"); } }, "取り消す"));
    }
    let f = forms.get(p.id);
    if (!f) {
      const method = h("select", { class: "inline-select" }, PAY_METHODS.map((x) => h("option", { value: x }, x)));
      const note = h("input", { type: "text", placeholder: "メモ（任意）例：10/13 に PayPay で送りました", maxlength: "80" });
      const file = h("input", { type: "file", accept: "image/*", hidden: true });
      const preview = h("div", { class: "pay-preview" });
      const pick = h("label", { class: "pill" }, icon("photo"), "スクショを付ける（任意）", file);
      const send = h("button", { class: "btn-small" }, "報告する");
      f = { open: false, image: null, method, note, file, preview, pick, send };
      const paintPreview = () => setKids(preview, f.image ? [h("img", { src: f.image, alt: "", class: "pay-shot" }), h("button", { class: "text-btn", onclick: () => { f.image = null; paintPreview(); } }, "外す")] : null);
      file.addEventListener("change", () => guard(null, async () => {
        const fl = file.files?.[0];
        file.value = "";
        if (!fl) return;
        f.image = await compressImage(fl);
        paintPreview();
      }));
      // 電波が弱くても待たせない（送信予約にして、電波が戻ったら自動で送られる）
      send.addEventListener("click", () => {
        fire(setDoc(DX("payReports", `${p.id}_${uid}`), { uid, paymentId: rawId(p.id), method: method.value, note: note.value.trim(), image: f.image, at: serverTimestamp() }),
          "送金を報告しました。管理者の確認を待ってください");
        f.open = false; f.image = null; note.value = ""; paintPreview();
        scheduleRender();
      });
      f.box = h("div", { class: "pay-form" }, field("払い方", method), h("div", { class: "pay-note-input" }, note), h("div", { class: "pay-pick" }, pick, preview),
        h("div", { class: "pay-form-actions" }, h("button", { class: "text-btn", onclick: () => { f.open = false; scheduleRender(); } }, "やめる"), send));
      forms.set(p.id, f);
    }
    return f.open ? f.box : h("button", { class: "btn-small pay-sent-btn", onclick: () => { f.open = true; scheduleRender(); } }, icon("check"), "送金しました");
  }
  return {
    el, top,
    update() {
      if (typingIn(el) || typingIn(top)) return;
      const uid = S.user.uid;
      const polls = sortedPolls().filter((p) => isTarget(p, uid));
      const allPays = sortedPayments().filter((p) => payFor(p, uid));
      const topPays = pinned === "none" ? [] : allPays.filter((p) => payPinned(p, uid))
        // 未入金を先に、その中は期限の近い順
        .sort((a, b) => (recordOf(a, uid).status === "unpaid" ? 0 : 1) - (recordOf(b, uid).status === "unpaid" ? 0 : 1) || (a.due || "9999").localeCompare(b.due || "9999"));
      const pays = allPays.filter((p) => !topPays.includes(p));
      // 受付中（締切前）の出欠・アンケートも一番上に出す。未回答を先に
      // 並び順：未回答（受付中）→ 回答済み（受付中）→ 締切済み。同じ中では新しい順
      const pollRank = (p) => (!pollOpen(p) ? 2 : S.votes.has(`${p.id}_${uid}`) ? 1 : 0);
      polls.sort((a, b) => pollRank(a) - pollRank(b));
      const topPolls = pinned === "none" ? [] : polls.filter(pollOpen);
      const restPolls = polls.filter((p) => !topPolls.includes(p));
      const pollEl = (p) => {
        const mine = S.votes.get(`${p.id}_${uid}`);
        const open = pollOpen(p);
        let com = drafts.get(p.id);
        if (!com) { com = editableInput({ placeholder: "ひとこと（任意）", maxlength: "60" }); drafts.set(p.id, com); }
        com.sync(mine?.comment ?? "");
        const rank = isRankPoll(p);
        const vote = (choice) => fire(setDoc(DX("votes", `${p.id}_${uid}`), rank
          ? { uid, pollId: rawId(p.id), choice: choice[0], order: choice, comment: com.value.trim(), at: serverTimestamp(), firstAt: firstAtOf(mine) }
          : { uid, pollId: rawId(p.id), choice, comment: com.value.trim(), at: serverTimestamp(), firstAt: firstAtOf(mine) }), "回答しました");
        const tally = S.pollTally.get(p.id) ?? [];
        const res = !p.showResults ? null : rank ? rankPollResult(p, tally, false)
          : h("div", { class: "poll-mini" }, p.options.map((o) => h("span", null, o, h("b", null, tally.filter((v) => v.choice === o).length))));
        return h("article", { class: `card poll-card${!mine && open ? " todo" : ""}` },
          h("div", { class: "poll-head" }, h("b", null, p.question, proposedLabel(p)), h("span", { class: `tint${open ? "" : " closed"}` }, open ? (p.deadline ? `締切 ${fmtDeadline(p.deadline)}` : "受付中") : "締切済み")),
          rank ? rankPicker(p, mine, open, vote)
            : h("div", { class: "poll-choices" }, p.options.map((o) => h("button", { class: `poll-choice${mine?.choice === o ? " on" : ""}`, disabled: !open, onclick: () => vote(o) }, mine?.choice === o ? icon("check") : null, o))),
          p.allowComment && open ? h("div", { class: "poll-comment" }, com, mine ? h("button", { class: "text-btn", onclick: () => { com.saved(); vote(rank ? mine.order ?? [mine.choice] : mine.choice); } }, "コメントを送る") : null) : null,
          h("div", { class: "cell-sub" }, mine ? `あなたの回答：${rank ? (mine.order ?? []).map((o, i) => `${i + 1}位 ${o}`).join("・") : mine.choice}${mine.byAdmin ? "（管理者が入力）" : ""}${open ? "（締切まで変えられます）" : ""}` : open ? "まだ回答していません" : "回答していません"),
          res,
          p.showComments ? pollComments(p, S.pollTally.get(p.id) ?? []) : null);
      };
      const payEl = (p) => {
        const r = recordOf(p, uid);
        const rep = reportOf(p, uid);
        const badge = r.status === "paid" ? "入金済み ✓" : r.status === "exempt" ? PAY_STATUS.exempt : rep ? "確認待ち" : PAY_STATUS.unpaid;
        return h("div", { class: `cell pay-mine ${r.status}${rep && r.status === "unpaid" ? " reported" : ""}` },
          h("div", { class: "cell-main" }, h("b", null, isExt(p.id) ? fromTag(extPid(p.id)) : null, p.title), h("div", { class: "cell-sub" }, [p.due ? `期限 ${p.due.replaceAll("-", "/")}` : null, p.note].filter(Boolean).join(" ・ ")),
            r.status === "unpaid" ? reportBox(p, rep) : null),
          h("div", { class: "pay-right" }, h("b", null, yen(amountOf(p, uid))), h("span", { class: `pay-badge ${r.status}${rep && r.status === "unpaid" ? " wait" : ""}` }, badge)));
      };
      const owe = myUnpaid(uid);
      const payHelp = "送金したら「送金しました」を押してください（スクリーンショットも付けられます）。管理者が確認すると「入金済み」になります。";
      setKids(top,
        topPolls.length ? h("div", { class: "stack" }, topPolls.map(pollEl)) : null,
        topPays.length ? group(`集金${owe ? `（未入金 ${yen(owe)}）` : ""}`, topPays.map(payEl), payHelp) : null);
      if (pinned === "only") return;
      req.update();
      setKids(body,
        req.el,
        restPolls.length ? h("div", { class: "stack" }, restPolls.map(pollEl)) : null,
        pays.length ? group(topPays.length ? "そのほかの集金" : `集金${owe ? `（未入金 ${yen(owe)}）` : "（すべて入金済み）"}`, pays.map(payEl), topPays.length ? null : payHelp) : null,
        expGroup);
      exp.update();
    },
  };
}

// 集計を見せるアンケートの回答（参加者用）。votes を全部は読まず、集計を見せるアンケートの分だけ読む
function syncPollTally() {
  if (S.isAdmin) return;
  const want = new Set(sortedPolls().filter((p) => p.showResults || p.showComments).map((p) => p.id));
  for (const id of [...S.pollTally.keys()]) if (!want.has(id)) { unlisten(`tally:${id}`); S.pollTally.delete(id); TALLY_ONCE.delete(id); }
  const tallyOf = (s) => [...toMap(s).values()].map((v) => ({ choice: v.choice, order: v.order ?? null, uid: v.uid, comment: v.comment ?? "", at: v.firstAt ?? v.at ?? null }));
  for (const id of want) {
    const q = query(CX("votes", id), where("pollId", "==", rawId(id)));
    const p = S.polls.get(id);
    // 受付中の分だけ常に受信する。締め切った分は結果が変わらないので1回読むだけ（出欠が増えても受信し続ける数が増えない）
    if (p && pollOpen(p)) { TALLY_ONCE.delete(id); listen(`tally:${id}`, q, (s) => { if (s) S.pollTally.set(id, tallyOf(s)); }); continue; }
    if (subs.has(`tally:${id}`)) unlisten(`tally:${id}`);
    if (TALLY_ONCE.has(id)) continue;
    TALLY_ONCE.add(id);
    const pid = S.pid;
    getDocs(q).then((s) => {
      if (S.pid !== pid || !TALLY_ONCE.has(id)) return;
      S.pollTally.set(id, tallyOf(s));
      DATA_VER++;
      scheduleRender();
    }).catch(() => TALLY_ONCE.delete(id));
  }
}
const TALLY_ONCE = new Set();

// ---------------------------------------------------------------- チェックリスト（持ち物・片付けなど）
//
//   checklists/{id}  { title, order, items: [{ id, text, kind: "each" | "shared", assignee: uid | null }], createdAt }
//                    … セクション（例：持ち物、片付け）。作れるのは管理者
//     each   ：全員が各自でチェックする（例：寝袋）
//     shared ：誰か1人がやればよい（例：テント、ゴミ袋）。担当者を決めておける
//   checks/{listId}_{itemId}_{uid}     { uid, listId, itemId, shared: false, at }   … 各自のチェック
//   checks/{listId}_{itemId}_shared    { uid, listId, itemId, shared: true, at }    … 共有のチェック（チェックした人が uid）

const sortedChecklists = () => [...S.checklists.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || ts(a.createdAt) - ts(b.createdAt));
const checkId = (l, it, uid) => `${l.id}_${it.id}_${it.kind === "shared" ? "shared" : uid}`;
const isChecked = (l, it, uid) => S.checks.has(checkId(l, it, uid));
function toggleCheck(l, it, on) {
  const uid = S.user.uid;
  const id = checkId(l, it, uid);
  fire(on ? setDoc(D("checks", id), { uid, listId: l.id, itemId: it.id, shared: it.kind === "shared", at: serverTimestamp() }) : deleteDoc(D("checks", id)));
}
// 自分がやること（各自の項目＋自分が担当の共有項目）の進み具合
function myCheckProgress(l, uid) {
  const items = l.items.filter((it) => it.kind !== "shared" || !it.assignee || it.assignee === uid);
  return { done: items.filter((it) => isChecked(l, it, uid)).length, total: items.length };
}

function checklistAdmin({ withTitle = true } = {}) {
  const el = h("div", { class: "checklists" });
  const newTitle = h("input", { type: "text", class: "plain", placeholder: "例：持ち物 / 片付け / 出発前", maxlength: "30" });
  const addSection = h("form", { class: "cl-add-section", onsubmit: (e) => {
    e.preventDefault();
    if (!newTitle.value.trim()) return;
    fire(addDoc(C("checklists"), { title: newTitle.value.trim(), order: Date.now(), items: [], createdAt: serverTimestamp() }), "セクションを作りました");
    newTitle.value = "";
  } }, h("div", { class: "group-body" }, h("div", { class: "cell" }, newTitle), h("button", { class: "cell cell-button", type: "submit" }, icon("plus"), "セクションを追加")));
  const body = h("div");
  el.append(withTitle ? largeTitle("チェックリスト") : null, body, group(null, addSection, "持ち物・片付け・出発前の確認など、セクションはいくつでも作れます。"));
  redrawOnLeave(el);
  const forms = new Map(); // セクションごとの「項目を追加」欄（描き直しても入力が消えないように使い回す）

  function addForm(l) {
    let f = forms.get(l.id);
    if (f) { fillSelect(f.assignee, [{ value: "", label: "担当なし（誰でも）" }, ...sortedMembers().map((m) => ({ value: m.id, label: m.name }))]); return f.el; }
    const text = h("input", { type: "text", class: "plain", placeholder: "項目（例：寝袋）", maxlength: "40" });
    const kind = segmented([{ value: "each", label: "各自" }, { value: "shared", label: "共有（誰か1人）" }], "each");
    const assignee = h("select", { class: "inline-select" });
    const aCell = field("担当", assignee);
    const paintKind = () => { aCell.hidden = kind.value !== "shared"; };
    kind.addEventListener("change", paintKind);
    const form = h("form", { class: "cl-add", onsubmit: (e) => {
      e.preventDefault();
      if (!text.value.trim()) return;
      const cur = S.checklists.get(l.id);
      const item = { id: Math.random().toString(36).slice(2, 10), text: text.value.trim(), kind: kind.value, assignee: kind.value === "shared" ? assignee.value || null : null };
      fire(updateDoc(D("checklists", l.id), { items: [...(cur?.items ?? []), item] }));
      text.value = "";
      text.focus();
    } }, h("div", { class: "cell" }, text), h("div", { class: "cell" }, kind), aCell, h("button", { class: "cell cell-button", type: "submit" }, icon("plus"), "項目を追加"));
    paintKind();
    f = { el: form, assignee };
    forms.set(l.id, f);
    fillSelect(assignee, [{ value: "", label: "担当なし（誰でも）" }, ...sortedMembers().map((m) => ({ value: m.id, label: m.name }))]);
    return form;
  }

  function sectionCard(l) {
    const ms = sortedMembers();
    const saveItems = (items) => fire(updateDoc(D("checklists", l.id), { items }));
    const rows = l.items.map((it, i) => {
      let status;
      if (it.kind === "shared") {
        const c = S.checks.get(checkId(l, it, ""));
        status = h("span", { class: `cl-stat${c ? " ok" : ""}` }, c ? `✓ ${memberName(c.uid)}` : "まだ");
      } else {
        const done = ms.filter((m) => isChecked(l, it, m.id));
        const not = ms.filter((m) => !isChecked(l, it, m.id));
        status = h("span", { class: `cl-stat${not.length ? "" : " ok"}`, title: not.length ? `まだ：${not.map((m) => m.name).join("・")}` : "全員チェック済み" }, `${done.length}/${ms.length}`);
      }
      const move = (d) => { const j = i + d; if (j < 0 || j >= l.items.length) return; const a = [...l.items]; [a[i], a[j]] = [a[j], a[i]]; saveItems(a); };
      const notYet = it.kind === "each" ? ms.filter((m) => !isChecked(l, it, m.id)) : [];
      return h("div", { class: "cell cl-row" },
        h("div", { class: "cell-main" }, h("b", null, it.text),
          h("div", { class: "cell-sub" }, it.kind === "shared" ? `共有${it.assignee ? `・担当：${memberName(it.assignee)}` : "・誰でも"}` : notYet.length && notYet.length < ms.length ? `まだ：${notYet.map((m) => m.name).join("・")}` : "各自")),
        status,
        h("button", { class: "icon-btn", title: "上へ", onclick: () => move(-1) }, "↑"),
        h("button", { class: "icon-btn", title: "下へ", onclick: () => move(1) }, "↓"),
        h("button", { class: "icon-btn", title: "削除", onclick: () => { if (confirm(`「${it.text}」を削除しますか？`)) saveItems(l.items.filter((x) => x.id !== it.id)); } }, icon("xmark")));
    });
    const titleIn = editableInput({ class: "plain cl-title", "aria-label": "セクション名" });
    titleIn.sync(l.title);
    return h("article", { class: "card cl-card" },
      h("div", { class: "cl-head" }, titleIn,
        h("button", { class: "text-btn", onclick: () => { fire(updateDoc(D("checklists", l.id), { title: titleIn.value.trim() || l.title }), "名前を保存しました"); titleIn.saved(); } }, "名前を保存"),
        h("button", { class: "text-btn destructive", onclick: () => {
          if (!confirm(`セクション「${l.title}」を削除しますか？チェックの記録も消えます。`)) return;
          const b = writeBatch(db);
          b.delete(D("checklists", l.id));
          [...S.checks.values()].filter((c) => c.listId === l.id).forEach((c) => b.delete(D("checks", c.id)));
          fire(b.commit(), "削除しました");
        } }, "削除")),
      h("div", { class: "group-body" }, rows.length ? rows : none("まだ項目がありません")),
      keptFold(`cladd:${l.id}`, "＋ 項目を追加", addForm(l), !l.items.length));
  }
  return {
    el,
    update() {
      // 「項目を追加」欄は使い回すので、続けて入力している最中でも描き直す（足した項目がすぐ一覧に出るように）。終わったら入力欄に戻す
      const act = el.contains(document.activeElement) ? document.activeElement : null;
      const inAdd = act?.closest(".cl-add, .cl-add-section");
      if (typingIn(el) && !inAdd) return;
      const ls = sortedChecklists();
      setKids(body, ls.length ? ls.map(sectionCard) : emptyState("check", "まだセクションがありません", "下の「セクションを追加」から、持ち物・片付けなどのリストを作れます。"));
      if (inAdd && act.isConnected && document.activeElement !== act) act.focus({ preventScroll: true });
    },
  };
}

function checklistMember({ compact = false } = {}) {
  const body = h("div");
  const el = h("div", null, sectionTitle("チェックリスト", compact), body);
  return {
    el,
    update() {
      const uid = S.user.uid;
      const ls = sortedChecklists();
      setKids(body, ls.length ? ls.map((l) => {
        const p = myCheckProgress(l, uid);
        return h("article", { class: "card cl-card" },
          h("div", { class: "cl-head" }, h("b", { class: "cl-title" }, l.title), h("span", { class: `cl-stat${p.total && p.done === p.total ? " ok" : ""}` }, `${p.done}/${p.total}`)),
          h("div", { class: "poll-track" }, h("div", { style: `width:${p.total ? (p.done / p.total) * 100 : 0}%` })),
          h("div", { class: "cl-items" }, l.items.map((it) => {
            const on = isChecked(l, it, uid);
            const c = it.kind === "shared" ? S.checks.get(checkId(l, it, uid)) : null;
            // 共有の項目を他の人がチェックしたときは、その人（か管理者）しか外せない
            const cb = h("input", { type: "checkbox", checked: on, disabled: !!(c && c.uid !== uid) });
            cb.addEventListener("change", () => toggleCheck(l, it, cb.checked));
            const mineToDo = it.kind !== "shared" || !it.assignee || it.assignee === uid;
            return h("label", { class: `cl-item${on ? " on" : ""}${mineToDo ? "" : " other"}` }, cb,
              h("span", { class: "cl-text" }, it.text,
                it.kind === "shared" ? h("small", null, c ? `${memberName(c.uid)} がチェック` : it.assignee ? `担当：${it.assignee === uid ? "あなた" : memberName(it.assignee)}` : "誰か1人でOK") : null));
          })));
      }) : emptyState("check", "まだありません", "持ち物や片付けのチェックリストがあるとここに表示されます。"));
    },
  };
}

// ---------------------------------------------------------------- 立て替えの精算
//
//   expenses/{自動}  { uid(登録した人), kind: "expense", payer, title, amount, split: [uid] | null(=全員), createdAt }
//                    { uid, kind: "settle", from, to, amount, createdAt }   … 「払った」の記録（精算が進むと残りが減る）
//   参加者は「uid が自分」のものだけ書ける（自分が立て替えた分・自分が払った記録）。管理者は誰の分でも登録・削除できる。
//
// 精算の計算：各人の「立て替えた額 − 負担する額（割り勘）」を出し、払う人と受け取る人を大きい順に組み合わせる。
// この方法だと、やり取りの回数は最大でも（人数 − 1）回になる。

const sortedExpenses = () => [...S.expenses.values()].sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
const splitOf = (e) => (e.split?.length ? e.split : sortedMembers().map((m) => m.id));

// 1件の割り勘：1円単位で、端数は先頭の人から1円ずつ多く負担する
function shares(e, all) {
  const ids = e.split?.length ? e.split : all ?? splitOf(e);
  const n = ids.length || 1;
  const base = Math.floor(e.amount / n), rest = e.amount - base * n;
  return new Map(ids.map((id, i) => [id, base + (i < rest ? 1 : 0)]));
}

// 各人の差し引き（＋なら受け取る側、−なら払う側）。データが変わったときだけ計算し直す
function balancesOf(expenses, all) {
  const bal = new Map(all.map((id) => [id, 0]));
  const add = (id, v) => bal.set(id, (bal.get(id) ?? 0) + v);
  for (const e of expenses) {
    if (e.kind === "settle") { add(e.from, e.amount); add(e.to, -e.amount); continue; }
    add(e.payer, e.amount);
    for (const [id, v] of shares(e, all)) add(id, -v);
  }
  return bal;
}
const balancesMemo = memo(() => balancesOf(S.expenses.values(), sortedMembers().map((m) => m.id)));
const balances = () => new Map(balancesMemo());
// ほかのページの立て替え（精算が済んだページも含む） [{ pid, st }]
const extSettlements = memo(() => [...S.extExpenses].flatMap(([pid, exps]) => {
  const ms = pageMembers(pid);
  if (!ms || !exps.size) return [];
  const st = settleOf(balancesOf(exps.values(), ms.map((m) => m.id)));
  return [{ pid, st }]; // 精算が済んだページも残す（「すべて精算済み」と出す）
}));

// 誰が誰にいくら払えばよいか
function settlements() { return settleOf(balances()); }
function settleOf(balMap) {
  const bal = [...balMap].filter(([, v]) => v !== 0);
  const pay = bal.filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v })).sort((a, b) => b.v - a.v);
  const get = bal.filter(([, v]) => v > 0).map(([id, v]) => ({ id, v })).sort((a, b) => b.v - a.v);
  const out = [];
  let i = 0, j = 0;
  while (i < pay.length && j < get.length) {
    const x = Math.min(pay[i].v, get[j].v);
    if (x > 0) out.push({ from: pay[i].id, to: get[j].id, amount: x });
    pay[i].v -= x; get[j].v -= x;
    if (!pay[i].v) i++;
    if (!get[j].v) j++;
  }
  return out;
}

function expenseView({ admin = false } = {}) {
  const el = h("div", { class: "expense" });
  const title = h("input", { type: "text", class: "plain", placeholder: "例：食材（スーパー）", maxlength: "40" });
  const amount = h("input", { type: "number", min: "1", inputmode: "numeric", placeholder: "5400" });
  const payer = h("select", { class: "inline-select" });
  const who = targetPicker(null);
  const form = h("form", { onsubmit: (e) => {
    e.preventDefault();
    const amt = Math.floor(Number(amount.value) || 0);
    if (!title.value.trim() || amt <= 0) return toast("内容と金額を入れてください", true);
    const split = who.value();
    if (split && !split.length) return toast("割る人を1人以上選んでください", true);
    const pid = admin ? payer.value : S.user.uid;
    if (!pid) return toast("立て替えた人を選んでください", true);
    fire(addDoc(C("expenses"), { uid: admin ? S.user.uid : pid, kind: "expense", payer: pid, title: title.value.trim(), amount: amt, split, createdAt: serverTimestamp() }), "登録しました");
    title.value = ""; amount.value = ""; who.reset();
  } },
    group("立て替えを登録", [h("div", { class: "cell" }, title), field("金額（円）", amount), admin ? field("立て替えた人", payer) : null,
      h("div", { class: "cell" }, h("div", { class: "target-wrap" }, h("div", { class: "cell-sub" }, "割る人"), who.el))],
      admin ? "参加者の代わりに登録できます。" : "自分が立て替えた分を登録します。「割る人」で選んだ人で同じ額ずつ負担します（1円の端数は最初の人から）。"),
    h("button", { class: "btn-filled", type: "submit" }, "登録する"));
  const result = h("div");
  const list = h("div");
  el.append(keptFold(`newExpense:${admin}`, "＋ 立て替えを登録", form, !S.expenses.size), result, list);
  redrawOnLeave(el);
  return {
    el,
    update() {
      if (typingIn(el)) return;
      fillSelect(payer, sortedMembers().map((m) => ({ value: m.id, label: m.name })), "選択");
      who.refresh();
      const uid = S.user.uid;
      const st = settlements();
      const mine = st.filter((t) => t.from === uid || t.to === uid);
      const bal = balances();
      const settleBtn = (t) => (admin || t.from === uid) ? h("button", { class: "btn-small", onclick: () => {
        if (!confirm(`${memberName(t.from)} → ${memberName(t.to)} に ${yen(t.amount)} 払ったことにしますか？`)) return;
        fire(addDoc(C("expenses"), { uid: admin ? uid : t.from, kind: "settle", from: t.from, to: t.to, amount: t.amount, createdAt: serverTimestamp() }), "記録しました");
      } }, "払った") : null;
      setKids(result,
        !admin && st.length ? group("あなたの精算", mine.length ? mine.map((t) => h("div", { class: "cell settle-row" },
          h("div", { class: "cell-main" }, t.from === uid ? h("b", null, `${memberName(t.to)} に払う`) : h("b", null, `${memberName(t.from)} から受け取る`)),
          h("b", { class: t.from === uid ? "owe" : "get" }, yen(t.amount)), t.from === uid ? settleBtn(t) : null)) : cell("精算はありません（差し引きゼロ）"),
          "払ったら「払った」を押してください。受け取る側の人が押す必要はありません。") : null,
        group(`精算（${st.length ? `${st.length}回のやり取りで完了` : "すべて精算済み"}）`, st.length ? st.map((t) => h("div", { class: "cell settle-row" },
          h("div", { class: "cell-main" }, h("b", null, `${memberName(t.from)} → ${memberName(t.to)}`)), h("b", null, yen(t.amount)), settleBtn(t))) : cell("精算するものはありません"),
          "支払いの回数ができるだけ少なくなるように組み合わせています。"),
        admin ? keptFold("expBalance", "人ごとの差し引き", group(null, sortedMembers().map((m) => cell(m.name, h("b", { class: (bal.get(m.id) ?? 0) < 0 ? "owe" : (bal.get(m.id) ?? 0) > 0 ? "get" : "" }, `${(bal.get(m.id) ?? 0) > 0 ? "+" : (bal.get(m.id) ?? 0) < 0 ? "−" : ""}${yen(Math.abs(bal.get(m.id) ?? 0))}`))), "＋は受け取る額、−は払う額です。")) : null);
      // ほかのページの立て替え（精算が残っている間だけ）。参加者は自分が関わる分だけ
      const extGroups = extSettlements().map(({ pid, st: xs }) => {
        const shown = admin ? xs : xs.filter((t) => t.from === uid || t.to === uid);
        const pay = (t) => (admin || t.from === uid) ? h("button", { class: "btn-small", onclick: () => {
          if (!confirm(`${pageName(pid)}の精算：${memberName(t.from)} → ${memberName(t.to)} に ${yen(t.amount)} 払ったことにしますか？`)) return;
          fire(addDoc(collection(db, ...pageBase(pid), "expenses"), { uid: admin ? uid : t.from, kind: "settle", from: t.from, to: t.to, amount: t.amount, createdAt: serverTimestamp() }), "記録しました");
        } }, "払った") : null;
        return h("section", { class: "group" }, h("div", { class: "group-header" }, fromTag(pid), xs.length ? `立て替えの精算（残り ${xs.length}件）` : "立て替えの精算（すべて精算済み）"),
          h("div", { class: "group-body" }, !shown.length ? cell(h("span", { class: "secondary" }, xs.length ? "あなたの精算はありません" : "すべて精算済みです")) : shown.map((t) => h("div", { class: "cell settle-row" },
            h("div", { class: "cell-main" }, h("b", null, admin ? `${memberName(t.from)} → ${memberName(t.to)}` : t.from === uid ? `${memberName(t.to)} に払う` : `${memberName(t.from)} から受け取る`)),
            h("b", { class: admin ? "" : t.from === uid ? "owe" : "get" }, yen(t.amount)), pay(t)))),
          h("div", { class: "group-footer" }, `${pageName(pid)}で登録した立て替えです。`));
      });
      result.append(...extGroups.filter(Boolean));
      const items = sortedExpenses();
      setKids(list, items.length ? keptFold(`expRecords:${admin}`, `記録（${items.length}件）`, group(null, items.map((e) => {
        const canDel = admin || e.uid === uid;
        const del = canDel ? h("button", { class: "text-btn destructive", onclick: () => { if (confirm("この記録を削除しますか？")) fire(deleteDoc(D("expenses", e.id)), "削除しました"); } }, "削除") : null;
        if (e.kind === "settle") return h("div", { class: "cell settle-row done" }, h("div", { class: "cell-main" }, h("span", null, `${memberName(e.from)} → ${memberName(e.to)} 支払い済み`), h("div", { class: "cell-sub" }, fmtDate(e.createdAt))), h("span", null, yen(e.amount)), del);
        const sp = splitOf(e);
        return h("div", { class: "cell" }, h("div", { class: "cell-main" }, h("b", null, e.title),
          h("div", { class: "cell-sub" }, `${memberName(e.payer)} が立て替え ・ ${e.split?.length ? `${sp.length}人で割る（${sp.map(memberName).join("・")}）` : `全員（${sp.length}人）で割る`} ・ 1人 約${yen(Math.round(e.amount / (sp.length || 1)))}`)),
          h("b", null, yen(e.amount)), del);
      }))) : emptyState("check", "まだありません", "誰かが立て替えたら、ここに登録すると最後にまとめて精算できます。"));
    },
  };
}

// ---------------------------------------------------------------- 過去動画（確定前ページ）
//
//   profiles/lobby/videos/{自動}  { title, url, videoId, note, visible, order, createdAt }
//   限定公開の YouTube のリンクを管理者が登録する。参加者には visible の分だけ出す（押すと YouTube で開く）

// YouTube の URL から動画の ID を取り出す（youtu.be / watch?v= / shorts / live / embed）
function youtubeId(url) {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    let id = null;
    if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      id = u.searchParams.get("v") ?? u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/)?.[1] ?? null;
    }
    return id && /^[\w-]{6,20}$/.test(id) ? id : null;
  } catch { return null; }
}
const sortedVideos = () => [...S.videos.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || ts(b.createdAt) - ts(a.createdAt));
const videoThumb = (v) => h("span", { class: "video-thumb" },
  v.videoId ? h("img", { src: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`, alt: "", loading: "lazy" }) : null, icon("play", "video-play"));
const videoLink = (v, inner) => h("a", { class: "video-link", href: v.url, target: "_blank", rel: "noopener noreferrer" }, inner);

function memberVideos({ compact = false } = {}) {
  const list = h("div", { class: "video-list" });
  const el = h("div", null, sectionTitle("過去動画", compact), list);
  return {
    el,
    update() {
      const vs = sortedVideos().filter((v) => v.visible);
      setKids(list, vs.length ? vs.map((v) => videoLink(v, [videoThumb(v),
        h("span", { class: "video-text" }, h("b", null, v.title), v.note ? h("small", null, v.note) : null)]))
        : emptyState("play", "まだありません", "過去の旅行の動画が公開されるとここに表示されます。"));
    },
  };
}

function adminVideos({ withTitle = true } = {}) {
  const title = h("input", { type: "text", class: "plain", placeholder: "例：2025 夏 沖縄旅行", maxlength: "60" });
  const url = h("input", { type: "url", class: "plain", placeholder: "https://youtu.be/…（限定公開のリンク）", autocapitalize: "none", autocorrect: "off" });
  const note = h("input", { type: "text", class: "plain", placeholder: "ひとこと（任意）", maxlength: "80" });
  const form = h("form", { onsubmit: (e) => {
    e.preventDefault();
    const id = youtubeId(url.value);
    if (!id) return toast("YouTube のリンクを貼ってください（youtu.be/… や youtube.com/watch?v=…）", true);
    const order = Math.min(0, ...sortedVideos().map((v) => v.order ?? 0)) - 1; // 新しいものを一番上に
    fire(addDoc(C("videos"), { title: title.value.trim() || "過去動画", url: url.value.trim(), videoId: id, note: note.value.trim(), visible: true, order, createdAt: serverTimestamp() }), "追加しました");
    title.value = url.value = note.value = "";
  } },
    group("動画を追加", [h("div", { class: "cell" }, title), h("div", { class: "cell" }, url), h("div", { class: "cell" }, note)],
      "YouTube の「共有」でコピーしたリンクを貼ってください。限定公開の動画は、リンクを知っている人だけが見られます（このページの参加者にはリンクが見えます）。"),
    h("button", { class: "btn-filled", type: "submit" }, "追加する"));
  const list = h("div");
  const el = h("div", null, withTitle ? largeTitle("過去動画") : null, keptFold("newVideo", "＋ 動画を追加", form, !S.videos.size), list);
  redrawOnLeave(el);
  const move = (vs, i, d) => {
    const a = vs[i], b = vs[i + d];
    if (!a || !b) return;
    const b2 = writeBatch(db);
    // 並び順を振り直してから入れ替える（同じ order が並んでいても動くように）
    vs.forEach((v, k) => b2.update(D("videos", v.id), { order: k === i ? i + d : k === i + d ? i : k }));
    fire(b2.commit());
  };
  return {
    el,
    update() {
      if (typingIn(el)) return;
      const vs = sortedVideos();
      setKids(list, vs.length ? group(`登録済み（${vs.length}本・表示中 ${vs.filter((v) => v.visible).length}本）`, vs.map((v, i) => {
        const vis = toggle(!!v.visible);
        vis.addEventListener("change", () => fire(updateDoc(D("videos", v.id), { visible: vis.checked }), vis.checked ? "表示にしました" : "非表示にしました"));
        return h("div", { class: `cell video-admin${v.visible ? "" : " hidden-video"}` },
          videoLink(v, videoThumb(v)),
          h("div", { class: "cell-main" }, h("b", null, v.title), h("div", { class: "cell-sub" }, v.note || v.url),
            h("div", { class: "video-actions" },
              h("label", { class: "video-vis" }, vis, v.visible ? "表示中" : "非表示"),
              h("button", { class: "text-btn", disabled: i === 0, onclick: () => move(vs, i, -1) }, "↑"),
              h("button", { class: "text-btn", disabled: i === vs.length - 1, onclick: () => move(vs, i, 1) }, "↓"),
              h("button", { class: "text-btn", onclick: () => {
                const t = prompt("動画の名前", v.title);
                if (t != null && t.trim()) fire(updateDoc(D("videos", v.id), { title: t.trim() }), "変更しました");
              } }, "名前"),
              h("button", { class: "text-btn destructive", onclick: () => { if (confirm(`「${v.title}」を削除しますか？`)) fire(deleteDoc(D("videos", v.id)), "削除しました"); } }, "削除"))));
      }), "非表示にした動画は参加者に出ません。↑↓で並び順を変えられます。") : emptyState("play", "まだありません", "「＋ 動画を追加」から YouTube のリンクを登録できます。"));
    },
  };
}

// ---------------------------------------------------------------- チャット
//
//   messages/{自動}  { uid(送った人), chat, text, at, parties: [uid, uid] (DM と管理者連絡のみ), from(管理者の表示名) }
//   chat の種類：
//     "all"              全体チャット
//     "team:{teamId}"    チーム内チャット（発表済みのチームのメンバー）
//     "admin:{uid}"      その参加者と管理者の1対1（管理者は誰でも読み書きできる）
//     "dm:{uid}_{uid}"   参加者どうしのDM（uid は小さい順）。管理者は閲覧のみ
//   chatImages/{id}  { uid, chat, data(縮小した画像) }   … 写真はメッセージとは別に置き、表示するときだけ読む
//                    （メッセージに直接入れると、アプリを開くたびに写真の分まで読み込まれて重くなるため）
//
// 読み取り回数を抑えるため、ふだんは「新しい順に80件」だけ受け取り（未読の数に使う）、
// 開いているチャットだけ、そのチャットの全メッセージを受け取る。

const dmKey = (a, b) => `dm:${[a, b].sort().join("_")}`;
const chatParts = (key) => { const [type, rest = ""] = key.split(/:(.*)/s); return { type, rest }; };
const sortedMsgs = (map) => [...map.values()].sort((a, b) => (ts(a.at) || Date.now()) - (ts(b.at) || Date.now()) || (a.id < b.id ? -1 : 1));
const senderName = (m) => m.from || memberName(m.uid);
const msgPreview = (m) => m.text || (m.image ? "📷 写真" : "");

// 写真は一度読んだら覚えておく（同じ写真を何度も読まない）
const chatImageCache = new Map(); // id -> Promise<dataURL | null>
function chatImage(id) {
  if (!chatImageCache.has(id)) chatImageCache.set(id, getDoc(D("chatImages", id)).then((d) => d.data()?.data ?? null).catch(() => null));
  return chatImageCache.get(id);
}

// 参加者がそのチャットに入れるか（管理者はすべて）
function canSeeChat(key) {
  if (S.isAdmin) return true;
  const uid = S.user.uid;
  const { type, rest } = chatParts(key);
  if (type === "all") return true;
  if (type === "team") return myTeamIds(uid).includes(rest);
  if (type === "admin") return rest === uid;
  if (type === "dm") return rest.split("_").includes(uid);
  return false;
}
// 管理者が書き込めるか（参加者どうしのDMは閲覧のみ）
const canPost = (key) => !S.isAdmin || chatParts(key).type !== "dm";

function chatTitle(key) {
  const { type, rest } = chatParts(key);
  if (type === "all") return "全体チャット";
  if (type === "team") return S.teams.has(rest) ? `${teamName(rest)}（チーム内）` : "チーム内チャット";
  if (type === "admin") return S.isAdmin ? `${memberName(rest)} ↔ 管理者` : "管理者への連絡";
  if (type === "dm") {
    const [a, b] = rest.split("_");
    if (!S.isAdmin) return memberName(a === S.user.uid ? b : a);
    // 管理者には参加者一覧の順（user01 → user02 …）で並べて出す
    const order = sortedMembers().map((m) => m.id);
    const [x, y] = [a, b].sort((p, q) => order.indexOf(p) - order.indexOf(q));
    return `${memberName(x)} ↔ ${memberName(y)}`;
  }
  return key;
}

// 既読（最後に見た時刻）と、開いたことのあるDMは端末に保存する
const chatStoreKey = (name) => `island.chat.${name}.${S.pid}.${S.user?.uid}`;
const loadJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const saveJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } };
const chatRead = () => loadJson(chatStoreKey("read"), {});
function markChatRead(key) { const r = chatRead(); r[key] = Date.now(); saveJson(chatStoreKey("read"), r); }
const knownThreads = () => loadJson(chatStoreKey("threads"), []);
function rememberThread(key) { const t = knownThreads(); if (!t.includes(key)) { t.push(key); saveJson(chatStoreKey("threads"), t); } }

function unreadOf(key) {
  const last = chatRead()[key] ?? 0;
  return [...S.msgRecent.values()].filter((m) => m.chat === key && m.uid !== S.user.uid && (ts(m.at) || Date.now()) > last).length;
}
// 一覧に出すチャット
function chatList() {
  const keys = new Set(["all"]);
  if (S.isAdmin) for (const t of S.teams.values()) keys.add(`team:${t.id}`);
  else {
    for (const id of myTeamIds(S.user.uid)) keys.add(`team:${id}`);
    keys.add(`admin:${S.user.uid}`);
    for (const k of knownThreads()) keys.add(k);
  }
  for (const m of S.msgRecent.values()) if (canSeeChat(m.chat)) keys.add(m.chat);
  const lastOf = (k) => sortedMsgs(new Map([...S.msgRecent].filter(([, m]) => m.chat === k))).pop();
  return [...keys].filter(canSeeChat).map((k) => ({ key: k, last: lastOf(k), unread: unreadOf(k) }))
    .sort((a, b) => (a.key === "all" ? -1 : b.key === "all" ? 1 : 0) || (ts(b.last?.at) || 0) - (ts(a.last?.at) || 0) || byNatural(chatTitle(a.key), chatTitle(b.key)));
}
const totalUnread = () => chatList().reduce((s, c) => s + c.unread, 0);

function paintChatBadges() {
  if (!S.user) return;
  const n = totalUnread();
  for (const b of document.querySelectorAll("[data-sheet=chat]")) {
    let dotEl = b.querySelector(".chat-badge");
    if (!dotEl) { dotEl = h("span", { class: "chat-badge" }); b.append(dotEl); }
    dotEl.textContent = n > 99 ? "99+" : String(n);
    dotEl.hidden = !n;
  }
}

function chatView() {
  let current = null;           // 開いているチャット
  let picking = false;          // DM の相手を選んでいる
  const el = h("div", { class: "chat" });
  const listBox = h("div", { class: "chat-list" });
  const msgs = h("div", { class: "chat-msgs" });
  const title = h("div", { class: "chat-title" });
  const input = h("textarea", { class: "chat-input", rows: "1", placeholder: "メッセージ", maxlength: "1000", enterkeyhint: "send" });
  const sendBtn = h("button", { class: "chat-send", "aria-label": "送信" }, "送信");
  const photoInput = h("input", { type: "file", accept: "image/*", hidden: true });
  const photoBtn = h("label", { class: "chat-photo", title: "写真を送る", "aria-label": "写真を送る" }, icon("photo"), photoInput);
  const readonly = h("div", { class: "chat-readonly" }, "参加者どうしのDMです（閲覧のみ）");
  const composer = h("div", { class: "chat-composer" }, photoBtn, input, sendBtn);
  const room = h("div", { class: "chat-room" },
    h("div", { class: "chat-room-head" }, h("button", { class: "text-btn", onclick: () => leave() }, "‹ 一覧"), title),
    msgs, readonly, composer);

  const baseMsg = (extra) => {
    const { type, rest } = chatParts(current);
    const data = { uid: S.user.uid, chat: current, at: serverTimestamp(), ...extra };
    if (type === "dm") data.parties = rest.split("_");
    if (type === "admin") data.parties = [rest];
    if (S.isAdmin) data.from = adminName(S.user.email);
    return data;
  };
  // 写真：選んだらすぐ送る（端末で縮小してから、写真とメッセージを1回の書き込みで送る）
  photoInput.addEventListener("change", () => guard(null, async () => {
    const f = photoInput.files?.[0];
    photoInput.value = "";
    if (!f || !current || !canPost(current)) return;
    const dataUrl = await compressImage(f);
    const imgRef = doc(C("chatImages"));
    chatImageCache.set(imgRef.id, Promise.resolve(dataUrl));
    const b = writeBatch(db);
    b.set(imgRef, { uid: S.user.uid, chat: current, data: dataUrl });
    b.set(doc(C("messages")), baseMsg({ text: "", image: imgRef.id }));
    fire(b.commit());
    rememberThread(current);
    stick = true;
  }));
  const send = () => {
    const text = input.value.trim();
    if (!text || !current || !canPost(current)) return;
    fire(addDoc(C("messages"), baseMsg({ text })));
    input.value = "";
    autosize();
    rememberThread(current);
    stick = true;
  };
  const autosize = () => { input.style.height = "auto"; input.style.height = `${Math.min(140, input.scrollHeight)}px`; };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) { e.preventDefault(); send(); } });
  sendBtn.addEventListener("click", send);

  let stick = true; // 一番下を見ているときは、新しいメッセージが来たら一番下へ
  // 長いトークでも重くならないよう、画面に出すのは新しい方から CHAT_PAGE 件ずつ
  const CHAT_PAGE = 150;
  let shownMsgs = CHAT_PAGE;
  msgs.addEventListener("scroll", () => { stick = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40; });

  function open(key) {
    current = key; picking = false; stick = true; shownMsgs = CHAT_PAGE;
    unlisten("chatOpen");
    S.chatMsgs = new Map();
    listen("chatOpen", query(C("messages"), where("chat", "==", key)), (s) => { if (s) S.chatMsgs = toMap(s); });
    rememberThread(key);
    paint();
  }
  function leave() { current = null; unlisten("chatOpen"); S.chatMsgs = new Map(); paint(); }

  function paintList() {
    const items = chatList();
    const people = sortedMembers().filter((m) => m.id !== S.user.uid);
    setKids(listBox,
      S.isAdmin ? null : h("div", { class: "chat-new" },
        picking ? h("div", { class: "chat-pick" }, h("div", { class: "cell-sub" }, "DMする相手を選んでください"),
          h("div", { class: "pick-list" }, people.map((m) => h("button", { class: "pick", onclick: () => open(dmKey(S.user.uid, m.id)) }, m.name))),
          h("button", { class: "text-btn", onclick: () => { picking = false; paint(); } }, "やめる"))
          : h("button", { class: "btn-small", onclick: () => { picking = true; paint(); } }, icon("plus"), "新しいDM")),
      h("div", { class: "group-body" }, items.map((c) => h("button", { class: "cell cell-button chat-row", onclick: () => open(c.key) },
        h("span", { class: `chat-ic ${chatParts(c.key).type}` }, icon(chatParts(c.key).type === "dm" ? "chat" : chatParts(c.key).type === "admin" ? "lock" : chatParts(c.key).type === "team" ? "flag" : "people")),
        h("span", { class: "cell-main" }, h("b", null, chatTitle(c.key)),
          h("small", null, c.last ? `${senderName(c.last)}：${msgPreview(c.last)}` : "まだメッセージはありません")),
        c.unread ? h("span", { class: "chat-unread" }, c.unread) : null))));
  }

  function paintRoom() {
    title.textContent = chatTitle(current);
    readonly.hidden = canPost(current);
    composer.hidden = !canPost(current);
    // このトークの受信が届くまでは、手元にある最近のメッセージを先に出しておく
    const all = sortedMsgs(S.meta.chatOpen ? S.chatMsgs : new Map([...S.msgRecent].filter(([, m]) => m.chat === current)));
    const list = all.slice(-shownMsgs);
    let prevDay = null;
    const rows = all.length > list.length ? [{ id: "more", more: all.length - list.length }] : [];
    for (const m of list) {
      const d = m.at?.toDate ? m.at.toDate() : new Date();
      const day = `${d.getMonth() + 1}月${d.getDate()}日`;
      if (day !== prevDay) { rows.push({ id: `day:${day}`, day }); prevDay = day; }
      rows.push(m);
    }
    keyedList(msgs, rows, (r) => ({ el: h("div") }), (row, r) => {
      if (r.day) { row.el.className = "chat-day"; row.el.textContent = r.day; return; }
      if (r.more) {
        row.el.className = "chat-more";
        setKids(row.el, h("button", { class: "text-btn", onclick: () => {
          const before = msgs.scrollHeight;
          shownMsgs += CHAT_PAGE;
          paintRoom();
          msgs.scrollTop += msgs.scrollHeight - before; // 読んでいた位置がずれないように
        } }, `前のメッセージを表示（あと${r.more}件）`));
        return;
      }
      const mine = r.uid === S.user.uid;
      const d = r.at?.toDate ? r.at.toDate() : null;
      const sig = `${r.text}|${r.image}|${d?.getTime()}|${mine}`;
      if (row.sig === sig) return;
      row.sig = sig;
      row.el.className = `chat-msg${mine ? " mine" : ""}${r.from ? " admin" : ""}`;
      setKids(row.el,
        mine ? null : h("div", { class: "chat-name" }, senderName(r)),
        r.image ? (() => {
          const img = h("img", { class: "chat-img", alt: "写真", onclick: () => { if (img.src) openLightbox(img.src); } });
          const box = h("div", { class: "chat-imgbox loading" }, img);
          chatImage(r.image).then((src) => {
            if (src) { img.src = src; box.classList.remove("loading"); img.onload = () => { if (stick) msgs.scrollTop = msgs.scrollHeight; }; } else box.replaceChildren(h("span", { class: "secondary" }, "写真を読み込めませんでした"));
          });
          return box;
        })() : null,
        r.text ? h("div", { class: "chat-bubble" }, r.text) : null,
        h("div", { class: "chat-time" }, d ? `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` : "送信中…",
          S.isAdmin ? h("button", { class: "chat-del", title: "削除", onclick: () => {
            if (!confirm("このメッセージを削除しますか？")) return;
            const b = writeBatch(db);
            b.delete(D("messages", r.id));
            if (r.image) b.delete(D("chatImages", r.image));
            fire(b.commit(), "削除しました");
          } }, "削除") : null));
    });
    if (!list.length && !msgs.querySelector(".chat-empty")) msgs.append(h("div", { class: "chat-empty" }, "まだメッセージはありません"));
    if (list.length) msgs.querySelector(".chat-empty")?.remove();
    if (stick) requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
    markChatRead(current);
  }

  function paint() {
    if (current && !canSeeChat(current)) current = null;
    if (current) {
      if (el.firstChild !== room) el.replaceChildren(room);
      paintRoom();
    } else {
      if (el.firstChild !== listBox) el.replaceChildren(listBox);
      paintList();
    }
    paintChatBadges();
  }
  return {
    el,
    update: paint,
    destroy() { unlisten("chatOpen"); S.chatMsgs = new Map(); },
  };
}

// ---------------------------------------------------------------- ID・パスワードの印刷
//
// パスワードは Firebase から読み出せないので、作成したときに accounts/{loginId}.pw（管理者だけが読める）に控えておく。
// 参加者が自分でパスワードを変えたら pwChanged/{uid} を書き、印刷物には「変更済み」と出す（古いパスワードを配らないように）。

function markPasswordChanged() {
  const uid = S.user.uid;
  const data = { uid, at: serverTimestamp() };
  // 入っているすべての旅行に書く（管理者がどの旅行を開いていても分かるように）
  const pids = S.myProfiles.length ? S.myProfiles.map((p) => p.id) : [S.pid];
  for (const pid of pids) fire(setDoc(pid === ROOT ? doc(db, "pwChanged", uid) : doc(db, "profiles", pid, "pwChanged", uid), data));
}

const QR_SRC = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";
const QR_SRI = "sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k";
let qrLoading = null;
function loadQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  qrLoading ??= new Promise((resolve) => {
    const sc = h("script", { src: QR_SRC, integrity: QR_SRI, crossorigin: "anonymous" });
    sc.onload = () => resolve(window.qrcode ?? null);
    sc.onerror = () => { qrLoading = null; resolve(null); }; // 読めなくても QR なしで印刷する
    document.head.append(sc);
  });
  return qrLoading;
}

// ---------------------------------------------------------------- インスタ用の報告画像（管理者）
// アンケート・集金・お知らせを作ったときに、みんなへ知らせる画像を端末の中で描く（サーバーには何も送らない）。
// ストーリー（1080×1920）と投稿（1080×1350）。右下にアプリを開く QR コード
const SHARE_FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif';
const SHARE_THEME = {
  poll: { label: "アンケート", sub: "回答をお願いします！", from: "#0A84FF", to: "#5E5CE6" },
  pay: { label: "集金のお知らせ", sub: "期限までにお願いします！", from: "#FF9F0A", to: "#FF375F" },
  ann: { label: "お知らせ", sub: "アプリで確認してね！", from: "#30B0C7", to: "#0A84FF" },
};
// 1文字ずつ測って折り返す（句読点・閉じかっこは行頭に来ないよう前の行に付ける）
function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    let line = "";
    for (const ch of [...para]) {
      if (ctx.measureText(line + ch).width > maxW && line) {
        if (/^[、。，．・」』）)！？!?ー〜]$/.test(ch)) { line += ch; continue; }
        out.push(line); line = ch;
      } else line += ch;
    }
    out.push(line);
  }
  return out;
}
function roundRect(ctx, x, y, w, hh, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r);
  ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
async function drawShareImage(kind, item, format) {
  const W = 1080, H = format === "story" ? 1920 : 1350;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const th = SHARE_THEME[kind];
  const font = (wt, px) => `${wt} ${px}px ${SHARE_FONT}`;
  // 背景
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, th.from); g.addColorStop(1, th.to);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.12; ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(W * 0.92, H * 0.06, 260, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(W * 0.05, H * 0.97, 320, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  const pad = 84, top = format === "story" ? 230 : 110; // ストーリーは上下に操作ボタンが重なるので余白を広く
  // 旅行の名前とラベル
  ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.font = font(600, 38); ctx.textBaseline = "top";
  ctx.fillText(S.config.title || pageName(S.pid) || APP_TITLE, pad, top);
  ctx.font = font(800, 46);
  const lw = ctx.measureText(th.label).width + 56;
  ctx.fillStyle = "#fff"; roundRect(ctx, pad, top + 66, lw, 76, 38); ctx.fill();
  ctx.fillStyle = th.to; ctx.fillText(th.label, pad + 28, top + 80);
  // 白いカード
  const cardY = top + 180, cardX = pad - 24, cardW = W - (pad - 24) * 2;
  const footH = 250, bottom = H - (format === "story" ? 260 : 90);
  const cardH = bottom - footH - 40 - cardY;
  ctx.save(); ctx.shadowColor = "rgba(0,0,0,.18)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 12;
  ctx.fillStyle = "#fff"; roundRect(ctx, cardX, cardY, cardW, cardH, 44); ctx.fill(); ctx.restore();
  const ix = cardX + 60, iw = cardW - 120, maxY = cardY + cardH - 50;
  let y = cardY + 64;
  // 見出し（長いときは文字を小さくして4行まで）
  const title = kind === "poll" ? item.question : item.title || "お知らせ";
  let size = format === "story" ? 76 : 62, lines;
  for (; size >= 46; size -= 4) { ctx.font = font(800, size); lines = wrapLines(ctx, title, iw); if (lines.length <= 3) break; }
  lines = lines.slice(0, 4);
  ctx.fillStyle = "#1c1c1e";
  for (const ln of lines) { ctx.fillText(ln, ix, y); y += size * 1.32; }
  y += 26;
  ctx.fillStyle = "#e5e5ea"; ctx.fillRect(ix, y, iw, 3); y += 44;
  const info = (label, value) => {
    if (y > maxY - 60) return;
    ctx.font = font(600, 34); ctx.fillStyle = "#8e8e93"; ctx.fillText(label, ix, y);
    ctx.font = font(700, 40); ctx.fillStyle = "#1c1c1e";
    for (const ln of wrapLines(ctx, value, iw - 190).slice(0, 2)) { ctx.fillText(ln, ix + 190, y - 3); y += 56; }
    y += 10;
  };
  if (kind === "poll") {
    // 選択肢は横に流して並べる（入りきらない分は「ほか○個」）。下の「締切」などの行の分は空けておく
    const compact = format !== "story"; // 投稿サイズは「締切・対象」を1行にまとめて、選択肢の場所を空ける
    const infoRows = compact ? 1 : (isRankPoll(item) ? 1 : 0) + 2;
    const reserve = infoRows * 66 + 60; // 下の「締切」「対象」と「ほか○個」の分
    const opts = item.options ?? [];
    const chipH = format === "story" ? 72 : 64, gap = 14;
    ctx.font = font(700, format === "story" ? 38 : 34);
    let cx = ix, rowY = y, shown = 0, lastBottom = y;
    for (const o of opts) {
      let t = o;
      while (ctx.measureText(t).width > iw - 100 && t.length > 1) t = t.slice(0, -1);
      if (t !== o) t = `${t.slice(0, -1)}…`;
      const cw = ctx.measureText(t).width + 88;
      if (cx > ix && cx + cw > ix + iw) { cx = ix; rowY += chipH + gap; }
      if (rowY + chipH > maxY - reserve) break;
      ctx.fillStyle = "#f2f2f7"; roundRect(ctx, cx, rowY, cw, chipH, chipH / 2); ctx.fill();
      ctx.fillStyle = th.from; ctx.beginPath(); ctx.arc(cx + 36, rowY + chipH / 2, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#1c1c1e"; ctx.fillText(t, cx + 60, rowY + (chipH - (format === "story" ? 38 : 34)) / 2 - 2);
      cx += cw + gap; shown++; lastBottom = rowY + chipH;
    }
    if (shown) y = lastBottom + 24;
    if (shown < opts.length) { ctx.font = font(600, 32); ctx.fillStyle = "#8e8e93"; ctx.fillText(`ほか ${opts.length - shown}個`, ix, y); y += 54; }
    y += 6;
    if (compact) info("締切", [item.deadline ? fmtDeadline(item.deadline) : "なし", `対象 ${item.targets ? `${item.targets.length}人` : "全員"}`, isRankPoll(item) ? "順位投票" : null].filter(Boolean).join(" ・ "));
    else {
      if (isRankPoll(item)) info("形式", `順位を付けて投票（${pollDepth(item)}位まで）`);
      info("締切", item.deadline ? fmtDeadline(item.deadline) : "なし");
      info("対象", item.targets ? `${item.targets.length}人` : "全員");
    }
  } else if (kind === "pay") {
    ctx.font = font(800, 120); ctx.fillStyle = th.to; ctx.fillText(yen(item.amount), ix, y);
    const aw = ctx.measureText(yen(item.amount)).width;
    ctx.font = font(700, 44); ctx.fillStyle = "#8e8e93"; ctx.fillText("/ 人", ix + aw + 20, y + 62);
    y += 170;
    info("期限", item.due ? item.due.replaceAll("-", "/") : "なし");
    info("対象", item.targets ? `${item.targets.length}人` : "全員");
    if (item.note) info("メモ", item.note);
  } else {
    ctx.font = font(500, 40); ctx.fillStyle = "#3a3a3c";
    const body = wrapLines(ctx, item.body ?? "", iw);
    const room = Math.max(1, Math.floor((maxY - y) / 60));
    body.slice(0, room).forEach((ln, i) => { ctx.fillText(i === room - 1 && body.length > room ? `${ln.slice(0, -1)}…` : ln, ix, y); y += 60; });
  }
  // 下：ひとこと＋QR
  const fy = bottom - footH;
  const textW = W - pad * 2 - 230 - 36; // QR の左まで
  let fs = 56;
  ctx.font = font(800, fs);
  while (ctx.measureText(th.sub).width > textW && fs > 34) { fs -= 2; ctx.font = font(800, fs); }
  ctx.fillStyle = "#fff";
  ctx.fillText(th.sub, pad, fy + 30);
  ctx.font = font(600, 34); ctx.fillStyle = "rgba(255,255,255,.92)";
  ctx.fillText("旅行ポータルのアプリから", pad, fy + 120);
  ctx.fillText("QRコードで開けます", pad, fy + 168);
  const qr = window.qrcode ?? await loadQr();
  if (qr) {
    const q = qr(0, "M"); q.addData(`${location.origin}${location.pathname}`); q.make();
    const n = q.getModuleCount(), box = 230, qx = W - pad - box, qy = fy;
    ctx.fillStyle = "#fff"; roundRect(ctx, qx, qy, box, box, 24); ctx.fill();
    const m = 18, cell = (box - m * 2) / n;
    ctx.fillStyle = "#1c1c1e";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect(qx + m + c * cell, qy + m + r * cell, Math.ceil(cell), Math.ceil(cell));
  }
  return cv;
}
// 画像の確認と保存・共有
async function openShareImage(kind, item) {
  let format = "story";
  const img = h("img", { class: "share-preview", alt: "報告用の画像" });
  const seg = segmented([{ value: "story", label: "ストーリー（縦長）" }, { value: "post", label: "投稿（4:5）" }], format);
  const shareBtn = h("button", { class: "btn-filled" }, "共有する（インスタなど）");
  const saveBtn = h("a", { class: "btn-filled ghost-btn", download: "" }, "画像を保存");
  const close = () => box.remove();
  const box = h("div", { class: "share-modal", onclick: (e) => { if (e.target === box) close(); } },
    h("div", { class: "share-panel" },
      h("div", { class: "share-head" }, h("b", null, "報告用の画像"), h("button", { class: "text-btn", onclick: close }, "閉じる")),
      seg, h("div", { class: "share-stage" }, img),
      h("div", { class: "share-actions" }, shareBtn, saveBtn),
      h("div", { class: "cell-sub" }, "スマホは「共有する」からインスタのストーリー・投稿に送れます。うまくいかないときは「画像を保存」してから投稿してください。")));
  document.body.append(box);
  let blob = null;
  const name = () => `${(kind === "poll" ? item.question : item.title || "お知らせ").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 30)}_${format}.png`;
  const paint = async () => {
    const cv = await drawShareImage(kind, item, format);
    const url = cv.toDataURL("image/png");
    img.src = url; saveBtn.href = url; saveBtn.download = name();
    blob = await new Promise((res) => cv.toBlob(res, "image/png"));
  };
  seg.addEventListener("change", () => { format = seg.value; paint(); });
  shareBtn.addEventListener("click", () => guard(null, async () => {
    const file = blob && new File([blob], name(), { type: "image/png" });
    if (file && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (e) { if (e?.name !== "AbortError") throw e; }
    } else { saveBtn.click(); toast("この端末では直接共有できないので、画像を保存しました"); }
  }));
  await paint();
}

// 印刷に使うパスワードの控えと QR の部品は、参加者の画面を開いたときに先に読んでおく
// （押してから通信すると、スマホでは印刷画面が出るまで数秒かかるため）。「本人が変更済み」は常に受け取っている記録（S.pwChangedIds）を使う
const printCache = { at: 0, pid: null, byLogin: null, pending: null };
function prefetchPrint(force = false) {
  loadQr();
  if (!S.isAdmin || !navigator.onLine) return Promise.resolve();
  if (printCache.pending) return printCache.pending;
  if (!force && printCache.pid === S.pid && Date.now() - printCache.at < 5 * 60e3) return Promise.resolve();
  const pid = S.pid;
  printCache.pending = getDocs(collection(db, "accounts"))
    .then((accs) => { Object.assign(printCache, { at: Date.now(), pid, byLogin: new Map(accs.docs.map((d) => [d.id, d.data()])) }); })
    .catch((e) => console.warn("prefetchPrint", e))
    .finally(() => { printCache.pending = null; });
  return printCache.pending;
}

async function printAllCredentials(mode) {
  // 先に読んだ控えが使えれば、通信を待たずにすぐ印刷する（全員分がそろっていないときだけ読み直す）
  const ready = () => printCache.pid === S.pid && printCache.byLogin && sortedMembers().every((m) => !m.loginId || printCache.byLogin.has(m.loginId));
  if (!ready()) {
    if (!navigator.onLine) return toast("印刷の準備は電波のある場所で行ってください", true);
    toast("印刷の準備中…");
    await prefetchPrint(true);
    if (!printCache.byLogin) return toast("パスワードの控えを読めませんでした。電波を確認してください", true);
  }
  const byLogin = printCache.byLogin;
  const changedSet = S.pwChangedIds ?? new Set();
  const rows = sortedMembers().map((m) => {
    const a = byLogin.get(m.loginId);
    return { name: m.name, loginId: m.loginId, password: a?.pw ?? null, changed: changedSet.has(m.id), missing: !a?.pw };
  });
  if (!rows.length) return toast("参加者がいません", true);
  await printCredentials(rows, mode);
}

async function printCredentials(rows, mode) {
  const url = `${location.origin}${location.pathname}`;
  const qr = window.qrcode ?? await loadQr();
  // パスワードが分かる人は「読むだけでログインできる」QR、分からない人（変更済み・記録なし）はURLだけのQR
  const canAuto = (r) => !!(r.password && !r.changed);
  const qrSvg = (text) => { if (!qr) return ""; const q = qr(0, "M"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 2, margin: 0, scalable: true }); };
  const title = S.config.title || APP_TITLE;
  const pwText = (r) => (r.changed ? "本人が変更済み" : r.password ? r.password : r.reused ? "（前の旅行と同じ）" : "");
  const root = h("div", { id: "print-root", class: `print-${mode}` });
  if (mode === "list") {
    root.append(h("h1", null, `${title}　ID・パスワード一覧（管理者の控え）`),
      h("p", null, `ログインする場所：${url}　　印刷：${new Date().toLocaleString("ja-JP")}　　${rows.length}人`),
      h("table", null, h("tr", null, h("th", null, "#"), h("th", null, "名前"), h("th", null, "ID"), h("th", null, "パスワード"), h("th", null, "渡した")),
        rows.map((r, i) => h("tr", null, h("td", null, i + 1), h("td", null, r.name), h("td", { class: "mono" }, r.loginId),
          h("td", { class: `mono${r.password && !r.changed ? "" : " muted"}` }, pwText(r) || "記録なし"), h("td", null, "□")))),
      h("p", { class: "note" }, "この紙は他の人に見せないでください。パスワードを本人が変えた人は「変更済み」と表示されます。配る用カードのQRコードは、読むだけでその人としてログインできるので、カードも本人以外に見せないでください。"));
  } else {
    root.append(...rows.map((r) => h("div", { class: "pcard" },
      h("div", { class: "pcard-main" },
        h("div", { class: "pcard-title" }, title),
        h("div", { class: "pcard-name" }, r.name),
        h("div", { class: "pcard-row" }, h("span", null, "ID"), h("b", { class: "mono" }, r.loginId)),
        h("div", { class: "pcard-row" }, h("span", null, "パスワード"), pwText(r) ? h("b", { class: `mono${r.password && !r.changed ? "" : " muted"}` }, pwText(r)) : h("b", { class: "blank" })),
        h("ol", { class: "pcard-steps" }, canAuto(r)
          ? [h("li", null, "右のQRコードを読むとログイン"), h("li", null, "共有 →「ホーム画面に追加」"), h("li", null, "追加したアプリで1回だけID・パスワード入力")]
          : [h("li", null, "QRコードか下のURLを開く"), h("li", null, "IDとパスワードでログイン"), h("li", null, "共有 →「ホーム画面に追加」")]),
        h("div", { class: "pcard-url mono" }, url)),
      qr ? h("div", { class: "pcard-qrbox" }, (() => { const box = h("div", { class: "pcard-qr" }); box.innerHTML = qrSvg(canAuto(r) ? qrLoginUrl(url, r.loginId, r.password) : url); return box; })(),
        h("div", { class: "pcard-qrcap" }, canAuto(r) ? "読むとログイン" : "ログイン画面")) : null)));
  }
  document.getElementById("print-root")?.remove();
  document.body.append(root);
  document.body.classList.add("printing");
  const done = () => { root.remove(); document.body.classList.remove("printing"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  // 画像（QR）の描画を待ってから印刷画面を開く
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.print();
}

// ---------------------------------------------------------------- ポイントQR
//   ptQrs/{id}     { title, points, kind: "user" | "team", setId, mode: "once" | "first" | "perUser", limit, active, createdAt }
//                  once：全体で1回だけ / first：先着 limit 人（1人1回）/ perUser：1人1回（人数の上限なし）
//   ptClaims/{qrId}_u_{uid}  { uid, qrId, at }        … その人が受け取った記録（1人1回）
//   ptClaims/{qrId}_s{k}     { uid, qrId, at, slot }  … 先着の枠（k 番目）。トランザクションで「まだ無い枠」だけ取るので、同時に読んでも人数を超えない
// 受け取りは参加者の端末で行い、同じトランザクションでポイント履歴と合計（stats）にも書く
const PT_MODES = { once: "全体で1回だけ", first: "先着○人（1人1回）", perUser: "1人1回ずつ（人数制限なし）" };
const ptQrUrl = (q) => `${location.origin}${location.pathname}#pt=${S.pid}.${q.id}`;
const ptLimitOf = (q) => (q.mode === "once" ? 1 : q.mode === "first" ? Math.max(1, Number(q.limit) || 1) : 0);
const ptClaimsOf = (q) => [...S.ptClaims.values()].filter((c) => c.qrId === q.id && !c.slot).sort((a, b) => ts(a.at) - ts(b.at));
const ptModeText = (q) => (q.mode === "first" ? `先着${ptLimitOf(q)}人（1人1回）` : PT_MODES[q.mode] ?? "");

let ptBusy = false;
async function maybeClaimPt() {
  const p = ptPending;
  if (!p || ptBusy || !S.user || !S.authReady) return;
  if (S.isAdmin) { ptPending = null; sessionStorage.removeItem("island.pt"); return showPtResult({ ng: "管理者のアカウントではポイントを受け取れません（参加者のアカウントで読み取ってください）" }); }
  if (!S.pid || !S.me) return; // 旅行を開くまで待つ
  if (p.pid !== S.pid) {
    if (S.myProfiles.some((x) => x.id === p.pid)) return switchProfile(p.pid);
    ptPending = null; sessionStorage.removeItem("island.pt");
    return showPtResult({ ng: "このQRコードは、あなたが参加している旅行のものではありません" });
  }
  ptPending = null;
  try { sessionStorage.removeItem("island.pt"); } catch { /* なし */ }
  ptBusy = true;
  try { showPtResult(await claimPt(p.id)); } catch (e) { showPtResult({ ng: navigator.onLine ? errMsg(e) : "電波のある所でもう一度読み取ってください" }); } finally { ptBusy = false; }
}
async function claimPt(qrId) {
  const uid = S.user.uid;
  return runTransaction(db, async (tx) => {
    const qs = await tx.get(D("ptQrs", qrId));
    if (!qs.exists()) return { ng: "このQRコードは使えません（削除されています）" };
    const q = { id: qs.id, ...qs.data() };
    if (q.active === false) return { ng: `「${q.title}」は今は受け取れません（停止中）`, q };
    const mineRef = D("ptClaims", `${qrId}_u_${uid}`);
    if ((await tx.get(mineRef)).exists()) return { ng: `「${q.title}」はもう受け取っています`, q };
    const n = ptLimitOf(q);
    let slotRef = null;
    for (let k = 0; k < n; k++) {
      const r = D("ptClaims", `${qrId}_s${k}`);
      if (!(await tx.get(r)).exists()) { slotRef = r; break; }
    }
    if (n && !slotRef) return { ng: `「${q.title}」は${n === 1 ? "もう受け取られました" : `先着${n}人に達しました`}`, q };
    let log = { kind: "user", target: uid, teamId: null };
    if (q.kind === "team") {
      const teamId = teamOfIn(uid, q.setId);
      if (!teamId) return { ng: "チームに入っていないので受け取れません", q };
      log = { kind: "team", target: teamId, teamId, contributor: uid };
    }
    Object.assign(log, { visibility: "public", delta: Number(q.points) || 0, reason: `QR「${q.title}」`, createdAt: serverTimestamp(), author: "QR", uid });
    tx.set(mineRef, { uid, qrId, at: serverTimestamp() });
    if (slotRef) tx.set(slotRef, { uid, qrId, at: serverTimestamp(), slot: true });
    tx.set(doc(C("pointLogs")), log);
    const patch = statsPatch([log]);
    if (patch) tx.set(D("stats", "points"), { ...patch, uid }, { merge: true }); // uid 欄は参加者が書き込むためのもの（合計の計算には使わない）
    return { ok: true, q, team: log.kind === "team" ? teamName(log.target) : null };
  });
}
function showPtResult(r) {
  document.querySelector(".pt-result")?.remove();
  const close = () => box.remove();
  const box = h("div", { class: "pt-result", onclick: (e) => { if (e.target === box) close(); } },
    h("div", { class: `pt-result-card${r.ok ? " ok" : ""}` },
      r.ok ? h("div", { class: "pt-result-big" }, `+${r.q.points}`, h("small", null, "pt")) : h("div", { class: "pt-result-ng" }, "×"),
      h("div", { class: "pt-result-title" }, r.ok ? `「${r.q.title}」` : "受け取れませんでした"),
      h("div", { class: "pt-result-sub" }, r.ok ? (r.team ? `${r.team} にポイントが入りました` : "ポイントをゲットしました！") : r.ng),
      h("button", { class: "btn-filled", onclick: close }, "閉じる")));
  document.body.append(box);
}

// 管理者：ポイントQRの作成・一覧・印刷
function ptQrAdmin() {
  const title = h("input", { type: "text", class: "plain", placeholder: "例：宝探し① / ゴミ拾いボーナス", maxlength: "30" });
  const points = h("input", { type: "number", inputmode: "numeric", value: "10" });
  const mode = segmented(Object.entries(PT_MODES).map(([value, label]) => ({ value, label: label.replace("（1人1回）", "").replace("（人数制限なし）", "") })), "perUser");
  const lim = h("input", { type: "number", inputmode: "numeric", value: "3", min: "1" });
  const limCell = field("先着何人まで", lim);
  const kind = segmented([{ value: "user", label: "読んだ人の個人ポイント" }, { value: "team", label: "読んだ人のチーム" }], "user");
  const setSel = h("select", { class: "inline-select" });
  const setCell = field("どのチーム表のチームか", setSel);
  const paint = () => { limCell.hidden = mode.value !== "first"; setCell.hidden = kind.value !== "team"; fillSelect(setSel, sortedSets().map((x) => ({ value: x.id, label: x.name }))); };
  mode.addEventListener("change", paint); kind.addEventListener("change", paint);
  const form = h("form", { onsubmit: (e) => {
    e.preventDefault();
    const pts = Math.round(Number(points.value) || 0);
    if (!title.value.trim() || !pts) return toast("名前とポイントを入れてください", true);
    if (kind.value === "team" && !setSel.value) return toast("チーム表を選んでください", true);
    fire(addDoc(C("ptQrs"), { title: title.value.trim(), points: pts, mode: mode.value, limit: mode.value === "first" ? Math.max(1, Math.round(Number(lim.value) || 1)) : null,
      kind: kind.value, setId: kind.value === "team" ? setSel.value : null, active: true, createdAt: serverTimestamp() }), "ポイントQRを作りました");
    title.value = "";
  } },
    h("div", { class: "group-body" }, h("div", { class: "cell" }, title), field("もらえるポイント", points), h("div", { class: "cell" }, mode), limCell, h("div", { class: "cell" }, kind), setCell,
      h("button", { class: "cell cell-button", type: "submit" }, icon("plus"), "ポイントQRを作る")));
  const list = h("div");
  const size = segmented([{ value: "30", label: "小 3cm" }, { value: "50", label: "中 5cm" }, { value: "80", label: "大 8cm" }, { value: "150", label: "特大 15cm" }], "50");
  const el = h("section", { class: "pt-qr-admin" }, h("div", { class: "group-header" }, "ポイントQR"),
    keptFold("ptqr-new", "＋ 新しいポイントQR", form, false), list,
    group("印刷するQRの大きさ", h("div", { class: "cell" }, size), "読み取ると、その人（またはその人のチーム）にポイントが入ります。カメラアプリで読み取ってもらってください（ログインしていない人はログイン後に受け取れます）。"));
  return {
    el,
    update() {
      paint();
      const qs = [...S.ptQrs.values()].sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
      setKids(list, qs.length ? group(null, qs.map((q) => {
        const cl = ptClaimsOf(q);
        const n = ptLimitOf(q);
        return h("div", { class: `cell pt-qr-row${q.active === false ? " off" : ""}` },
          h("div", { class: "cell-main" }, h("b", null, q.title, h("span", { class: "tint" }, ` +${q.points}pt`)),
            h("div", { class: "cell-sub" }, `${ptModeText(q)} ・ ${q.kind === "team" ? `チーム（${S.sets.get(q.setId)?.name ?? "チーム表"}）` : "個人"} ・ 受け取り ${cl.length}${n ? `/${n}` : ""}人${q.active === false ? " ・ 停止中" : ""}`),
            cl.length ? h("div", { class: "cell-sub" }, cl.map((c) => memberName(c.uid)).join("・")) : null),
          h("div", { class: "pt-qr-actions" },
            h("button", { class: "btn-small", onclick: () => guard(null, () => printPtQrs([q], Number(size.value))) }, "印刷"),
            h("button", { class: "text-btn", onclick: () => fire(updateDoc(D("ptQrs", q.id), { active: q.active === false })) }, q.active === false ? "再開" : "停止"),
            h("button", { class: "text-btn destructive", onclick: () => { if (confirm(`「${q.title}」を削除しますか？（付いたポイントは残ります）`)) fire(deleteDoc(D("ptQrs", q.id)), "削除しました"); } }, "削除")));
      })) : null, qs.length > 1 ? h("button", { class: "btn-small ghost", onclick: () => guard(null, () => printPtQrs(qs.filter((q) => q.active !== false), Number(size.value))) }, "停止中以外をまとめて印刷") : null);
    },
  };
}
async function printPtQrs(qs, mm) {
  if (!qs.length) return;
  const qr = window.qrcode ?? await loadQr();
  if (!qr) return toast("QRコードの部品を読み込めませんでした。電波を確認してください", true);
  const svg = (text) => { const q = qr(0, "M"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 2, margin: 0, scalable: true }); };
  const root = h("div", { id: "print-root", class: "print-ptqr", style: `--qr:${mm}mm` }, qs.map((q) => h("div", { class: "ptq" },
    (() => { const b = h("div", { class: "ptq-code" }); b.innerHTML = svg(ptQrUrl(q)); return b; })(),
    h("div", { class: "ptq-title" }, q.title),
    h("div", { class: "ptq-pt" }, `読み取ると +${q.points}pt`),
    mm >= 50 ? h("div", { class: "ptq-sub" }, `${ptModeText(q)}${q.kind === "team" ? " ・ チームに加算" : ""}`) : null)));
  document.getElementById("print-root")?.remove();
  document.body.append(root);
  document.body.classList.add("printing");
  const done = () => { root.remove(); document.body.classList.remove("printing"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.print();
}

// ---------------------------------------------------------------- データを PDF で出力（管理者）
// 印刷画面を開き、「PDF に保存」で保存する。明朝体（Noto Serif JP）で、項目ごとに改ページする
const EXPORT_PARTS = [
  { key: "members", label: "参加者一覧" },
  { key: "teams", label: "チーム" },
  { key: "points", label: "ポイント" },
  { key: "quizzes", label: "クイズ（問題と正解）" },
  { key: "notes", label: "表・メモ" },
  { key: "polls", label: "出欠・アンケート" },
  { key: "payments", label: "集金" },
  { key: "expenses", label: "立て替えの精算" },
  { key: "checklists", label: "チェックリスト" },
];
let serifLoading = null;
function loadSerif() {
  serifLoading ??= new Promise((resolve) => {
    const link = h("link", { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;700&display=swap" });
    link.onload = () => resolve(true); link.onerror = () => resolve(false);
    document.head.append(link);
  });
  return serifLoading;
}
function exportBuild(parts) {
  const title = S.config.title || APP_TITLE;
  const now = new Date();
  const T = (headers, rows, cls = "") => h("table", { class: `rp-table ${cls}` }, h("thead", null, h("tr", null, headers.map((x) => h("th", null, x)))), h("tbody", null, rows.map((r) => h("tr", null, r.map((c) => h("td", null, c ?? ""))))));
  const sec = (label, ...body) => h("section", { class: "rp-sec" }, h("h2", null, label), ...body);
  const none = (t = "データはありません") => h("p", { class: "rp-none" }, t);
  const ms = sortedMembers();
  const build = {
    members: () => sec("参加者一覧", ms.length ? T(["#", "名前", "ID"], ms.map((m, i) => [i + 1, m.name, m.loginId]), "rp-idx") : none()),
    teams: () => {
      const sets = sortedSets();
      return sec("チーム", sets.length ? sets.map((st) => h("div", { class: "rp-block" },
        h("h3", null, st.name, h("small", null, st.published ? "（発表済み）" : "（未発表）")),
        h("div", { class: "rp-teams" }, teamsInSet(st.id).map((t) => {
          const mem = membersOfTeam(t.id);
          const spies = membershipsOf((x) => x.teamId === t.id && x.hidden).map((x) => memberName(x.uid));
          return h("div", { class: "rp-team" }, h("b", null, h("span", { class: "rp-dot", style: `background:${t.color ?? "#888"}` }), t.name, h("small", null, `${mem.length}人`)),
            h("p", null, teamNamesText(t, mem) || "—"), spies.length ? h("p", { class: "rp-sub" }, `スパイ（本当はこのチーム）：${spies.join("・")}`) : null);
        })),
        (() => { const un = ms.filter((m) => !teamOfIn(m.id, st.id)); return un.length ? h("p", { class: "rp-sub" }, `未所属：${un.map((m) => m.name).join("・")}`) : null; })())) : none());
    },
    points: () => {
      const users = ms.map((m) => [m.name, ptTotal("user", m.id)]).sort((a, b) => b[1] - a[1]);
      const teams = sortedSets().flatMap((st) => teamsInSet(st.id).map((t) => [st.name, t.name, ptTotal("team", t.id)]));
      let rank = 0, prev = null;
      return sec("ポイント",
        h("h3", null, "個人"), users.length ? T(["順位", "名前", "ポイント"], users.map(([n, v], i) => { if (v !== prev) { rank = i + 1; prev = v; } return [rank, n, v]; }), "rp-num rp-rank") : none(),
        h("h3", null, "チーム"), teams.length ? T(["チーム表", "チーム", "ポイント"], teams, "rp-num") : none());
    },
    quizzes: () => {
      const qs = [...S.quizzes.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return sec("クイズ", qs.length ? qs.map((qz) => {
        const sess = quizSessions(qz);
        return h("div", { class: "rp-block" },
          h("h3", null, qz.title || "クイズ", h("small", null, `全${qz.questions?.length ?? 0}問 ・ 解答者 ${qz.answerers ? `${qz.answerers.length}人` : "全員"}`)),
          (qz.questions ?? []).map((q, i) => {
            const se = sess.length > 1 ? sess.find((x) => x.id === q.session)?.name : null;
            let ans;
            if (q.type === "choice") ans = h("ol", { class: "rp-choices", type: "A" }, (q.choices ?? []).map((c, k) => h("li", { class: q.answer === k ? "ok" : null }, c || "（空欄）", q.answer === k ? " ◎正解" : "")));
            else if (q.type === "order") ans = h("p", null, "正しい順：", (q.choices ?? []).join(" → "));
            else if (q.type === "vote") ans = h("p", null, `アンケート「${S.polls.get(q.pollId)?.question ?? "未設定"}」の結果（${q.voteMode === "rank" ? `上位${seqLen(q)}位の順番` : "1位"}）　`, answerLabel(q, revealAnswerOf(q)));
            else ans = h("p", null, "正解：", q.answer || "（未設定）");
            return h("div", { class: "rp-q" },
              h("div", { class: "rp-qhead" }, h("b", null, `第${i + 1}問`), se ? h("span", null, se) : null, h("span", null, QTYPE[q.type] ?? q.type), h("span", null, `${q.points ?? 10}点`), q.time ? h("span", null, `${q.time}秒`) : null),
              h("p", { class: "rp-qtext" }, q.text || "（問題文なし）"), ans);
          }));
      }) : none());
    },
    notes: () => {
      const ns = sortedNotes();
      return sec("表・メモ", ns.length ? ns.map((n) => h("div", { class: "rp-block" },
        h("h3", null, n.title || "無題", h("small", null, n.shared ? "（全体公開）" : "（管理者用）")),
        n.type === "table" ? (() => { const rows = (n.rows ?? []).map((r) => r.c ?? []); return rows.length ? T(rows[0], rows.slice(1)) : none("空の表"); })()
          : h("p", { class: "rp-pre" }, n.body || ""))) : none());
    },
    polls: () => {
      const ps = sortedPolls().filter((p) => !p.fromLobby);
      return sec("出欠・アンケート", ps.length ? ps.map((p) => {
        const votes = [...S.votes.values()].filter((v) => v.pollId === p.id && isTarget(p, v.uid));
        const tg = pollTargets(p);
        const noAns = tg.filter((m) => !votes.some((v) => v.uid === m.id));
        const rows = isRankPoll(p)
          ? (() => { const pts = pollScores(p, votes); return p.options.map((o) => [o, `${pts.get(o) ?? 0}点`, p.anonymous ? "" : ""]).sort((a, b) => parseInt(b[1]) - parseInt(a[1])); })()
          : p.options.map((o) => { const vs = votes.filter((v) => v.choice === o); return [o, `${vs.length}人`, p.anonymous ? "（非表示）" : vs.map((v) => memberName(v.uid)).join("・")]; });
        return h("div", { class: "rp-block" }, h("h3", null, p.question, h("small", null, `${votes.length}/${tg.length}人回答${pollOpen(p) ? "・受付中" : "・締切"}`)),
          T(["選択肢", isRankPoll(p) ? "点数" : "人数", "回答した人"], rows),
          noAns.length ? h("p", { class: "rp-sub" }, `未回答：${noAns.map((m) => m.name).join("・")}`) : null);
      }) : none());
    },
    payments: () => {
      const ps = sortedPayments().filter((p) => !isExt(p.id));
      return sec("集金", ps.length ? ps.map((p) => {
        const t = payTotals(p);
        return h("div", { class: "rp-block" }, h("h3", null, p.title, h("small", null, `${yen(p.amount)} / 人${p.due ? ` ・ 期限 ${p.due.replaceAll("-", "/")}` : ""}`)),
          h("p", { class: "rp-sub" }, `入金済み ${t.paidN}/${t.n}人 ・ ${yen(t.got)} / ${yen(t.expect)}`),
          T(["名前", "金額", "状態", "払い方"], payTargets(p).map((m) => { const r = recordOf(p, m.id); return [m.name, yen(amountOf(p, m.id)), PAY_STATUS[r.status], r.status === "paid" ? r.method ?? "" : ""]; })));
      }) : none());
    },
    expenses: () => {
      const items = sortedExpenses();
      const st = settlements();
      return sec("立て替えの精算",
        h("h3", null, "精算（誰が誰に払うか）"), st.length ? T(["払う人", "受け取る人", "金額"], st.map((x) => [memberName(x.from), memberName(x.to), yen(x.amount)])) : none("精算するものはありません"),
        h("h3", null, "記録"), items.length ? T(["内容", "立て替えた人", "金額", "割る人"], items.map((e) => e.kind === "settle" ? [`支払い済み（${memberName(e.from)} → ${memberName(e.to)}）`, "", yen(e.amount), ""] : [e.title, memberName(e.payer), yen(e.amount), e.split?.length ? splitOf(e).map(memberName).join("・") : "全員"])) : none());
    },
    checklists: () => {
      const ls = sortedChecklists();
      return sec("チェックリスト", ls.length ? ls.map((l) => h("div", { class: "rp-block" }, h("h3", null, l.title),
        T(["項目", "種類", "状況"], l.items.map((it) => {
          if (it.kind === "shared") { const c = S.checks.get(checkId(l, it, "")); return [it.text, `共有${it.assignee ? `（担当：${memberName(it.assignee)}）` : ""}`, c ? `済（${memberName(c.uid)}）` : "まだ"]; }
          const not = ms.filter((m) => !isChecked(l, it, m.id));
          return [it.text, "各自", `${ms.length - not.length}/${ms.length}${not.length && not.length < ms.length ? `（まだ：${not.map((m) => m.name).join("・")}）` : ""}`];
        })))) : none());
    },
  };
  return h("div", { id: "print-root", class: "print-report" },
    h("header", { class: "rp-cover" }, h("div", { class: "rp-kicker" }, "旅行ポータル　データ出力"), h("h1", null, title),
      h("p", null, `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")} 出力 ・ 参加者 ${ms.length}人`),
      h("ol", { class: "rp-toc" }, parts.map((k) => h("li", null, EXPORT_PARTS.find((x) => x.key === k)?.label)))),
    parts.map((k) => build[k]()));
}
// 管理者：アンケートの結果を印刷（PDF 保存もできる）。順位投票は順位表・何位に何票か・各自の順番、ふつうのアンケートは票数と回答者
async function printPollResult(p) {
  const votes = [...S.votes.values()].filter((v) => v.pollId === p.id && isTarget(p, v.uid));
  const first = (v) => ts(v.firstAt ?? v.at) || 0;
  votes.sort((a, b) => first(a) - first(b));
  const ms = pollTargets(p);
  const none = ms.filter((m) => !votes.some((v) => v.uid === m.id));
  const rank = isRankPoll(p);
  const d = pollDepth(p);
  const pts = pollScores(p, votes);
  const T = (headers, rows, cls = "") => h("table", { class: `rp-table ${cls}` }, h("thead", null, h("tr", null, headers.map((x) => h("th", null, x)))), h("tbody", null, rows.map((r) => h("tr", null, r.map((c) => h("td", null, c ?? ""))))));
  const bar = (v, max) => h("span", { class: "rp-bar" }, h("span", { style: `width:${max ? (v / max) * 100 : 0}%` }));
  const rows = p.options.map((o, i) => ({ o, i, pt: pts.get(o) ?? 0 })).sort((a, b) => b.pt - a.pt || a.i - b.i);
  const max = Math.max(0, ...rows.map((r) => r.pt));
  const blocks = [];
  if (rank) {
    // 何位に何人が入れたか（何位まであっても全部の列を出す。列が多いときは横向き・小さい文字にする）
    const placeCount = (o, k) => votes.filter((v) => (v.order ?? [])[k] === o).length;
    const places = [...Array(d).keys()];
    blocks.push(h("div", { class: "rp-block" }, h("h3", null, "順位（合計点の多い順）", h("small", null, `1位 ${d}点 … ${d}位 1点`)),
      T(["順位", "選択肢", "合計点", "", ...places.map((k) => `${k + 1}位`)],
        rows.map((r) => [`${1 + rows.filter((x) => x.pt > r.pt).length}位`, r.o, `${r.pt}点`, bar(r.pt, max),
          ...places.map((k) => placeCount(r.o, k) || "–")]), "rp-poll rp-rank")));
    if (!p.anonymous) {
      blocks.push(h("div", { class: "rp-block" }, h("h3", null, "各自の順番", h("small", null, "回答した順")),
        T(["#", "名前", ...places.map((k) => `${k + 1}位`)], votes.map((v, i) => [i + 1, memberName(v.uid), ...places.map((k) => (v.order ?? [])[k] ?? "")]), "rp-poll-each")));
    }
  } else {
    const n = votes.length || 1;
    blocks.push(h("div", { class: "rp-block" }, h("h3", null, "結果"),
      T(["選択肢", "人数", "割合", "", ...(p.anonymous ? [] : ["回答した人"])],
        rows.map((r) => [r.o, `${r.pt}人`, `${Math.round((r.pt / n) * 100)}%`, bar(r.pt, max), ...(p.anonymous ? [] : [votes.filter((v) => v.choice === r.o).map((v) => memberName(v.uid)).join("、")])]), "rp-poll")));
  }
  const coms = votes.filter((v) => v.comment);
  if (coms.length) blocks.push(h("div", { class: "rp-block" }, h("h3", null, "ひとこと"), T(p.anonymous ? ["ひとこと"] : ["名前", "ひとこと"], coms.map((v) => (p.anonymous ? [v.comment] : [memberName(v.uid), v.comment])))));
  if (!p.anonymous) blocks.push(h("div", { class: "rp-block" }, h("h3", null, `未回答（${none.length}人）`), h("p", { class: none.length ? "" : "rp-none" }, none.length ? none.map((m) => m.name).join("、") : "全員回答しました")));
  const meta = [
    S.config.title || APP_TITLE,
    rank ? `順位投票（${d}位まで）` : "アンケート",
    `回答 ${votes.length} / ${ms.length}人`,
    p.deadline ? `締切 ${fmtDeadline(p.deadline)}` : null,
    pollOpen(p) ? "受付中" : "締切済み",
    `印刷 ${new Date().toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })}`,
  ].filter(Boolean).join("　・　");
  // 列が多いときは横向きにして、文字を小さくする（全部の順位を1枚の幅に収める）
  const wide = rank && d > 6;
  const scale = !rank ? 1 : d <= 6 ? 1 : d <= 10 ? 0.9 : d <= 14 ? 0.78 : d <= 20 ? 0.66 : 0.56;
  const root = h("div", { id: "print-root", class: `print-report print-poll${wide ? " rp-wide" : ""}`, style: `--rp-scale:${scale}` },
    h("section", { class: "rp-sec" }, h("div", { class: "rp-kicker" }, "アンケート結果"), h("h1", { class: "rp-poll-title" }, p.question), h("p", { class: "rp-sub" }, meta), ...blocks));
  await printReport(root, `${p.question.slice(0, 30)}_結果`);
}
async function printReport(root, fileTitle) {
  const txt = root.textContent;
  await Promise.race([
    loadSerif().then((ok) => ok && document.fonts ? Promise.all(["400", "700"].map((w) => document.fonts.load(`${w} 12px "Noto Serif JP"`, txt))) : null).catch(() => {}),
    new Promise((r) => setTimeout(r, 6000)),
  ]);
  document.getElementById("print-root")?.remove();
  document.body.append(root);
  document.body.classList.add("printing");
  const prevTitle = document.title;
  document.title = fileTitle; // PDF に保存するときのファイル名
  const done = () => { root.remove(); document.body.classList.remove("printing"); document.title = prevTitle; window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.print();
}

async function exportPdf(parts) {
  if (!parts.length) return toast("出力する項目を選んでください", true);
  toast("PDF の準備中…");
  const root = exportBuild(parts);
  // 明朝体を、出力する文字の分だけ先に読み込んでおく（読み込み前に印刷するとゴシックになるため）。電波がなければ端末の明朝体で出す
  const txt = root.textContent;
  await Promise.race([
    loadSerif().then((ok) => ok && document.fonts ? Promise.all(["400", "700"].map((w) => document.fonts.load(`${w} 12px "Noto Serif JP"`, txt))) : null).catch(() => {}),
    new Promise((r) => setTimeout(r, 6000)),
  ]);
  document.getElementById("print-root")?.remove();
  document.body.append(root);
  document.body.classList.add("printing");
  const prevTitle = document.title;
  document.title = `${S.config.title || APP_TITLE}_データ`; // 保存するときのファイル名になる
  const done = () => { root.remove(); document.body.classList.remove("printing"); document.title = prevTitle; window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.print();
}
function exportBox() {
  const checks = new Map(EXPORT_PARTS.map((p) => [p.key, toggle(true)]));
  return group("データを PDF で出力", [
    ...EXPORT_PARTS.map((p) => field(p.label, checks.get(p.key))),
    h("button", { class: "cell cell-button", onclick: () => guard(null, () => exportPdf(EXPORT_PARTS.map((p) => p.key).filter((k) => checks.get(k).checked))) }, icon("note"), "PDF で出力（印刷画面 →「PDF に保存」）"),
  ], "この旅行のデータを、項目ごとにページを分けて出力します。印刷画面で「送信先：PDF に保存」（iPhone は共有ボタン →「プリント」→ 2本指で拡大 → 共有 →「ファイルに保存」）を選んでください。");
}

// ---------------------------------------------------------------- 画面の組み立て
//
// スマホ：下のタブで画面を切り替える
// PC（幅 1100px 以上）：お知らせ・チーム・ポイントを横に並べた1画面のダッシュボード。参加者と設定は小窓で開く

// sheet: 小窓で開く / desktopOnly: PC の列だけ / mobileOnly: スマホのタブだけ
// ---- 確定前ページ：旅行の割り当てと確定（管理者）
const tripMemberRef = (pid, uid) => (pid === ROOT ? doc(db, "members", uid) : doc(db, "profiles", pid, "members", uid));
async function confirmTrip(pid) {
  const ms = sortedMembers().filter((m) => tripsOf(m)[pid] === false);
  if (!ms.length) return;
  if (!confirm(`「${profileName(pid)}」を確定しますか？\n${ms.map((m) => m.name).join("・")}（${ms.length}人）が、この旅行のページを開けるようになります（開いている人はすぐ切り替わります）。`)) return;
  for (let i = 0; i < ms.length; i += 200) {
    const b = writeBatch(db);
    for (const m of ms.slice(i, i + 200)) {
      // 旅行の参加者に登録（すでに登録がある人は、名前などはそのまま）
      b.set(tripMemberRef(pid, m.id), { loginId: m.loginId ?? null, name: m.name ?? "" }, { merge: true });
      b.update(D("members", m.id), { [`trips.${pid}`]: true });
    }
    await b.commit();
  }
  toast(`「${profileName(pid)}」を確定しました（${ms.length}人）`);
}
function lobbyAssign({ withTitle = true } = {}) {
  const body = h("div");
  const el = h("div", null, withTitle ? largeTitle("旅行の割り当て") : null, body);
  // 割り当てる／外す（確定済みを外すと、その旅行のページが開けなくなる。旅行側の登録やデータは残る）
  const toggleTrip = (m, pid) => {
    const st = tripsOf(m)[pid];
    if (st === true && !confirm(`${m.name} の「${profileName(pid)}」の割り当てを外しますか？\n確定済みなので、この旅行のページが開けなくなります（旅行のデータや参加者の登録は残ります）。`)) return;
    fire(updateDoc(D("members", m.id), { [`trips.${pid}`]: st === undefined ? false : deleteField() }));
  };
  return {
    el,
    update() {
      const trips = sortedProfiles().filter((p) => p.id !== LOBBY);
      const ms = sortedMembers();
      const tripCard = (t) => {
        const as = ms.filter((m) => tripsOf(m)[t.id] !== undefined);
        const wait = as.filter((m) => tripsOf(m)[t.id] === false);
        return h("article", { class: "card trip-card" },
          h("div", { class: "trip-head" }, h("b", null, t.name), h("span", { class: "secondary" }, `${as.length}人（確定 ${as.length - wait.length}・未確定 ${wait.length}）`)),
          as.length ? h("div", { class: "trip-names" }, as.map((m) => h("span", { class: tripsOf(m)[t.id] ? "ok" : "wait" }, m.name))) : h("div", { class: "cell-sub" }, "まだ誰も割り当てていません"),
          h("button", { class: "btn-small", disabled: !wait.length, onclick: () => guard(null, () => confirmTrip(t.id)) }, wait.length ? `確定する（${wait.length}人）` : as.length ? "全員確定済み" : "確定する"));
      };
      const none = ms.filter((m) => !Object.keys(tripsOf(m)).length);
      setKids(body,
        trips.length ? trips.map(tripCard) : emptyState("flag", "旅行がありません", "「設定」→「新しい旅行を作る」で作れます。"),
        group(`未割り当て（${none.length}人）`, none.length ? cell(h("span", { class: "secondary" }, none.map((m) => m.name).join("・"))) : cell("全員割り当て済みです")),
        group("一人ずつ割り当てる", ms.length ? ms.map((m) => h("div", { class: "cell trip-row" },
          h("div", { class: "cell-main" }, h("b", null, m.name), h("div", { class: "cell-sub" }, m.loginId ?? "")),
          h("div", { class: "trip-pills" }, trips.map((t) => {
            const st = tripsOf(m)[t.id];
            return h("button", { class: `trip-pill${st === true ? " ok" : st === false ? " wait" : ""}`, title: st === true ? "確定済み（押すと外す）" : st === false ? "割り当て済み・未確定（押すと外す）" : "押すと割り当て", onclick: () => toggleTrip(m, t.id) },
              st === true ? "✓ " : st === false ? "● " : "＋ ", t.name);
          })))) : cell("参加者がいません（「参加者」から追加できます）"),
        "旅行の名前を押すと割り当て（●）、もう一度押すと外します。割り当てただけでは変わらず、旅行ごとの「確定する」を押すと、その旅行に割り当てた未確定の人が一斉に旅行のページを開けるようになります（✓）。旅行はいくつでも割り当てられ、確定後に追加・取り消しもできます。確定前ページのお知らせ・出欠・集金は、確定後も旅行のページに表示されます。"));
    },
  };
}
const LOBBY_MEMBER_TABS = [
  { key: "home", icon: "megaphone", label: "お知らせ", view: memberHome },
  { key: "money", icon: "check", label: "出欠・集金", view: memberMoney },
  { key: "videos", icon: "play", label: "過去動画", view: memberVideos },
  { key: "chat", icon: "chat", label: "チャット", view: chatView, sheet: true },
  { key: "settings", icon: "gear", label: "設定", view: settingsView, sheet: true },
];
const LOBBY_ADMIN_TABS = [
  { key: "home", icon: "megaphone", label: "お知らせ", view: adminAnnouncements },
  { key: "assign", icon: "flag", label: "旅行の割り当て", view: lobbyAssign },
  { key: "side", icon: "people", label: "参加者", view: adminMembers, desktopOnly: true },
  { key: "members", icon: "people", label: "参加者", view: adminMembers, mobileOnly: true },
  { key: "money", icon: "check", label: "出欠・集金", view: adminMoney, sheet: true },
  { key: "videos", icon: "play", label: "過去動画", view: adminVideos, sheet: true },
  { key: "chat", icon: "chat", label: "チャット", view: chatView, sheet: true },
  { key: "settings", icon: "gear", label: "設定", view: settingsView, sheet: true },
];

const MEMBER_TABS = [
  { key: "home", icon: "megaphone", label: "お知らせ", view: memberHome },
  { key: "team", icon: "flag", label: "チーム", view: memberTeam },
  { key: "points", icon: "trophy", label: "ポイント", view: memberPoints },
  { key: "notes", icon: "note", label: "表・メモ", view: () => notesView() },
  { key: "money", icon: "check", label: "出欠・集金", view: memberMoney, sheet: true, desktopOnly: true }, // スマホは1ページの中の欄
  { key: "checklist", icon: "list", label: "チェック", view: checklistMember, sheet: true, desktopOnly: true },
  { key: "chat", icon: "chat", label: "チャット", view: chatView, sheet: true },
  { key: "map", icon: "map", label: "地図", view: mapView, sheet: true },
  { key: "settings", icon: "gear", label: "設定", view: settingsView, sheet: true },
];
const ADMIN_TABS = [
  { key: "home", icon: "megaphone", label: "お知らせ", view: adminAnnouncements },
  { key: "team", icon: "flag", label: "チーム", view: adminTeams },
  { key: "points", icon: "trophy", label: "ポイント", view: adminPoints },
  { key: "side", icon: "note", label: "表・メモ", backLabel: "表・メモ・参加者", view: adminSide, desktopOnly: true },
  { key: "notes", icon: "note", label: "表・メモ", view: () => notesView({ admin: true }), mobileOnly: true },
  { key: "members", icon: "people", label: "参加者", view: adminMembers, mobileOnly: true },
  { key: "quiz", icon: "quiz", label: "クイズ", view: quizManager, sheet: true },
  { key: "money", icon: "check", label: "出欠・集金", view: adminMoney, sheet: true },
  { key: "checklist", icon: "list", label: "チェック", view: checklistAdmin, sheet: true },
  { key: "chat", icon: "chat", label: "チャット", view: chatView, sheet: true },
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
  const gears = h("div", { class: "nav-left" }, sheetTabs.map((t) => h("button", { class: "nav-gear", "data-sheet": t.key, "aria-label": t.label, onclick: () => openSheet(t) }, icon(t.icon))), refreshButton());
  const header = h("header", { class: "navbar" }, gears, navTitle, S.isAdmin ? h("span", { class: "badge" }, adminName(S.user.email)) : chip);
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

// 管理者の PC 画面：左にお知らせ・チーム、右半分は1つの大きな欄（ふだんは表・メモ／参加者）。
// 上部の「ポイント」「出欠・集金」「チェック」「チャット」「設定」は、小窓ではなく右半分の欄に出す（クイズ・地図は小窓のまま）
const DESK_SIDE_KEYS = new Set(["points", "money", "videos", "checklist", "chat", "settings"]);
let deskSideOpen = null; // buildDesktopShell が設定する（右の欄に出したら true を返す）
function openSheet(tab) {
  if (deskSideOpen?.(tab)) return;
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
  // 管理者は「ポイント」を列に並べず、上部のボタンから右半分の欄に出す
  const wide = S.isAdmin;
  const panels = tabs.filter((t) => !t.sheet && !t.mobileOnly && !(wide && t.key === "points"));
  const topTabs = wide ? [...tabs.filter((t) => t.key === "points"), ...tabs.filter((t) => t.sheet)] : tabs.filter((t) => t.sheet);
  const views = panels.map((t) => t.view());
  const title = profileSwitcher("desk-title");
  const status = statusBar();
  const chip = S.isAdmin || inLobby() ? null : meChip();
  const actions = h("div", { class: "desk-actions" },
    topTabs.map((t) => h("button", { class: "desk-btn", "data-sheet": t.key, onclick: () => openSheet(t) }, icon(t.icon), t.label)), refreshButton("desk"));
  const header = h("header", { class: "desk-bar" },
    h("img", { class: "desk-icon", src: "icon-192.png", alt: "" }), title,
    S.isAdmin ? h("span", { class: "badge static" }, adminName(S.user.email)) : null,
    status, h("div", { class: "desk-right" }, chip, actions));
  const sections = views.map((v, i) => h("section", { class: "panel", "data-panel": panels[i].key }, v.el));
  const grid = h("main", { class: `desk-grid cols-${panels.length}${wide ? " admin-wide" : ""}` }, sections);
  // 管理者：一番右の欄（表・メモ／参加者）を、上部のボタンで選んだ画面に切り替える
  const sideIdx = S.isAdmin ? panels.length - 1 : -1;
  let sideTab = null, sideView = null;
  const paintSide = () => {
    const sec = sections[sideIdx];
    if (sideTab) setKids(sec, h("div", { class: "side-head" }, h("h2", null, sideTab.label),
      h("button", { class: "text-btn", onclick: () => showInSide(null) }, `${panels[sideIdx].backLabel ?? panels[sideIdx].label}に戻る`)), h("div", { class: "side-view" }, sideView.el));
    else setKids(sec, views[sideIdx].el);
    sec.scrollTop = 0;
    for (const b of actions.querySelectorAll(".desk-btn")) b.classList.toggle("on", b.dataset.sheet === sideTab?.key);
  };
  function showInSide(t) {
    sideView?.destroy?.();
    if (!t || sideTab?.key === t.key) { sideTab = null; sideView = null; } // もう一度押すと元に戻る
    else { closeSheet(); sideTab = t; sideView = t.view({ withTitle: false }); }
    paintSide();
    scheduleRender();
  }
  deskSideOpen = sideIdx >= 0 ? (t) => { if (!DESK_SIDE_KEYS.has(t.key)) return false; showInSide(t); return true; } : null;
  // 参加者：受付中のアンケートと、期限内・未入金の集金を画面の一番上に出す
  const payTop = S.isAdmin || inLobby() ? null : memberMoney({ pinned: "only" });
  const root = h("div", { class: "desk" }, header, payTop ? h("div", { class: "desk-paytop" }, payTop.top) : null, grid);
  return {
    root,
    update() {
      title.paint();
      paintStatus(status);
      chip?.paint();
      views.forEach((v, i) => { if (i !== sideIdx || !sideTab) v.update(); });
      sideView?.update();
      payTop?.update();
      paintSheet();
    },
  };
}

// 更新ボタン：新しい版があれば取り込み、なければそのまま読み込み直す
function refreshButton(kind = "nav") {
  return h("button", { class: kind === "desk" ? "desk-btn desk-refresh" : "nav-gear nav-refresh", title: "更新", "aria-label": "更新", onclick: (e) => refreshApp(e.currentTarget) }, icon("refresh"));
}
async function refreshApp(btn) {
  btn?.classList.add("spinning");
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    await Promise.race([reg?.update(), new Promise((r) => setTimeout(r, 3000))]);
    // 新しい版を入れている途中なら、入れ替わったところで自動で読み直される（下の controllerchange）。少し待っても来なければ読み直す
    if (reg?.installing || reg?.waiting) { setTimeout(() => location.reload(), 4000); return; }
  } catch { /* 確認できなくても読み直す */ }
  location.reload();
}

// 参加者のスマホ：タブを使わず1ページにまとめる。上部のボタンで各セクションへ移動する
function buildMemberPageShell() {
  const lobby = inLobby();
  const sections = lobby ? [
    { key: "home", label: "お知らせ", view: memberHome({ compact: true }) },
    { key: "money", label: "出欠・集金", view: memberMoney({ compact: true, pinned: "split" }) },
    { key: "videos", label: "過去動画", view: memberVideos({ compact: true }) },
  ] : [
    { key: "home", label: "お知らせ", view: memberHome({ compact: true }) },
    { key: "team", label: "チーム", view: memberTeam({ compact: true }) },
    { key: "points", label: "ポイント", view: memberPoints({ compact: true }) },
    { key: "notes", label: "表・メモ", view: notesView({ compact: true }) },
    { key: "money", label: "出欠", view: memberMoney({ compact: true, pinned: "split" }) }, // 上部のボタンは短く（見出しは「出欠・集金」）
    { key: "checklist", label: "チェック", view: checklistMember({ compact: true }) },
  ];
  const summary = memberSummary();
  const chip = lobby ? null : meChip();
  const navTitle = h("div", { class: "nav-title" });
  const gear = h("div", { class: "nav-left" }, (lobby ? LOBBY_MEMBER_TABS : MEMBER_TABS).filter((t) => t.sheet && !t.desktopOnly).map((t) =>
    h("button", { class: "nav-gear", "data-sheet": t.key, "aria-label": t.label, onclick: () => openSheet(t) }, icon(t.icon))), refreshButton());
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
  const payTop = sections.find((x) => x.key === "money").view.top;
  const root = h("div", { class: "shell single" }, header, h("div", { class: "page" }, title, status, summary.el, payTop, jump, main));

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
      chip?.paint();
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
  if (ptPending) setTimeout(maybeClaimPt, 0);
  if (!S.authReady) return;
  // 位置・クイズだけが変わったときは、開いている小窓とクイズの画面だけ描き直す
  if (kinds && !kinds.has("all") && shell && S.user) {
    if ((kinds.has("loc") && S.sheet?.key === "map") || (kinds.has("quiz") && S.sheet?.key === "quiz") || (kinds.has("chat") && S.sheet?.key === "chat")) S.sheet.view.update();
    if (kinds.has("chat")) paintChatBadges();
    if (kinds.has("quiz")) paintQuizLive();
    if (kinds.has("status")) document.querySelectorAll(".status").forEach(paintStatus);
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
        emptyState("lock", "このアカウントは使えません",
          S.meErr
            ? `ID「${emailToId(S.user.email)}」の登録を確認できませんでした（${S.meErr === "unavailable" ? "電波がありません" : S.meErr}）。電波のある所で「もう一度試す」を押してください。`
            : `ID「${emailToId(S.user.email)}」は、どの旅行の参加者にも登録されていません（参加者から削除された可能性があります）。管理者に確認してください。`),
        h("button", { class: "btn-filled", onclick: () => location.reload() }, "もう一度試す"),
        h("button", { class: "btn-filled ghost-btn", onclick: () => signOut(auth) }, "ログアウト（別のIDで入る）")));
    }
  }
  if (!shell) {
    closeSheet();
    deskSideOpen = null;
    const lobby = inLobby();
    if (desktopQuery.matches) shell = buildDesktopShell(S.isAdmin ? (lobby ? LOBBY_ADMIN_TABS : ADMIN_TABS) : (lobby ? LOBBY_MEMBER_TABS : MEMBER_TABS));
    else shell = S.isAdmin ? buildMobileShell(lobby ? LOBBY_ADMIN_TABS : ADMIN_TABS) : buildMemberPageShell();
    $app.replaceChildren(shell.root);
  }
  document.title = S.config.title || APP_TITLE;
  shell.update();
  paintMapButtons();
  paintChatBadges();
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
