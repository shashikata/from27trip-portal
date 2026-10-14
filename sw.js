// 電波がない状態でもアプリ本体（画面）を開けるようにするためのキャッシュ。
// データ（お知らせ・ポイント）は Firestore 側のオフラインキャッシュが担当する。
const CACHE = "island-v40";
const TILES = "island-tiles-v1"; // 地図の絵（一度見た範囲を保存しておく）
const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const PRECACHE = [
  "./", "./index.html", "./app.js", "./config.js", "./style.css",
  "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png",
  `${SDK}firebase-app.js`, `${SDK}firebase-auth.js`, `${SDK}firebase-firestore.js`,
];

self.addEventListener("install", (e) => {
  // GitHub Pages はファイルを最大10分ブラウザにキャッシュさせるので、cache: "reload" で必ず取り直す
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function fetchWithTimeout(req, ms) {
  return Promise.race([
    fetch(req),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 地図の絵と地図ライブラリ：保存済みならそれを使い、なければ取得して保存する
  if (url.hostname === "tile.openstreetmap.org" || url.href.startsWith("https://cdnjs.cloudflare.com/ajax/libs/leaflet/")) {
    e.respondWith(caches.open(TILES).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }))));
    return;
  }

  // Firebase SDK はバージョン固定なのでキャッシュ優先
  if (url.href.startsWith(SDK)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    })));
    return;
  }

  // 自分のファイルはキャッシュ優先（スマホで開くたびに通信を待たないように）。
  // 新しい版は CACHE の名前を変えて公開するので、この sw.js が更新された時点で入れ替わり、画面が1回読み直される。
  // キャッシュに無いものだけネットから取る（電波が弱くて 4 秒以内に返らなければトップ画面）
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetchWithTimeout(new Request(req.url, { cache: "no-cache", credentials: "same-origin" }), 4000)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match("./index.html"))),
    );
  }
});
