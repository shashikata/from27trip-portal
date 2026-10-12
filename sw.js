// 電波がない状態でもアプリ本体（画面）を開けるようにするためのキャッシュ。
// データ（お知らせ・ポイント）は Firestore 側のオフラインキャッシュが担当する。
const CACHE = "island-v2";
const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const PRECACHE = [
  "./", "./index.html", "./app.js", "./config.js", "./style.css",
  "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png",
  `${SDK}firebase-app.js`, `${SDK}firebase-auth.js`, `${SDK}firebase-firestore.js`,
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
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

  // Firebase SDK はバージョン固定なのでキャッシュ優先
  if (url.href.startsWith(SDK)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    })));
    return;
  }

  // 自分のファイルはネット優先（更新を反映するため）。電波が弱くて 4 秒以内に返らなければキャッシュ
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetchWithTimeout(req, 4000)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html"))),
    );
  }
});
