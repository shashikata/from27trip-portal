# 無人島ポータル（七日島企画用）

管理者がPCやスマホから入力した **お知らせ・チーム発表・ポイント** を、参加者がそれぞれのアカウントでスマホから見られる Web アプリです。

- 画面：GitHub Pages（無料）
- ログインとデータ保存：Firebase（Authentication + Cloud Firestore、無料の Spark プランで足ります）

## できること

| 機能 | 管理者（admin1, admin2） | 参加者（user01〜） |
|---|---|---|
| お知らせ | 投稿・削除・固定。宛先を **全員 / 特定チーム / 特定の人** から選べる。画像は3枚まで（自動で縮小） | 自分が見てよいものだけ表示 |
| チーム | 作成・名前変更・手動振り分け・ランダム振り分け・**発表ボタン** | 発表されるまで何も見えない |
| ポイント | 個人用・チーム用を付与・取り消し。1件ごとに **全員に公開 / チーム内のみ / 本人のみ** を選べる | 自分・自分のチーム・公開ランキング |
| アカウント | 参加者アカウントの一括作成（パスワードは自動生成） | パスワード変更 |
| 電波が弱いとき | 入力は端末に保存され、電波が戻ると自動で送信 | 最後に受信した内容を表示し続ける |

「誰が何を見られるか」は画面ではなく **Firebase 側のルール（`firestore.rules`）** で判定しています。そのため、通信を覗いても見てはいけないデータは届きません。この点は `tests/rules.test.mjs` の36項目のテストで確認済みです。

---

## 準備手順（初回だけ・30分ほど）

> Firebase の画面の表記は変わることがあります。見当たらないときは同じ意味の項目を探してください。

### 1. Firebase プロジェクトを作る
1. https://console.firebase.google.com/ に Google アカウントでログインする
2. 「プロジェクトを作成」を押す。名前は何でもよい（例：`nanuka-island`）。Google アナリティクスは **オフ** でよい

### 2. ログイン機能を有効にする
1. 左メニューの「構築」→「Authentication」→「始める」
2. 「ログイン方法」タブで **メール / パスワード** を有効にして保存する
3. **「ユーザー」タブ →「ユーザーを追加」で、管理者2人を作る（この手順は必ず最初に行うこと）**
   - `admin1@island.example.com`（パスワードは自分で決める）
   - `admin2@island.example.com`
   - アプリでは `admin1` / `admin2` と入力すればログインできます

> ⚠️ 管理者アカウントを作る前にアプリの URL を公開すると、他人が先に `admin1` を作って管理者になれてしまいます。必ず先に作ってください。

### 3. データベースを作る
1. 「構築」→「Firestore Database」→「データベースを作成」
2. ロケーションは `asia-northeast1`（東京）または `asia-northeast2`（大阪）を選ぶ。**あとから変更できません**
3. 「本番環境モード」で開始する
4. 「ルール」タブを開き、中身を全部消して、このフォルダの `firestore.rules` の中身を貼り付け、「公開」を押す

### 4. アプリと Firebase をつなぐ
1. 歯車アイコン →「プロジェクトの設定」→ 下の方の「マイアプリ」で `</>`（ウェブ）を押す
2. アプリ名を適当に付けて登録する（Firebase Hosting は **不要**）
3. 表示された `firebaseConfig` の値を `config.js` の `productionConfig` に貼り付ける
4. 必要なら、`config.js` の `APP_TITLE` も書き換える

### 5. GitHub Pages で公開する
1. このフォルダの中身を、GitHub の **public** リポジトリのいちばん上の階層に置く
2. リポジトリの「Settings」→「Pages」→「Build and deployment」で、Source を「Deploy from a branch」、Branch を `main` / `/(root)` にして保存する
3. 1〜2分待つと `https://<ユーザー名>.github.io/<リポジトリ名>/` で開ける
4. Firebase に戻り、「Authentication」→「設定」→「承認済みドメイン」に `<ユーザー名>.github.io` を追加する

### 6. 参加者アカウントを作る
1. `admin1` でログインし、「参加者」タブ →「まとめて作成」で `user` `1` 〜 `16` を指定して作成する
2. **表示されたパスワードの一覧を必ずコピーして保存する（あとから再表示できません）**
3. 一覧で表示名（例：たろう）を変更して「保存」を押す
4. 各自に ID とパスワードを渡す（LINE の個別メッセージなど）

### 7. 出発前に必ずやること
- [ ] 全員に一度ログインしてもらい、「ホーム画面に追加」してもらう（アプリのように開け、電波がなくても画面が出る）
- [ ] 機内モードにしてアプリを開き直し、お知らせが表示されることを確認する
- [ ] 管理者2人とも、スマホからポイントを付けられることを確認する
- [ ] チーム表と大事なお知らせは **紙でも1部** 用意する

---

## 当日の使い方のコツ

- **チーム発表**：「チーム」タブで振り分けを済ませてから「チームを発表する」を押すと、全員の画面に一斉に表示されます。押すまでは参加者からはまったく見えません
- **ポイントの公開範囲**
  - 全員に公開：公開ランキングに反映される
  - チーム内のみ：そのチームのメンバーだけが見られる（相手チームにはわからない）
  - 本人のみ（個人ポイントだけ）：その人だけが見られる
- **間違えたら**：「ポイント」タブの履歴にある「取消」で消せます
- **電波がないとき**：管理者が入力した内容は端末に保存され、電波が戻ったときに自動で送信されます（画面上部に「未送信の変更があります」と出ます）

## 知っておくべき制限（正直に書いておきます）

1. **参加者がパスワードを忘れたとき、アプリからはリセットできません。** Firebase の無料プランでは、他人のパスワードを変更する仕組みを作れないためです。対策：
   - 管理者はパスワード一覧を必ず保管する
   - 参加者には「パスワードを変更するなら絶対に忘れないこと」と伝える
   - 最終手段：Firebase コンソールでそのユーザーを削除し、アプリで同じ ID を作り直す。**ただし、その人の個人ポイントとチームの所属は引き継がれません**（チーム所属は付け直せます）
2. **アカウントの作成は電波のある場所で行ってください**（オフラインでは作れません）
3. 画像は端末側で縮小して保存しています（1枚あたり最大約180KB、1つのお知らせに3枚まで）。地図などを細かく見せたい場合は、紙も用意してください
4. 参加者の名前は、ログインしている参加者全員から見えます（チーム発表前でも）

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` / `style.css` / `app.js` | 画面とその動き |
| `config.js` | **ここだけ書き換える**（Firebase の設定、タイトル、管理者ID） |
| `firestore.rules` | 誰が何を読み書きできるかのルール（Firebase に貼り付ける） |
| `sw.js` / `manifest.webmanifest` / `icon*` | オフラインで開くための仕組みとアイコン |
| `firebase.json` / `tests/` | 手元でのテスト用（公開には不要だが、置いておいても害はない） |

## テストの方法（開発者向け）

Node.js 18 以上と Java 11 以上が必要です。

```bash
cd tests
npm install
npm test        # firestore.rules のテスト（36項目）
```

手元で画面を試すとき：`firebase emulators:start --project demo-island --only auth,firestore` を起動しておき、このフォルダで `python3 -m http.server 5173` を実行し、`http://localhost:5173/` を開く。`localhost` で開いたときは、自動的にエミュレーター（本物の Firebase には接続しない）を使います。

## 参考にした資料

- Firebase Authentication（メール / パスワード）：https://firebase.google.com/docs/auth/web/password-auth
- Cloud Firestore セキュリティルール：https://firebase.google.com/docs/firestore/security/get-started
  - 「ルールはフィルタではない」（クエリをルールに合わせて分ける必要がある）：https://firebase.google.com/docs/firestore/security/rules-query
- Firestore のオフラインデータ：https://firebase.google.com/docs/firestore/manage-data/enable-offline
- Firestore の制限（1ドキュメント 1MiB）：https://firebase.google.com/docs/firestore/quotas
- Firebase の料金（Spark プランの無料枠）：https://firebase.google.com/pricing
- GitHub Pages の公開元の設定：https://docs.github.com/ja/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
