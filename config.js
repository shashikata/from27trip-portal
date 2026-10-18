// ===== ここだけ自分の環境に合わせて書き換える =====

// Firebase コンソール →「プロジェクトの設定」→「マイアプリ」→ ウェブアプリの設定値を貼り付ける。
// （この値は公開されても問題ない。アクセス制御は firestore.rules で行っている）
const productionConfig = {
  apiKey: "AIzaSyDDOVgcxdgv68LorfMXi0_LYOAsa2rQF2o",
  authDomain: "island2027spring.firebaseapp.com",
  projectId: "island2027spring",
  storageBucket: "island2027spring.firebasestorage.app",
  messagingSenderId: "732560470365",
  appId: "1:732560470365:web:400b9f62fe7ed4cdf0b8b4",
};

// 画面上部に出るタイトル（管理画面の「設定」からも変更できる）
export const APP_TITLE = "七日島 無人島企画";

// ログインID → メールアドレスへの変換に使うドメイン（実在しない予約ドメイン。メールは送信されない）
export const EMAIL_DOMAIN = "island.example.com";

// 管理者のログインID。firestore.rules の isAdmin() と必ず一致させること
// 画面上の名前は順に「管理者1」「管理者2」「管理者3」になる
export const ADMIN_IDS = ["admin1", "admin2", "admin3"];

// アカウントの切り替え：管理者ID → その人の参加者ID（この組み合わせだけ、設定画面から行き来できる）
export const ACCOUNT_SWITCH = { admin1: "s0406", admin3: { name: "かや", id: "k1201" } }; // ID か、{ name: "名前", id: "見つからないときのID" }（名前からIDを探す）

// ===== ここから下は触らなくてよい =====

export const USE_EMULATOR = ["localhost", "127.0.0.1"].includes(location.hostname);

export const firebaseConfig = USE_EMULATOR
  ? { apiKey: "demo-key", authDomain: "localhost", projectId: "demo-island", appId: "demo-app" }
  : productionConfig;
