// firestore.rules のテスト。実行方法は README.md を参照
//   cd tests && npm install && npm test
import fs from "node:fs";
import assert from "node:assert/strict";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, getDocs, query, where, serverTimestamp, runTransaction, increment } from "firebase/firestore";

const env = await initializeTestEnvironment({
  projectId: "demo-island",
  firestore: { rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 },
});

const as = (uid, email = `${uid}@island.example.com`) => env.authenticatedContext(uid, { email }).firestore();
const admin = () => as("adminUid", "admin1@island.example.com");
const alice = () => as("alice");   // 1つ目の旅行（ルート）と P2 の両方に参加
const bob = () => as("bob");       // 1つ目の旅行だけ
const carol = () => as("carol");   // P2 だけ
const outsider = () => as("hacker");

await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "members/alice"), { loginId: "user01", name: "Alice" });
  await setDoc(doc(db, "members/bob"), { loginId: "user02", name: "Bob" });
  await setDoc(doc(db, "profiles/root"), { name: "七日島" });
  await setDoc(doc(db, "profiles/P2"), { name: "夏の旅行" });
  await setDoc(doc(db, "profiles/P2/members/alice"), { loginId: "user01", name: "Alice" });
  await setDoc(doc(db, "profiles/P2/members/carol"), { loginId: "user03", name: "Carol" });
  await setDoc(doc(db, "announcements/a1"), { title: "root のお知らせ", scope: "all" });
  await setDoc(doc(db, "profiles/P2/announcements/b1"), { title: "P2 のお知らせ", scope: "all" });
  await setDoc(doc(db, "acks/a1_bob"), { annId: "a1", uid: "bob", at: serverTimestamp() });
  await setDoc(doc(db, "accounts/user01"), { uid: "alice" });
});

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["NG", name, e.message]); }
}

// ----- 読み取り
await test("参加者：自分の旅行のデータを読める（ルート）", () => assertSucceeds(getDocs(collection(bob(), "announcements"))));
await test("参加者：自分の旅行のデータを読める（P2）", () => assertSucceeds(getDocs(collection(carol(), "profiles/P2/announcements"))));
await test("参加者：入っていない旅行は読めない（bob → P2）", () => assertFails(getDocs(collection(bob(), "profiles/P2/announcements"))));
await test("参加者：入っていない旅行は読めない（carol → ルート）", () => assertFails(getDocs(collection(carol(), "announcements"))));
await test("参加者：自分の members は読める（どの旅行に入っているか調べる）", async () => {
  await assertSucceeds(getDoc(doc(carol(), "members/carol")));
  await assertSucceeds(getDoc(doc(bob(), "profiles/P2/members/bob")));
});
await test("ログインしていれば旅行の一覧は読める", () => assertSucceeds(getDocs(collection(carol(), "profiles"))));
await test("部外者：旅行のデータは読めない", async () => {
  await assertFails(getDocs(collection(outsider(), "announcements")));
  await assertFails(getDocs(collection(outsider(), "profiles/P2/announcements")));
});
await test("未ログイン：何も読めない", async () => {
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), "announcements")));
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), "profiles")));
});
await test("参加者：アカウント一覧は読めない", () => assertFails(getDoc(doc(alice(), "accounts/user01"))));

// ----- 書き込み（参加者は uid が自分のものだけ）
await test("参加者：自分の『見ました』を書ける", () => assertSucceeds(setDoc(doc(alice(), "acks/a1_alice"), { annId: "a1", uid: "alice", at: serverTimestamp() })));
await test("参加者：自分の位置を書ける（P2）", () => assertSucceeds(setDoc(doc(carol(), "profiles/P2/locations/carol"), { uid: "carol", lat: 1, lng: 2, at: serverTimestamp() })));
await test("参加者：時刻をすり替えて書けない（サーバーの時刻だけ）", async () => {
  await assertFails(setDoc(doc(alice(), "acks/a9_alice"), { annId: "a9", uid: "alice", at: new Date("2020-01-01") }));
  await assertFails(setDoc(doc(carol(), "profiles/P2/locations/carol"), { uid: "carol", lat: 1, lng: 2, at: new Date(Date.now() + 864e5) }));
  await assertFails(addDoc(collection(bob(), "messages"), { uid: "bob", chat: "all", text: "先頭に出したい", at: new Date("2099-01-01") }));
  await assertSucceeds(addDoc(collection(bob(), "messages"), { uid: "bob", chat: "all", text: "ふつう", at: serverTimestamp() }));
});
await test("参加者：ありえない位置・大きすぎる値は書けない", async () => {
  await assertFails(setDoc(doc(carol(), "profiles/P2/locations/carol"), { uid: "carol", lat: 999, lng: 2, at: serverTimestamp() }));
  await assertFails(setDoc(doc(carol(), "profiles/P2/locations/carol"), { uid: "carol", lat: "北", lng: 2, at: serverTimestamp() }));
});
await test("参加者：他人になりすまして書けない", () => assertFails(setDoc(doc(alice(), "acks/a1_bob2"), { annId: "a1", uid: "bob" })));
await test("参加者：他人の記録は消せない", () => assertFails(deleteDoc(doc(alice(), "acks/a1_bob"))));
await test("参加者：自分の記録は消せる", () => assertSucceeds(deleteDoc(doc(alice(), "acks/a1_alice"))));
await test("参加者：お知らせを書けない", () => assertFails(setDoc(doc(bob(), "announcements/x"), { title: "x" })));
await test("参加者：ポイントを書けない", () => assertFails(setDoc(doc(bob(), "pointLogs/x"), { delta: 100, target: "bob" })));
await test("参加者：uid 付きでも入っていない旅行には書けない", () => assertFails(setDoc(doc(bob(), "profiles/P2/acks/b1_bob"), { uid: "bob" })));
await test("参加者：旅行を作れない", () => assertFails(setDoc(doc(alice(), "profiles/P3"), { name: "x", uid: "alice" })));
await test("参加者：自分を勝手に旅行に追加できない", () => assertFails(setDoc(doc(bob(), "profiles/P2/members/bob"), { name: "Bob", uid: "bob" })));
await test("部外者：uid 付きでも書けない", () => assertFails(setDoc(doc(outsider(), "acks/a1_hacker"), { uid: "hacker" })));
await test("管理者3：管理者として書ける", () => assertSucceeds(setDoc(doc(as("admin3Uid", "admin3@island.example.com"), "announcements/y"), { title: "y" })));
await test("偽管理者：admin4 は管理者扱いされない", () => assertFails(setDoc(doc(as("fake4", "admin4@island.example.com"), "announcements/z"), { title: "z" })));
await test("偽管理者：別ドメインの admin1 は管理者扱いされない", () => assertFails(setDoc(doc(as("fake", "admin1@evil.example.com"), "announcements/x"), { title: "x" })));

// ----- 管理者
await test("管理者：どの旅行も読み書きできる", async () => {
  await assertSucceeds(setDoc(doc(admin(), "announcements/x"), { title: "x" }));
  await assertSucceeds(setDoc(doc(admin(), "profiles/P2/teams/t1"), { name: "A" }));
  await assertSucceeds(setDoc(doc(admin(), "profiles/P3"), { name: "冬の旅行" }));
  await assertSucceeds(getDocs(collection(admin(), "profiles/P2/members")));
});
await test("管理者：アカウント一覧を読み書きできる", () => assertSucceeds(setDoc(doc(admin(), "accounts/user03"), { uid: "carol" })));
await test("管理者：新しい種類のデータも書ける（ルールの書き直し不要）", () => assertSucceeds(setDoc(doc(admin(), "profiles/P2/somethingNew/z"), { a: 1 })));

// ===== 2026-10 の強化：参加者が「uid 付き」なら何でも書けた穴をふさいだ =====
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "payments/pay1"), { title: "フェリー代", amount: 3000, targets: null, records: {} });
  await setDoc(doc(db, "polls/poll1"), { question: "BBQ", options: ["行く", "行かない"], open: true, targets: null });
  await setDoc(doc(db, "polls/pollClosed"), { question: "締切", options: ["A"], open: false, targets: null });
  await setDoc(doc(db, "polls/pollAliceOnly"), { question: "限定", options: ["A"], open: true, targets: ["alice"] });
  await setDoc(doc(db, "notes/pub"), { title: "公開", shared: true });
  await setDoc(doc(db, "notes/secret"), { title: "管理者用", shared: false });
  await setDoc(doc(db, "teamSets/s1"), { name: "1日目", published: true });
  await setDoc(doc(db, "teamSets/s2"), { name: "2日目（未発表）", published: false });
  await setDoc(doc(db, "teams/tA"), { name: "赤", setId: "s1", published: true });
  await setDoc(doc(db, "memberships/tA_bob"), { teamId: "tA", uid: "bob", setId: "s1", published: true, hidden: false });
  await setDoc(doc(db, "memberships/tB_alice"), { teamId: "tB", uid: "alice", setId: "s1", published: true, hidden: true }); // スパイの本当のチーム
  await setDoc(doc(db, "allocs/r1"), { kind: "room", name: "201", members: ["bob"], published: false });
  await setDoc(doc(db, "ptQrs/qr1"), { title: "宝探し", points: 10, kind: "user", active: true });
  await setDoc(doc(db, "ptQrs/qrTeam"), { title: "チーム宝", points: 5, kind: "team", setId: "s1", active: true });
  await setDoc(doc(db, "ptQrs/qrOff"), { title: "停止中", points: 99, kind: "user", active: false });
  await setDoc(doc(db, "stats/points"), { u: {}, t: {} });
  await setDoc(doc(db, "payReports/pay1_alice"), { uid: "alice", paymentId: "pay1", method: "現金" });
  await setDoc(doc(db, "pushSubs/x_alice"), { uid: "alice", sub: { endpoint: "https://e/1" } });
  await setDoc(doc(db, "memberAttrs/bob"), { values: { sex: "男" } });
  await setDoc(doc(db, "expenses/e_alice"), { uid: "alice", kind: "expense", payer: "alice", title: "食材", amount: 1000, split: null });
});
const now = serverTimestamp();
// 穴だった書き込み
await test("【穴】参加者：uid を付けてもお知らせを作れない", () => assertFails(setDoc(doc(bob(), "announcements/fake"), { title: "偽のお知らせ", scope: "all", uid: "bob" })));
await test("【穴】参加者：uid を付けても集金を自分だけ入金済みにできない", () => assertFails(updateDoc(doc(bob(), "payments/pay1"), { uid: "bob", "records.bob": { status: "paid" } })));
await test("【穴】参加者：uid を付けてもアンケートを作れない", () => assertFails(setDoc(doc(bob(), "polls/fake"), { question: "x", options: ["a"], uid: "bob" })));
await test("【穴】参加者：uid を付けてもポイントを好きに足せない", () => assertFails(setDoc(doc(bob(), "pointLogs/fake"), { kind: "user", target: "bob", delta: 1000, uid: "bob", author: "QR", visibility: "public", reason: "x", qrId: "qr1" })));
await test("【穴】参加者：uid を付けてもメモ・チーム・参加者を書き換えられない", async () => {
  await assertFails(setDoc(doc(bob(), "notes/pub"), { title: "改ざん", shared: true, uid: "bob" }));
  await assertFails(setDoc(doc(bob(), "teams/tA"), { name: "乗っ取り", uid: "bob" }));
  await assertFails(updateDoc(doc(bob(), "members/bob"), { name: "なりすまし", uid: "bob" }));
});
// 決まった形なら書ける
await test("参加者：アンケートに答えられる・答え直せる", async () => {
  await assertSucceeds(setDoc(doc(bob(), "votes/poll1_bob"), { uid: "bob", pollId: "poll1", choice: "行く", comment: "", at: now, firstAt: now }));
  await assertSucceeds(setDoc(doc(bob(), "votes/poll1_bob"), { uid: "bob", pollId: "poll1", choice: "行かない", comment: "やっぱり", at: now, firstAt: now }));
});
await test("参加者：締め切ったアンケート・対象外のアンケートには答えられない", async () => {
  await assertFails(setDoc(doc(bob(), "votes/pollClosed_bob"), { uid: "bob", pollId: "pollClosed", choice: "A", at: now }));
  await assertFails(setDoc(doc(bob(), "votes/pollAliceOnly_bob"), { uid: "bob", pollId: "pollAliceOnly", choice: "A", at: now }));
});
await test("参加者：他人の回答の id では答えられない・余計な欄は付けられない", async () => {
  await assertFails(setDoc(doc(bob(), "votes/poll1_alice"), { uid: "bob", pollId: "poll1", choice: "行く", at: now }));
  await assertFails(setDoc(doc(bob(), "votes/poll1_bob"), { uid: "bob", pollId: "poll1", choice: "行く", at: now, byAdmin: true }));
});
await test("参加者：入金の報告はできるが、他人の分・ない集金にはできない", async () => {
  await assertSucceeds(setDoc(doc(bob(), "payReports/pay1_bob"), { uid: "bob", paymentId: "pay1", method: "PayPay", note: "", image: null, at: now }));
  await assertFails(setDoc(doc(bob(), "payReports/pay1_alice"), { uid: "bob", paymentId: "pay1", method: "PayPay", at: now }));
  await assertFails(setDoc(doc(bob(), "payReports/none_bob"), { uid: "bob", paymentId: "none", method: "PayPay", at: now }));
});
await test("参加者：アンケートの申請は「申請中」でしか作れない", async () => {
  await assertSucceeds(setDoc(doc(bob(), "pollRequests/r1"), { uid: "bob", question: "Q", options: ["a", "b"], deadline: null, allowComment: true, showResults: true, showName: true, status: "pending", createdAt: now }));
  await assertFails(setDoc(doc(bob(), "pollRequests/r2"), { uid: "bob", question: "Q", options: ["a", "b"], status: "approved", createdAt: now }));
  await assertFails(updateDoc(doc(bob(), "pollRequests/r1"), { status: "approved" }));
});
await test("参加者：チャットは全体・自分のチーム・自分の DM だけに書ける", async () => {
  await assertSucceeds(setDoc(doc(bob(), "messages/m1"), { uid: "bob", chat: "all", text: "こんにちは", at: now }));
  await assertSucceeds(setDoc(doc(bob(), "messages/m2"), { uid: "bob", chat: "team:tA", text: "作戦", at: now }));
  await assertSucceeds(setDoc(doc(bob(), "dms/m3"), { uid: "bob", chat: "admin:bob", parties: ["bob"], text: "質問", at: now }));
  await assertSucceeds(setDoc(doc(bob(), "dms/m4"), { uid: "bob", chat: "dm:alice_bob", parties: ["alice", "bob"], text: "やあ", at: now }));
  await assertFails(setDoc(doc(bob(), "messages/m4b"), { uid: "bob", chat: "dm:alice_bob", parties: ["alice", "bob"], text: "DM は messages に置けない", at: now }));
  await assertFails(setDoc(doc(bob(), "messages/m5"), { uid: "bob", chat: "team:tB", text: "よそのチーム", at: now }));
  await assertFails(setDoc(doc(bob(), "dms/m6"), { uid: "bob", chat: "admin:alice", parties: ["alice"], text: "なりすまし", at: now }));
  await assertFails(setDoc(doc(bob(), "dms/m7"), { uid: "bob", chat: "dm:alice_carol", parties: ["alice", "carol"], text: "割り込み", at: now }));
  await assertFails(setDoc(doc(bob(), "messages/m8"), { uid: "bob", chat: "all", text: "管理者のふり", from: "管理者1", at: now }));
});
await test("参加者：立て替えは自分が払った分だけ・他人の記録は消せない", async () => {
  await assertSucceeds(setDoc(doc(bob(), "expenses/e1"), { uid: "bob", kind: "expense", payer: "bob", title: "氷", amount: 500, split: null, createdAt: now }));
  await assertFails(setDoc(doc(bob(), "expenses/e2"), { uid: "bob", kind: "expense", payer: "alice", title: "氷", amount: 500, split: null, createdAt: now }));
  await assertFails(setDoc(doc(bob(), "expenses/e3"), { uid: "bob", kind: "settle", from: "alice", to: "bob", amount: 500, createdAt: now }));
  await assertFails(deleteDoc(doc(bob(), "expenses/e_alice")));
});
await test("参加者：QR を読み取ると、決まった点数だけ自分に入る（1回だけ）", async () => {
  const db = bob();
  await assertSucceeds(runTransaction(db, async (tx) => {
    await tx.get(doc(db, "ptQrs/qr1"));
    tx.set(doc(db, "ptClaims/qr1_u_bob"), { uid: "bob", qrId: "qr1", at: now });
    tx.set(doc(db, "pointLogs/l1"), { kind: "user", target: "bob", teamId: null, visibility: "public", delta: 10, reason: "QR「宝探し」", createdAt: now, author: "QR", uid: "bob", qrId: "qr1" });
    tx.set(doc(db, "stats/points"), { u: { bob: { public: increment(10) } }, uid: "bob", qrId: "qr1" }, { merge: true });
  }));
  // 2回目（受け取り済み）・点数の水増し・停止中の QR はだめ
  await assertFails(setDoc(doc(db, "pointLogs/l2"), { kind: "user", target: "bob", teamId: null, visibility: "public", delta: 10, reason: "x", createdAt: now, author: "QR", uid: "bob", qrId: "qr1" }));
  await assertFails(runTransaction(db, async (tx) => {
    tx.set(doc(db, "ptClaims/qrTeam_u_bob"), { uid: "bob", qrId: "qrTeam", at: now });
    tx.set(doc(db, "pointLogs/l3"), { kind: "user", target: "bob", teamId: null, visibility: "public", delta: 500, reason: "x", createdAt: now, author: "QR", uid: "bob", qrId: "qrTeam" });
  }));
  await assertFails(setDoc(doc(db, "ptClaims/qrOff_u_bob"), { uid: "bob", qrId: "qrOff", at: now }));
});
await test("参加者：チームの QR は自分のチームにだけ入る", async () => {
  const db = bob();
  await assertFails(runTransaction(db, async (tx) => {
    tx.set(doc(db, "ptClaims/qrTeam_u_bob"), { uid: "bob", qrId: "qrTeam", at: now });
    tx.set(doc(db, "pointLogs/l4"), { kind: "team", target: "tB", teamId: "tB", contributor: "bob", visibility: "public", delta: 5, reason: "x", createdAt: now, author: "QR", uid: "bob", qrId: "qrTeam" });
  }));
  await assertSucceeds(runTransaction(db, async (tx) => {
    tx.set(doc(db, "ptClaims/qrTeam_u_bob"), { uid: "bob", qrId: "qrTeam", at: now });
    tx.set(doc(db, "pointLogs/l5"), { kind: "team", target: "tA", teamId: "tA", contributor: "bob", visibility: "public", delta: 5, reason: "x", createdAt: now, author: "QR", uid: "bob", qrId: "qrTeam" });
  }));
});
await test("参加者：合計（stats）は QR を受け取るときしか書けない", () => assertFails(setDoc(doc(bob(), "stats/points"), { u: { bob: { public: 9999 } }, uid: "bob", qrId: "qr1" }, { merge: true })));
await test("参加者：クイズの解答に正誤（judge）は書けない", async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "live/quiz"), { quizId: "q1", index: 0, phase: "question" }));
  await assertSucceeds(setDoc(doc(bob(), "quizAnswers/q1_0_bob"), { uid: "bob", quizId: "q1", index: 0, choice: 1, reactionMs: 800, at: serverTimestamp() }));
  await assertFails(updateDoc(doc(bob(), "quizAnswers/q1_0_bob"), { judge: true }));
  await assertSucceeds(updateDoc(doc(bob(), "quizAnswers/q1_0_bob"), { text: "答え", textMs: 1200 }));
  await assertFails(setDoc(doc(bob(), "quizAnswers/q1_1_bob"), { uid: "bob", quizId: "q1", index: 1, choice: 1, judge: true }));
});
await test("参加者：正解の発表後・ほかの問題には、クイズの答えを書き換えられない", async () => {
  await assertFails(setDoc(doc(bob(), "quizAnswers/q1_3_bob"), { uid: "bob", quizId: "q1", index: 3, choice: 2, reactionMs: 100, at: serverTimestamp() })); // 今出ていない問題
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "live/quiz"), { quizId: "q1", index: 0, phase: "reveal", answerShown: true, answer: 2 }));
  await assertFails(setDoc(doc(bob(), "quizAnswers/q1_0_bob"), { uid: "bob", quizId: "q1", index: 0, choice: 2, reactionMs: 800, at: serverTimestamp() }));
  await assertFails(updateDoc(doc(bob(), "quizAnswers/q1_0_bob"), { choice: 2 }));
  await assertSucceeds(updateDoc(doc(bob(), "quizAnswers/q1_0_bob"), { timeout: true })); // 自分の時間切れは付けられる
});
await test("参加者：妨害・賭けは「申し込み中」でしか作れない", async () => {
  await assertSucceeds(setDoc(doc(bob(), "quizSabo/s1"), { uid: "bob", quizId: "q1", run: 1, forIndex: 0, target: "alice", type: "seal", at: now, status: "pending" }));
  await assertFails(setDoc(doc(bob(), "quizSabo/s2"), { uid: "bob", quizId: "q1", run: 1, forIndex: 0, target: "alice", type: "seal", at: now, status: "ok" }));
  await assertFails(updateDoc(doc(bob(), "quizSabo/s1"), { status: "ok" }));
});
// 読む
await test("参加者：非公開のメモは読めない（公開のメモは読める）", async () => {
  await assertSucceeds(getDoc(doc(bob(), "notes/pub")));
  await assertFails(getDoc(doc(bob(), "notes/secret")));
  await assertFails(getDocs(collection(bob(), "notes")));
  await assertSucceeds(getDocs(query(collection(bob(), "notes"), where("shared", "==", true))));
});
await test("参加者：発表前のチーム表・部屋割りは読めない", async () => {
  await assertFails(getDoc(doc(bob(), "teamSets/s2")));
  await assertSucceeds(getDocs(query(collection(bob(), "teamSets"), where("published", "==", true))));
  await assertFails(getDoc(doc(bob(), "allocs/r1")));
});
await test("参加者：スパイの本当のチームは本人しか読めない", async () => {
  await assertFails(getDoc(doc(bob(), "memberships/tB_alice")));
  await assertSucceeds(getDoc(doc(alice(), "memberships/tB_alice")));
  await assertSucceeds(getDocs(query(collection(bob(), "memberships"), where("published", "==", true), where("hidden", "==", false))));
  await assertSucceeds(getDocs(query(collection(alice(), "memberships"), where("published", "==", true), where("uid", "==", "alice"))));
});
await test("参加者：他人の入金報告・通知の宛先・属性は読めない", async () => {
  await assertFails(getDoc(doc(bob(), "payReports/pay1_alice")));
  await assertFails(getDoc(doc(bob(), "pushSubs/x_alice")));
  await assertFails(getDoc(doc(bob(), "memberAttrs/bob")));
  await assertSucceeds(getDoc(doc(alice(), "payReports/pay1_alice")));
});
await test("参加者：DM は当人どうしだけが読める（管理者は読める）", async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "dms/secret"), { uid: "alice", chat: "dm:alice_carol", parties: ["alice", "carol"], text: "ないしょ" }));
  await assertFails(getDoc(doc(bob(), "dms/secret")));
  await assertFails(getDocs(query(collection(bob(), "dms"), where("chat", "==", "dm:alice_carol"))));
  await assertSucceeds(getDocs(query(collection(bob(), "dms"), where("parties", "array-contains", "bob"))));
  await assertSucceeds(getDocs(query(collection(alice(), "dms"), where("chat", "==", "dm:alice_carol"), where("parties", "array-contains", "alice"))));
  await assertSucceeds(getDocs(collection(admin(), "dms")));
});
await test("参加者：クイズの問題と正解は読めない", async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "quizzes/q1"), { title: "島クイズ", questions: [{ q: "1+1", answer: 2 }] }));
  await assertFails(getDoc(doc(bob(), "quizzes/q1")));
});
await test("確定前ページの人：確定していない旅行は読めない・確定したら読める", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "members/dave"), { name: "Dave" });
    await setDoc(doc(db, "profiles/lobby/members/dave"), { name: "Dave", trips: { root: false } });
  });
  await assertFails(getDocs(collection(as("dave"), "announcements")));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "profiles/lobby/members/dave"), { name: "Dave", trips: { root: true } }));
  await assertSucceeds(getDocs(collection(as("dave"), "announcements")));
});
await test("参加者：ポイントQR は1件ずつなら読めるが、一覧は読めない", async () => {
  await assertSucceeds(getDoc(doc(bob(), "ptQrs/qr1")));
  await assertFails(getDocs(collection(bob(), "ptQrs")));
});
await test("作戦ボード：公開前は読めない・公開すると読める", async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "boards/main"), { shown: false, open: false, players: ["alice"], pos: { ball: { x: 50, y: 50 } } }));
  await assertFails(getDoc(doc(bob(), "boards/main")));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "boards/main"), { shown: true }, { merge: true }));
  await assertSucceeds(getDoc(doc(bob(), "boards/main")));
});
await test("作戦ボード：「参加者も動かせる」がオフなら動かせない・オンなら位置と線だけ変えられる", async () => {
  await assertFails(updateDoc(doc(bob(), "boards/main"), { "pos.ball": { x: 10, y: 10 }, uid: "bob", at: serverTimestamp() }));
  await assertFails(updateDoc(doc(bob(), "boards/main"), { "marks.m0": { t: "line", p: [1, 1, 2, 2] }, uid: "bob" })); // オフなら描けない
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "boards/main"), { open: true }, { merge: true }));
  await assertSucceeds(updateDoc(doc(bob(), "boards/main"), { "pos.ball": { x: 10, y: 10 }, uid: "bob", at: serverTimestamp() }));
  await assertFails(updateDoc(doc(bob(), "boards/main"), { "pos.ball": { x: 20, y: 20 }, uid: "alice", at: serverTimestamp() })); // なりすまし
  await assertFails(updateDoc(doc(bob(), "boards/main"), { players: ["bob"], uid: "bob" }));            // 選手の入れ替えは管理者だけ
  await assertFails(updateDoc(doc(bob(), "boards/main"), { shown: false, uid: "bob" }));                // 設定は管理者だけ
  await assertSucceeds(updateDoc(doc(bob(), "boards/main"), { "marks.m1": { t: "arrow", c: "#fff", p: [10, 10, 30, 40], uid: "bob", n: 1 }, uid: "bob", at: serverTimestamp() })); // 矢印を描ける
  await assertSucceeds(updateDoc(doc(bob(), "boards/main"), { marks: {}, uid: "bob", at: serverTimestamp() }));                  // 全部消せる
  await assertFails(updateDoc(doc(bob(), "boards/main"), { "pos.ball": { x: 30, y: 30 }, uid: "bob", at: new Date("2020-01-01") })); // 時刻のすり替え
  await assertFails(deleteDoc(doc(bob(), "boards/main")));
  await assertFails(updateDoc(doc(carol(), "boards/main"), { "pos.ball": { x: 1, y: 1 }, uid: "carol" })); // 入っていない旅行
});

await test("試合の記録：公開前は読めない・公開すると読める", async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "matches/m1"), {
    title: "練習", periods: [{ label: "前半", min: 20 }, { label: "後半", min: 20 }], cur: 0, running: false, startedAt: null, elapsed: 0, status: "ready",
    goals: {}, shots: {}, plays: {}, poss: {}, hold: {}, keepers: ["bob"], roles: { bob: ["timer", "goal"] }, shown: false, uid: "adminUid" }));
  await assertFails(getDoc(doc(bob(), "matches/m1")));
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { running: true, startedAt: serverTimestamp(), status: "live", uid: "bob", at: serverTimestamp() })); // 非公開の間は記録係でも書けない
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "matches/m1"), { shown: true }, { merge: true }));
  await assertSucceeds(getDoc(doc(alice(), "matches/m1")));
  await assertSucceeds(getDocs(query(collection(alice(), "matches"), where("shown", "==", true))));
  await assertFails(getDocs(collection(alice(), "matches")));          // 非公開の試合も含む一覧は読めない
});
await test("試合の記録：記録係は担当の分だけ書ける・設定は変えられない", async () => {
  const g = { side: "home", uid: "alice", name: "", assist: null, own: false, p: 0, t: 1000, at: serverTimestamp(), by: "bob", n: 1 };
  await assertSucceeds(updateDoc(doc(bob(), "matches/m1"), { running: true, startedAt: serverTimestamp(), status: "live", uid: "bob", at: serverTimestamp() })); // タイマー
  await assertSucceeds(updateDoc(doc(bob(), "matches/m1"), { "goals.g1": g, uid: "bob", at: serverTimestamp() }));            // 得点
  await assertSucceeds(updateDoc(doc(bob(), "matches/m1"), { "goals.g1.assist": "bob", uid: "bob", at: serverTimestamp() })); // 決めた人などを直す
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { "shots.s1": { side: "home", r: "on", p: 0, t: 1 }, uid: "bob", at: serverTimestamp() })); // シュートは担当外
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { "plays.f1": { side: "away", k: "foul", p: 0, t: 1 }, uid: "bob", at: serverTimestamp() })); // ファウルは担当外
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { "poss.p0.home": 5000, uid: "bob", at: serverTimestamp() }));      // ボール保持は担当外
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { keepers: ["bob", "alice"], uid: "bob", at: serverTimestamp() })); // 記録係を増やせない
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { "roles.bob": ["timer", "goal", "shot", "play", "poss"], uid: "bob", at: serverTimestamp() })); // 担当を増やせない
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { periods: [{ label: "前半", min: 99 }], uid: "bob", at: serverTimestamp() })); // 時間の設定は管理者だけ
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { shown: false, uid: "bob", at: serverTimestamp() }));
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { cur: 5, uid: "bob", at: serverTimestamp() }));                    // ないピリオド
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { status: "live", uid: "alice", at: serverTimestamp() }));          // なりすまし
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { status: "done", uid: "bob", at: new Date("2020-01-01") }));       // 時刻のすり替え
  await assertFails(deleteDoc(doc(bob(), "matches/m1")));
  // 記録係でない人は何も書けない
  await assertFails(updateDoc(doc(alice(), "matches/m1"), { "goals.g2": { ...g, by: "alice" }, uid: "alice", at: serverTimestamp() }));
  await assertFails(updateDoc(doc(alice(), "matches/m1"), { running: false, uid: "alice", at: serverTimestamp() }));
});
await test("試合の記録：ボール保持・ファウルの担当と、外されたあと", async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "matches/m1"), { keepers: ["bob", "alice"], roles: { bob: ["timer", "goal"], alice: ["poss", "play", "shot"] } }, { merge: true }));
  await assertSucceeds(updateDoc(doc(alice(), "matches/m1"), { "hold.home": { uid: "alice", at: serverTimestamp() }, uid: "alice", at: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(alice(), "matches/m1"), { "poss.p0.home": increment(4200), "hold.home": null, uid: "alice", at: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(alice(), "matches/m1"), { "plays.f1": { side: "away", k: "foul", uid: null, name: "", p: 0, t: 5000, at: serverTimestamp(), by: "alice", n: 2 }, uid: "alice", at: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(alice(), "matches/m1"), { "shots.s1": { side: "home", r: "off", p: 0, t: 6000 }, uid: "alice", at: serverTimestamp() }));
  await assertFails(updateDoc(doc(alice(), "matches/m1"), { "hold.x": null, uid: "alice", at: serverTimestamp() }));        // 決まった形だけ
  await assertFails(updateDoc(doc(alice(), "matches/m1"), { running: false, uid: "alice", at: serverTimestamp() }));         // タイマーは担当外
  await assertFails(updateDoc(doc(alice(), "matches/m1"), { "goals.g9": { side: "home", p: 0, t: 1 }, uid: "alice", at: serverTimestamp() })); // 得点は担当外
  // 試合中の PK（人と○×）はファウル・セットプレーの担当、PK戦は得点の担当
  await assertSucceeds(updateDoc(doc(alice(), "matches/m1"), { "plays.k1": { side: "home", k: "pk", pkType: "pk", uid: "alice", r: "o", p: 0, t: 7000 }, uid: "alice", at: serverTimestamp() }));
  await assertFails(updateDoc(doc(alice(), "matches/m1"), { soFirst: "home", soN: 5, uid: "alice", at: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(bob(), "matches/m1"), { soFirst: "home", soN: 5, uid: "bob", at: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(bob(), "matches/m1"), { "so.s1": { side: "home", uid: "alice", r: "o", n: 1 }, uid: "bob", at: serverTimestamp() }));
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { soFirst: "middle", uid: "bob", at: serverTimestamp() }));
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { soN: 99, uid: "bob", at: serverTimestamp() }));
  await assertFails(updateDoc(doc(alice(), "matches/m1"), { "so.s2": { side: "away", r: "x", n: 2 }, uid: "alice", at: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(bob(), "matches/m1"), { so: {}, soFirst: null, soN: null, uid: "bob", at: serverTimestamp() }));
  // 管理者が記録係から外す → すぐ書けない
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "matches/m1"), { keepers: ["alice"], roles: { alice: ["poss", "play", "shot"] } }, { merge: true }));
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { running: false, uid: "bob", at: serverTimestamp() }));
  await assertFails(updateDoc(doc(bob(), "matches/m1"), { "goals.g3": { side: "away", p: 0, t: 1 }, uid: "bob", at: serverTimestamp() }));
  // 担当を外すと、記録係のままでもその分は書けない
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "matches/m1"), { roles: { alice: ["shot"] } }, { merge: true }));
  await assertFails(updateDoc(doc(alice(), "matches/m1"), { "poss.p0.away": increment(1000), uid: "alice", at: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(alice(), "matches/m1"), { "shots.s2": { side: "away", r: "on", p: 0, t: 9000 }, uid: "alice", at: serverTimestamp() }));
  // 管理者はいつでも全部
  await assertSucceeds(updateDoc(doc(admin(), "matches/m1"), { periods: [{ label: "1本目", min: 10 }], cur: 0, uid: "adminUid", at: serverTimestamp() }));
  await assertFails(updateDoc(doc(carol(), "matches/m1"), { running: true, uid: "carol", at: serverTimestamp() }));           // 入っていない旅行
});

// ----- 参加者の情報（住所・大学など。全旅行で共通・管理者だけ）
await test("参加者の情報：管理者は読み書きできる", async () => {
  await assertSucceeds(setDoc(doc(admin(), "personFields/f1"), { name: "住所", kind: "long", options: [], order: 1 }));
  await assertSucceeds(setDoc(doc(admin(), "personInfo/alice"), { values: { f1: "大阪府吹田市" }, name: "Alice", loginId: "user01" }));
  await assertSucceeds(getDocs(collection(admin(), "personInfo")));
  await assertSucceeds(getDoc(doc(admin(), "personFields/f1")));
});
await test("参加者の情報：参加者は本人の分も含めて読めない・書けない", async () => {
  await assertFails(getDoc(doc(alice(), "personInfo/alice")));          // 本人の分
  await assertFails(getDoc(doc(bob(), "personInfo/alice")));            // ほかの人の分
  await assertFails(getDocs(collection(bob(), "personInfo")));
  await assertFails(getDocs(collection(alice(), "personFields")));
  await assertFails(getDoc(doc(carol(), "personInfo/alice")));
  await assertFails(getDoc(doc(outsider(), "personInfo/alice")));
  await assertFails(setDoc(doc(alice(), "personInfo/alice"), { values: { f1: "x" } }));
  await assertFails(setDoc(doc(bob(), "personFields/f2"), { name: "x" }));
  await assertFails(deleteDoc(doc(alice(), "personInfo/alice")));
});

// ----- 人ごとに送ったお知らせの内容（暗証番号など）
await test("人ごとの内容：本人だけ読める・参加者は書けない", async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "announcements/e1"), { title: "暗証番号", scope: "users", targets: ["alice", "bob"], personal: true });
    await setDoc(doc(db, "annPrivate/e1_alice"), { annId: "e1", uid: "alice", body: "4821" });
    await setDoc(doc(db, "annPrivate/e1_bob"), { annId: "e1", uid: "bob", body: "7350" });
    await setDoc(doc(db, "profiles/P2/annPrivate/f1_carol"), { annId: "f1", uid: "carol", body: "1111" });
  });
  await assertSucceeds(getDoc(doc(alice(), "annPrivate/e1_alice")));
  await assertSucceeds(getDoc(doc(bob(), "annPrivate/e1_bob")));
  await assertFails(getDoc(doc(bob(), "annPrivate/e1_alice")));             // ほかの人の分
  await assertFails(getDocs(collection(bob(), "annPrivate")));              // 一覧（全員分）
  await assertFails(getDocs(query(collection(bob(), "annPrivate"), where("annId", "==", "e1"))));
  await assertSucceeds(getDocs(query(collection(bob(), "annPrivate"), where("uid", "==", "bob"))));
  await assertFails(getDoc(doc(carol(), "annPrivate/e1_alice")));           // 入っていない旅行
  await assertSucceeds(getDoc(doc(carol(), "profiles/P2/annPrivate/f1_carol")));
  await assertFails(getDoc(doc(alice(), "profiles/P2/annPrivate/f1_carol")));
  await assertFails(setDoc(doc(alice(), "annPrivate/e1_alice"), { annId: "e1", uid: "alice", body: "0000" }));
  await assertFails(setDoc(doc(bob(), "annPrivate/x_bob"), { annId: "x", uid: "bob", body: "x" }));
  await assertFails(deleteDoc(doc(alice(), "annPrivate/e1_alice")));
  await assertSucceeds(getDocs(query(collection(admin(), "annPrivate"), where("annId", "==", "e1"))));
  await assertSucceeds(setDoc(doc(admin(), "annPrivate/e2_alice"), { annId: "e2", uid: "alice", body: "x" }));
});
await env.cleanup();
for (const r of results) console.log(r[0] === "ok" ? "✅" : "❌", r[1], r[2] ?? "");
const ng = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - ng} / ${results.length} 合格`);
process.exit(ng ? 1 : 0);
