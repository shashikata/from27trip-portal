# プッシュ通知の設定手順（Cloudflare Workers）

アプリから「通知を送る」を押すと、この Worker が Apple / Google の配信サーバーへ通知を届けます。
Cloudflare の無料プランで動きます（クレジットカードは不要）。

## 全体の流れ（最初に1回だけ）

1. アプリを最新にする（設定の一番下が v64 以降）
2. アプリで「通知用の鍵」を作る
3. Cloudflare に登録して Worker を作り、`worker.js` を貼る
4. Worker に設定値（鍵など）を入れる
5. Worker の URL をアプリに保存して、つながるか確かめる
6. 各自のスマホで「通知を受け取る」をオンにする

---

## 1. アプリを最新にする
管理者の端末でアプリを開き、右上（スマホは左上）の ⟳ を押す。設定の一番下が **バージョン v64** 以降になっていれば OK。

## 2. 通知用の鍵を作る（管理者のアプリで）
1. 設定 →「プッシュ通知の設定（管理者）」→ **通知用の鍵を作る（最初に1回）**
2. `VAPID_PUBLIC_KEY` と `VAPID_PRIVATE_KEY` が出るので、**この画面を開いたまま** 次へ進む
   （閉じると秘密鍵は二度と出ません。閉じてしまったら作り直せば大丈夫です）

## 3. Cloudflare で Worker を作る
1. https://dash.cloudflare.com/sign-up でアカウントを作る（メールアドレスとパスワードだけ）
2. 左のメニューの **Workers & Pages**（「Compute (Workers)」の中にあることもある）→ **作成（Create）**
3. **Hello World から開始（Start with Hello World）** を選ぶ
4. 名前を `trip-push` にして **デプロイ（Deploy）**
5. **コードを編集（Edit code）** を押し、左側の `worker.js` の中身を **全部消して**、
   このフォルダの `worker.js` の中身を **全部貼る**
   - 貼るもの：https://github.com/shashikata/from27trip-portal/blob/main/push-worker/worker.js
     （右上の「Copy raw file」ボタンでまるごとコピーできる）
6. 右上の **デプロイ（Deploy）**

## 4. Worker に設定値を入れる
Worker の画面 → **設定（Settings）** → **変数とシークレット（Variables and Secrets）** → **追加（Add）** で、次の6つを入れる。
入れ終わったら **デプロイ（Deploy）** を押す。

| 名前 | 種類 | 値 |
|---|---|---|
| `VAPID_PUBLIC_KEY` | テキスト | 手順2で出た公開鍵 |
| `VAPID_PRIVATE_KEY` | **シークレット（Secret）** | 手順2で出た秘密鍵 |
| `VAPID_SUBJECT` | テキスト | `mailto:` + 自分のメールアドレス（例：`mailto:you@example.com`） |
| `FIREBASE_PROJECT_ID` | テキスト | `island2027spring` |
| `ADMIN_EMAILS` | テキスト | `admin1@island.example.com,admin2@island.example.com,admin3@island.example.com` |
| `ALLOWED_ORIGIN` | テキスト | `https://shashikata.github.io` |

- 名前は大文字・アンダーバーまで **完全に同じ** にする
- `VAPID_PRIVATE_KEY` だけは必ず「シークレット」にする（あとから見えなくなる＝漏れない）

## 5. URL をアプリに保存する
1. Worker の画面の上の方にある URL（`https://trip-push.○○.workers.dev`）をコピー
2. アプリの 設定 →「プッシュ通知の設定（管理者）」→ **Worker の URL** に貼って **URL を保存**
3. **つながるか確かめる** →「つながりました」と出れば OK
   （出ないときは、手順4の `VAPID_PUBLIC_KEY` と `ALLOWED_ORIGIN` を確認）

## 6. 各自のスマホで通知をオンにする
- **iPhone**（iOS 16.4 以降）
  1. Safari でアプリを開く → 共有ボタン（□↑）→ **ホーム画面に追加**
  2. ホーム画面のアイコンから開く（Safari のタブではなく）
  3. 設定 → 「通知」→ **通知を受け取る** → 「許可」
- **Android**：Chrome でアプリを開き、設定 → **通知を受け取る** → 「許可」
- 管理者も自分の端末で同じようにオンにして、設定の **自分の端末にテスト通知** で届くか確かめる

---

## 使い方（管理者）
- **お知らせを投稿**：「通知も送る」がオンなら、宛先の人に届く（チーム宛ては、チーム表を発表しているときだけ）
- **アンケートのカード** →「通知を送る」：未回答の人だけ／対象者全員
- **集金のカード** →「通知を送る」：未入金の人だけ／対象者全員
- **お知らせのカード** →「通知を送る」：あとから再送

## うまくいかないとき
| 症状 | 確認すること |
|---|---|
| 「つながるか確かめる」で失敗 | URL が合っているか。`VAPID_PUBLIC_KEY` と `ALLOWED_ORIGIN` を入れてデプロイしたか |
| 送ると「管理者だけが送れます」 | `ADMIN_EMAILS` に自分の管理者IDのメールアドレスが入っているか |
| 送ると「ログイン情報が正しくありません」 | `FIREBASE_PROJECT_ID` が `island2027spring` か。一度ログアウトして入り直す |
| 「○人（○台）に送りました」なのに届かない | 端末の設定でアプリの通知がオンか。iPhone はホーム画面のアイコンから開いて「通知を受け取る」を押したか |
| 鍵を作り直した | 全員もう一度「通知を受け取る」を押す必要がある |

## 料金
Cloudflare Workers の無料プランは 1日10万回まで。通知を1回送るごとに、40人ごとに1回使う程度なので、この規模ならまず超えません。
