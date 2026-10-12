// firestore.rules のテスト。実行方法は README.md を参照
//   cd tests && npm install && npm test
import fs from "node:fs";
import assert from "node:assert/strict";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import {
  doc, getDoc, setDoc, addDoc, deleteDoc, collection, query, where, getDocs, serverTimestamp,
} from "firebase/firestore";

const env = await initializeTestEnvironment({
  projectId: "demo-island",
  firestore: { rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 },
});

const ADMIN = { email: "admin1@island.example.com" };
const as = (uid, token = {}) => env.authenticatedContext(uid, { email: `${uid}@island.example.com`, ...token }).firestore();
const admin = () => as("adminUid", ADMIN);
const alice = () => as("alice");     // 表1: A / 表2: X（未発表）
const bob = () => as("bob");         // 表1: B / 表2: Y（未発表）
const outsider = () => as("hacker"); // 勝手にアカウントを作った人（members に無い）

// 表1（発表済み）: A={alice}, B={bob}
// 表2（未発表）  : X={alice}, Y={bob}
async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const t = serverTimestamp();
    await setDoc(doc(db, "config/app"), { title: "t" });
    await setDoc(doc(db, "members/alice"), { loginId: "user01", name: "Alice" });
    await setDoc(doc(db, "members/bob"), { loginId: "user02", name: "Bob" });
    await setDoc(doc(db, "teamSets/S1"), { name: "表1", published: true });
    await setDoc(doc(db, "teamSets/S2"), { name: "表2", published: false });
    const team = (id, setId, published) => setDoc(doc(db, `teams/${id}`), { setId, name: id, color: "#f00", published });
    await team("A", "S1", true); await team("B", "S1", true);
    await team("X", "S2", false); await team("Y", "S2", false);
    const mem = (teamId, uid, setId, published, hidden = false) => setDoc(doc(db, `memberships/${teamId}_${uid}`), { teamId, uid, setId, published, hidden });
    await mem("A", "alice", "S1", true); await mem("B", "bob", "S1", true);
    await mem("X", "alice", "S2", false); await mem("Y", "bob", "S2", false);
    // bob は表1で B に参加しているが、本当は A のスパイ
    await mem("A", "bob", "S1", true, true);
    const ann = (id, scope, target) => setDoc(doc(db, `announcements/${id}`), { title: id, body: "", scope, target, images: [], pinned: false, createdAt: t });
    await ann("all1", "all", null);
    await ann("teamA", "team", "A"); await ann("teamB", "team", "B"); await ann("teamX", "team", "X");
    await ann("toAlice", "user", "alice"); await ann("toBob", "user", "bob");
    const log = (id, kind, target, teamId, visibility) => setDoc(doc(db, `pointLogs/${id}`), { kind, target, teamId, visibility, delta: 1, reason: "", createdAt: t });
    await log("pubTeamA", "team", "A", "A", "public");
    await log("secretTeamA", "team", "A", "A", "team");
    await log("secretTeamB", "team", "B", "B", "team");
    await log("secretTeamX", "team", "X", "X", "team");
    await log("aliceTeamVisible", "user", "alice", "A", "team");
    await log("alicePrivate", "user", "alice", null, "private");
    await log("bobPrivate", "user", "bob", null, "private");
    await log("bobPublic", "user", "bob", null, "public");
  });
}

const ids = async (q) => (await getDocs(q)).docs.map((d) => d.id).sort();
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["NG", name, e.message]); }
}

await seed();
const a = alice();
const ann = (db) => collection(db, "announcements");
const logs = (db) => collection(db, "pointLogs");

// ----- チーム表・チーム・所属
await test("発表済みのチーム表だけ読める", async () =>
  assert.deepEqual(await ids(query(collection(a, "teamSets"), where("published", "==", true))), ["S1"]));
await test("未発表のチーム表は1件指定でも読めない", () => assertFails(getDoc(doc(a, "teamSets/S2"))));
await test("条件なしでチーム表一覧を読むと拒否", () => assertFails(getDocs(collection(a, "teamSets"))));
await test("発表済みのチームだけ読める", async () =>
  assert.deepEqual(await ids(query(collection(a, "teams"), where("published", "==", true))), ["A", "B"]));
await test("未発表のチームは読めない", () => assertFails(getDoc(doc(a, "teams/X"))));
await test("発表済みの（隠しでない）所属だけ読める", async () =>
  assert.deepEqual(await ids(query(collection(a, "memberships"), where("published", "==", true), where("hidden", "==", false))), ["A_alice", "B_bob"]));
await test("hidden を指定しない所属一覧は拒否（スパイ情報が混ざるため）", () =>
  assertFails(getDocs(query(collection(a, "memberships"), where("published", "==", true)))));
await test("スパイ：他人はスパイの本当のチームを読めない（1件指定）", () => assertFails(getDoc(doc(a, "memberships/A_bob"))));
await test("スパイ：他人は uid 指定でもスパイの所属を全部は読めない", () =>
  assertFails(getDocs(query(collection(a, "memberships"), where("published", "==", true), where("uid", "==", "bob")))));
await test("スパイ：本人は自分の本当のチームを読める", async () =>
  assert.deepEqual(await ids(query(collection(bob(), "memberships"), where("published", "==", true), where("uid", "==", "bob"))), ["A_bob", "B_bob"]));
await test("スパイ：本人は本当のチームのチーム内ポイントを読める", async () =>
  assert.deepEqual(await ids(query(collection(bob(), "pointLogs"), where("visibility", "==", "team"), where("teamId", "==", "A"))), ["aliceTeamVisible", "secretTeamA"]));
await test("スパイ：本人は本当のチーム宛てのお知らせを読める", async () =>
  assert.deepEqual(await ids(query(collection(bob(), "announcements"), where("scope", "==", "team"), where("target", "==", "A"))), ["teamA"]));
await test("未発表の自分の所属も読めない", () => assertFails(getDoc(doc(a, "memberships/X_alice"))));

// ----- お知らせ
await test("全員宛てのお知らせを読める", async () =>
  assert.deepEqual(await ids(query(ann(a), where("scope", "==", "all"))), ["all1"]));
await test("自分宛てのお知らせを読める", async () =>
  assert.deepEqual(await ids(query(ann(a), where("scope", "==", "user"), where("target", "==", "alice"))), ["toAlice"]));
await test("他人宛てのお知らせは読めない", () =>
  assertFails(getDocs(query(ann(a), where("scope", "==", "user"), where("target", "==", "bob")))));
await test("発表済みの自チーム宛ては読める（クエリ）", async () =>
  assert.deepEqual(await ids(query(ann(a), where("scope", "==", "team"), where("target", "==", "A"))), ["teamA"]));
await test("他チーム宛ては読めない（クエリ）", () =>
  assertFails(getDocs(query(ann(a), where("scope", "==", "team"), where("target", "==", "B")))));
await test("他チーム宛ては読めない（1件指定）", () => assertFails(getDoc(doc(a, "announcements/teamB"))));
await test("未発表のチーム表の自チーム宛ては読めない", () =>
  assertFails(getDocs(query(ann(a), where("scope", "==", "team"), where("target", "==", "X")))));
await test("条件なしで全お知らせを読むと拒否", () => assertFails(getDocs(ann(a))));

// ----- ポイント
await test("公開ポイントを読める", async () =>
  assert.deepEqual(await ids(query(logs(a), where("visibility", "==", "public"))), ["bobPublic", "pubTeamA"]));
await test("自チームのチーム内ポイントを読める（チーム用＋メンバー個人用）", async () =>
  assert.deepEqual(await ids(query(logs(a), where("visibility", "==", "team"), where("teamId", "==", "A"))), ["aliceTeamVisible", "secretTeamA"]));
await test("他チームのチーム内ポイントは読めない（クエリ）", () =>
  assertFails(getDocs(query(logs(a), where("visibility", "==", "team"), where("teamId", "==", "B")))));
await test("他チームのチーム内ポイントは読めない（1件指定）", () => assertFails(getDoc(doc(a, "pointLogs/secretTeamB"))));
await test("未発表のチーム表のチーム内ポイントは読めない", () =>
  assertFails(getDocs(query(logs(a), where("visibility", "==", "team"), where("teamId", "==", "X")))));
await test("本人のみポイント：自分の分は読める", async () =>
  assert.deepEqual(await ids(query(logs(a), where("visibility", "==", "private"), where("target", "==", "alice"))), ["alicePrivate"]));
await test("本人のみポイント：他人の分は読めない", () =>
  assertFails(getDocs(query(logs(a), where("visibility", "==", "private"), where("target", "==", "bob")))));
await test("本人のみポイント：1件指定でも他人は読めない", () => assertFails(getDoc(doc(bob(), "pointLogs/alicePrivate"))));

// ----- 部外者
await test("部外者：全員宛てお知らせも読めない", () => assertFails(getDocs(query(ann(outsider()), where("scope", "==", "all")))));
await test("部外者：公開ポイントも読めない", () => assertFails(getDocs(query(logs(outsider()), where("visibility", "==", "public")))));
await test("部外者：発表済みチームも読めない", () => assertFails(getDocs(query(collection(outsider(), "teams"), where("published", "==", true)))));
await test("部外者：参加者名簿も読めない", () => assertFails(getDocs(collection(outsider(), "members"))));
await test("未ログイン：何も読めない", () =>
  assertFails(getDocs(query(ann(env.unauthenticatedContext().firestore()), where("scope", "==", "all")))));

// ----- 参加者は書けない
await test("参加者：お知らせを書けない", () =>
  assertFails(addDoc(ann(a), { title: "x", body: "", scope: "all", target: null, images: [], pinned: false, createdAt: serverTimestamp() })));
await test("参加者：自分にポイントを足せない", () =>
  assertFails(addDoc(logs(a), { kind: "user", target: "alice", teamId: null, visibility: "public", delta: 100, reason: "", createdAt: serverTimestamp() })));
await test("参加者：ポイント履歴を消せない", () => assertFails(deleteDoc(doc(a, "pointLogs/pubTeamA"))));
await test("参加者：自分の名前を書き換えられない", () => assertFails(setDoc(doc(a, "members/alice"), { loginId: "user01", name: "王様" })));
await test("参加者：自分の所属を勝手に作れない", () =>
  assertFails(setDoc(doc(a, "memberships/B_alice"), { teamId: "B", uid: "alice", setId: "S1", published: true, hidden: false })));
await test("参加者：チーム表を勝手に発表できない", () => assertFails(setDoc(doc(a, "teamSets/S2"), { name: "表2", published: true })));
await test("偽管理者：別ドメインの admin1 は管理者扱いされない", () =>
  assertFails(setDoc(doc(as("fake", { email: "admin1@evil.example.com" }), "teamSets/S2"), { name: "x", published: true })));

// ----- 管理者
const ad = admin();
await test("管理者：所属を作れる", () =>
  assertSucceeds(setDoc(doc(ad, "memberships/B_alice"), { teamId: "B", uid: "alice", setId: "S1", published: true, hidden: false })));
await test("管理者：hidden の無い所属は作れない", () =>
  assertFails(setDoc(doc(ad, "memberships/B_alice"), { teamId: "B", uid: "alice", setId: "S1", published: true })));
await test("管理者：IDと中身が食い違う所属は作れない", () =>
  assertFails(setDoc(doc(ad, "memberships/A_bob"), { teamId: "B", uid: "bob", setId: "S1", published: true, hidden: false })));
await test("管理者：お知らせを書ける", () =>
  assertSucceeds(addDoc(ann(ad), { title: "x", body: "y", scope: "team", target: "A", images: ["data:image/jpeg;base64,AA"], pinned: true, createdAt: serverTimestamp() })));
await test("管理者：画像4枚は拒否", () =>
  assertFails(addDoc(ann(ad), { title: "x", body: "", scope: "all", target: null, images: ["a", "b", "c", "d"], pinned: false, createdAt: serverTimestamp() })));
await test("管理者：ポイントを付けられる", () =>
  assertSucceeds(addDoc(logs(ad), { kind: "team", target: "A", teamId: "A", visibility: "team", delta: -3, reason: "遅刻", createdAt: serverTimestamp() })));
await test("管理者：チームに『本人のみ』は付けられない", () =>
  assertFails(addDoc(logs(ad), { kind: "team", target: "A", teamId: "A", visibility: "private", delta: 1, reason: "", createdAt: serverTimestamp() })));
await test("管理者：未発表のものも含め全部読める", async () => {
  assert.equal((await getDocs(collection(ad, "teamSets"))).size, 2);
  assert.equal((await getDocs(collection(ad, "pointLogs"))).size, 9);
});

// ----- 「見ました」
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const t = serverTimestamp();
  const ann = (id, scope, target, ack) => setDoc(doc(db, `announcements/${id}`), { title: id, body: "", scope, target, images: [], pinned: false, ack, createdAt: t });
  await ann("ackAll", "all", null, true);
  await ann("noAck", "all", null, false);
  await ann("ackTeamB", "team", "B", true);
  await ann("ackToBob", "user", "bob", true);
  await ann("ackTeamX", "team", "X", true);
  await setDoc(doc(db, "acks/ackAll_bob"), { annId: "ackAll", uid: "bob", at: t });
  // 上の「管理者：所属を作れる」で alice を B にも入れたので、元に戻す
  await deleteDoc(doc(db, "memberships/B_alice"));
});
const ack = (db, annId, uid = "alice") => setDoc(doc(db, `acks/${annId}_${uid}`), { annId, uid, at: serverTimestamp() });
await test("見ました：全員宛てに押せる", () => assertSucceeds(ack(alice(), "ackAll")));
await test("見ました：自分の記録を読める", async () =>
  assert.deepEqual(await ids(query(collection(alice(), "acks"), where("uid", "==", "alice"))), ["ackAll_alice"]));
await test("見ました：他人の記録は読めない", () => assertFails(getDocs(query(collection(alice(), "acks"), where("uid", "==", "bob")))));
await test("見ました：取り消せる", () => assertSucceeds(deleteDoc(doc(alice(), "acks/ackAll_alice"))));
await test("見ました：ボタンの無いお知らせには押せない", () => assertFails(ack(alice(), "noAck")));
await test("見ました：他チーム宛てには押せない", () => assertFails(ack(alice(), "ackTeamB")));
await test("見ました：他人宛てには押せない", () => assertFails(ack(alice(), "ackToBob")));
await test("見ました：未発表チーム宛てには押せない", () => assertFails(ack(alice(), "ackTeamX")));
await test("見ました：他人になりすまして押せない", () => assertFails(setDoc(doc(alice(), "acks/ackAll_carol"), { annId: "ackAll", uid: "carol", at: serverTimestamp() })));
await test("見ました：他人の記録を消せない", () => assertFails(deleteDoc(doc(alice(), "acks/ackAll_bob"))));
await test("見ました：余計な項目は付けられない", () => assertFails(setDoc(doc(alice(), "acks/ackAll_alice"), { annId: "ackAll", uid: "alice", at: serverTimestamp(), x: 1 })));
await test("見ました：部外者は押せない", () => assertFails(ack(outsider(), "ackAll", "hacker")));
await test("見ました：管理者は全員分を読める", async () => assert.equal((await getDocs(collection(admin(), "acks"))).size, 1));

// ----- 表・メモ
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "notes/pub"), { title: "ルール", type: "memo", body: "1位 +10", shared: true });
  await setDoc(doc(db, "notes/secret"), { title: "採点メモ", type: "memo", body: "内緒", shared: false });
});
await test("表・メモ：公開分だけ読める", async () =>
  assert.deepEqual(await ids(query(collection(alice(), "notes"), where("shared", "==", true))), ["pub"]));
await test("表・メモ：非公開は読めない", () => assertFails(getDoc(doc(alice(), "notes/secret"))));
await test("表・メモ：参加者は書けない", () => assertFails(setDoc(doc(alice(), "notes/x"), { title: "x", shared: true })));
await test("表・メモ：管理者は書ける", () => assertSucceeds(setDoc(doc(admin(), "notes/x"), { title: "x", type: "memo", body: "", shared: false })));

// ----- 発表の切り替え：表2を発表すると alice は X 宛てを読めるようになる
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, "memberships/X_alice"), { teamId: "X", uid: "alice", setId: "S2", published: true, hidden: false });
});
await test("発表後：表2の自チーム宛てが読めるようになる", async () =>
  assert.deepEqual(await ids(query(ann(alice()), where("scope", "==", "team"), where("target", "==", "X"))), ["ackTeamX", "teamX"]));
await test("発表後：表2の自チーム宛てに『見ました』を押せるようになる", () => assertSucceeds(ack(alice(), "ackTeamX")));
await test("発表後：表2の自チームのチーム内ポイントが読めるようになる", async () =>
  assert.deepEqual(await ids(query(logs(alice()), where("visibility", "==", "team"), where("teamId", "==", "X"))), ["secretTeamX"]));
await test("発表後でも、表2の他チーム宛ては読めない", () =>
  assertFails(getDocs(query(ann(alice()), where("scope", "==", "team"), where("target", "==", "Y")))));

await env.cleanup();
for (const r of results) console.log(r[0] === "ok" ? "✅" : "❌", r[1], r[2] ?? "");
const ng = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - ng} / ${results.length} 合格`);
process.exit(ng ? 1 : 0);
