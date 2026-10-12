// firestore.rules のテスト。実行方法は README.md を参照
//   cd tests && npm install && npm test
import fs from "node:fs";
import assert from "node:assert/strict";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs, serverTimestamp } from "firebase/firestore";

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
await test("参加者：自分の位置を書ける（P2）", () => assertSucceeds(setDoc(doc(carol(), "profiles/P2/locations/carol"), { uid: "carol", lat: 1, lng: 2 })));
await test("参加者：他人になりすまして書けない", () => assertFails(setDoc(doc(alice(), "acks/a1_bob2"), { annId: "a1", uid: "bob" })));
await test("参加者：他人の記録は消せない", () => assertFails(deleteDoc(doc(alice(), "acks/a1_bob"))));
await test("参加者：自分の記録は消せる", () => assertSucceeds(deleteDoc(doc(alice(), "acks/a1_alice"))));
await test("参加者：お知らせを書けない", () => assertFails(setDoc(doc(bob(), "announcements/x"), { title: "x" })));
await test("参加者：ポイントを書けない", () => assertFails(setDoc(doc(bob(), "pointLogs/x"), { delta: 100, target: "bob" })));
await test("参加者：uid 付きでも入っていない旅行には書けない", () => assertFails(setDoc(doc(bob(), "profiles/P2/acks/b1_bob"), { uid: "bob" })));
await test("参加者：旅行を作れない", () => assertFails(setDoc(doc(alice(), "profiles/P3"), { name: "x", uid: "alice" })));
await test("参加者：自分を勝手に旅行に追加できない", () => assertFails(setDoc(doc(bob(), "profiles/P2/members/bob"), { name: "Bob", uid: "bob" })));
await test("部外者：uid 付きでも書けない", () => assertFails(setDoc(doc(outsider(), "acks/a1_hacker"), { uid: "hacker" })));
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

await env.cleanup();
for (const r of results) console.log(r[0] === "ok" ? "✅" : "❌", r[1], r[2] ?? "");
const ng = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - ng} / ${results.length} 合格`);
process.exit(ng ? 1 : 0);
