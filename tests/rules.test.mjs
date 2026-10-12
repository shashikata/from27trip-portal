// firestore.rules のテスト。実行方法は README.md を参照
//   cd tests && npm install && npx firebase emulators:exec --config ../firebase.json --only firestore "node rules.test.mjs"
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
const alice = () => as("alice");     // チームA
const bob = () => as("bob");         // チームB
const outsider = () => as("hacker"); // 勝手にアカウントを作った人（members に無い）

async function seed(published) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const t = serverTimestamp();
    await setDoc(doc(db, "config/app"), { teamsPublished: published, title: "t" });
    await setDoc(doc(db, "members/alice"), { loginId: "user01", name: "Alice" });
    await setDoc(doc(db, "members/bob"), { loginId: "user02", name: "Bob" });
    await setDoc(doc(db, "teams/A"), { name: "A", color: "#f00" });
    await setDoc(doc(db, "teams/B"), { name: "B", color: "#00f" });
    await setDoc(doc(db, "assignments/alice"), { teamId: "A" });
    await setDoc(doc(db, "assignments/bob"), { teamId: "B" });
    const ann = (id, scope, target) => setDoc(doc(db, `announcements/${id}`), { title: id, body: "", scope, target, images: [], pinned: false, createdAt: t });
    await ann("all1", "all", null);
    await ann("teamA", "team", "A");
    await ann("teamB", "team", "B");
    await ann("toAlice", "user", "alice");
    await ann("toBob", "user", "bob");
    const log = (id, kind, target, teamId, visibility) => setDoc(doc(db, `pointLogs/${id}`), { kind, target, teamId, visibility, delta: 1, reason: "", createdAt: t });
    await log("pubTeamA", "team", "A", "A", "public");
    await log("secretTeamA", "team", "A", "A", "team");
    await log("secretTeamB", "team", "B", "B", "team");
    await log("aliceTeamVisible", "user", "alice", "A", "team");
    await log("alicePrivate", "user", "alice", "A", "private");
    await log("bobPrivate", "user", "bob", "B", "private");
    await log("bobPublic", "user", "bob", "B", "public");
  });
}

const ids = async (q) => (await getDocs(q)).docs.map((d) => d.id).sort();
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["NG", name, e.message]); }
}

// ===== チーム発表前 =====
await seed(false);
{
  const a = alice();
  await test("発表前: 参加者は全員宛てのお知らせを読める", async () =>
    assert.deepEqual(await ids(query(collection(a, "announcements"), where("scope", "==", "all"))), ["all1"]));
  await test("発表前: 自分宛てのお知らせは読める", async () =>
    assert.deepEqual(await ids(query(collection(a, "announcements"), where("scope", "==", "user"), where("target", "==", "alice"))), ["toAlice"]));
  await test("発表前: 他人宛てのお知らせは読めない", () =>
    assertFails(getDocs(query(collection(a, "announcements"), where("scope", "==", "user"), where("target", "==", "bob")))));
  await test("発表前: 自分のチーム宛てでも読めない", () =>
    assertFails(getDocs(query(collection(a, "announcements"), where("scope", "==", "team"), where("target", "==", "A")))));
  await test("発表前: チーム一覧は読めない", () => assertFails(getDocs(collection(a, "teams"))));
  await test("発表前: 自分の所属チームも読めない", () => assertFails(getDoc(doc(a, "assignments/alice"))));
  await test("発表前: チーム内ポイントは読めない", () =>
    assertFails(getDocs(query(collection(a, "pointLogs"), where("visibility", "==", "team"), where("teamId", "==", "A")))));
  await test("発表前: 公開ポイントは読める", async () =>
    assert.deepEqual(await ids(query(collection(a, "pointLogs"), where("visibility", "==", "public"))), ["bobPublic", "pubTeamA"]));
  await test("発表前: 管理者はチームを読める", () => assertSucceeds(getDocs(collection(admin(), "teams"))));
}

// ===== チーム発表後 =====
await seed(true);
{
  const a = alice();
  await test("発表後: 自分のチーム宛てのお知らせは読める", async () =>
    assert.deepEqual(await ids(query(collection(a, "announcements"), where("scope", "==", "team"), where("target", "==", "A"))), ["teamA"]));
  await test("発表後: 他チーム宛てのお知らせは読めない", () =>
    assertFails(getDocs(query(collection(a, "announcements"), where("scope", "==", "team"), where("target", "==", "B")))));
  await test("発表後: 他チーム宛てを1件指定で読んでも読めない", () => assertFails(getDoc(doc(a, "announcements/teamB"))));
  await test("発表後: 条件なしで全お知らせを読もうとすると拒否", () => assertFails(getDocs(collection(a, "announcements"))));
  await test("発表後: チーム一覧と所属は読める", async () => {
    await assertSucceeds(getDocs(collection(a, "teams")));
    await assertSucceeds(getDocs(collection(a, "assignments")));
  });
  await test("発表後: 自チームのチーム内ポイントは読める（チーム用＋メンバー個人用）", async () =>
    assert.deepEqual(await ids(query(collection(a, "pointLogs"), where("visibility", "==", "team"), where("teamId", "==", "A"))), ["aliceTeamVisible", "secretTeamA"]));
  await test("発表後: 他チームのチーム内ポイントは読めない", () =>
    assertFails(getDocs(query(collection(a, "pointLogs"), where("visibility", "==", "team"), where("teamId", "==", "B")))));
  await test("発表後: 他チームの秘密ポイントを1件指定で読んでも読めない", () => assertFails(getDoc(doc(a, "pointLogs/secretTeamB"))));
  await test("本人のみポイント: 自分の分は読める", async () =>
    assert.deepEqual(await ids(query(collection(a, "pointLogs"), where("visibility", "==", "private"), where("target", "==", "alice"))), ["alicePrivate"]));
  await test("本人のみポイント: 他人の分は読めない", () =>
    assertFails(getDocs(query(collection(a, "pointLogs"), where("visibility", "==", "private"), where("target", "==", "bob")))));
  await test("本人のみポイント: 他人が1件指定で読もうとしても読めない", () => assertFails(getDoc(doc(bob(), "pointLogs/alicePrivate"))));

  await test("部外者: 全員宛てお知らせも読めない", () =>
    assertFails(getDocs(query(collection(outsider(), "announcements"), where("scope", "==", "all")))));
  await test("部外者: 公開ポイントも読めない", () =>
    assertFails(getDocs(query(collection(outsider(), "pointLogs"), where("visibility", "==", "public")))));
  await test("部外者: 参加者名簿も読めない", () => assertFails(getDocs(collection(outsider(), "members"))));
  await test("未ログイン: 何も読めない", () =>
    assertFails(getDocs(query(collection(env.unauthenticatedContext().firestore(), "announcements"), where("scope", "==", "all")))));

  await test("参加者: お知らせを書けない", () =>
    assertFails(addDoc(collection(a, "announcements"), { title: "x", body: "", scope: "all", target: null, images: [], pinned: false, createdAt: serverTimestamp() })));
  await test("参加者: 自分にポイントを足せない", () =>
    assertFails(addDoc(collection(a, "pointLogs"), { kind: "user", target: "alice", teamId: "A", visibility: "public", delta: 100, reason: "", createdAt: serverTimestamp() })));
  await test("参加者: ポイント履歴を消せない", () => assertFails(deleteDoc(doc(a, "pointLogs/pubTeamA"))));
  await test("参加者: 自分の名前を書き換えられない", () => assertFails(setDoc(doc(a, "members/alice"), { loginId: "user01", name: "王様" })));
  await test("参加者: 自分のチームを変えられない", () => assertFails(setDoc(doc(a, "assignments/alice"), { teamId: "B" })));
  await test("参加者: チーム発表を勝手に切り替えられない", () => assertFails(setDoc(doc(a, "config/app"), { teamsPublished: false })));
  await test("偽管理者: 別ドメインの admin1 は管理者扱いされない", () =>
    assertFails(setDoc(doc(as("fake", { email: "admin1@evil.example.com" }), "config/app"), { teamsPublished: false })));

  const ad = admin();
  await test("管理者: お知らせを書ける", () =>
    assertSucceeds(addDoc(collection(ad, "announcements"), { title: "x", body: "y", scope: "team", target: "A", images: ["data:image/jpeg;base64,AA"], pinned: true, createdAt: serverTimestamp() })));
  await test("管理者: 画像4枚は拒否", () =>
    assertFails(addDoc(collection(ad, "announcements"), { title: "x", body: "", scope: "all", target: null, images: ["a", "b", "c", "d"], pinned: false, createdAt: serverTimestamp() })));
  await test("管理者: ポイントを付けられる", () =>
    assertSucceeds(addDoc(collection(ad, "pointLogs"), { kind: "team", target: "A", teamId: "A", visibility: "team", delta: -3, reason: "遅刻", createdAt: serverTimestamp() })));
  await test("管理者: チームに『本人のみ』は付けられない", () =>
    assertFails(addDoc(collection(ad, "pointLogs"), { kind: "team", target: "A", teamId: "A", visibility: "private", delta: 1, reason: "", createdAt: serverTimestamp() })));
  await test("管理者: 全部読める", async () => {
    assert.equal((await getDocs(collection(ad, "pointLogs"))).size, 8);
    assert.equal((await getDocs(collection(ad, "announcements"))).size, 6);
  });
}

await env.cleanup();
for (const r of results) console.log(r[0] === "ok" ? "✅" : "❌", r[1], r[2] ?? "");
const ng = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - ng} / ${results.length} 合格`);
process.exit(ng ? 1 : 0);
