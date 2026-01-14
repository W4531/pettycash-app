/**
 * index.js (complete)
 * - Productized Cover (Dashboard)
 * - Productized Settlements (filters + summary + detail modal)
 * - Static CSS: /public/css/app.css
 *
 * Required .env:
 *   NOTION_TOKEN=ntn_...
 *   NOTION_DB_ID=32-char
 *   GCS_BUCKET=pettycash-receipts-shakehands
 *
 * Optional .env:
 *   CONFIG_DB_ID=32-char
 *   PORT=8080
 *   INITIAL_BALANCE=0
 *   GCS_PREFIX=receipts
 *
 * NOTE:
 * - Signed URL requires proper credentials on runtime:
 *   - Cloud Run: service account with roles/storage.objectViewer + (for signed URL) serviceAccountTokenCreator (or use HMAC signing approach)
 *   - Local: GOOGLE_APPLICATION_CREDENTIALS pointing to a JSON key that includes client_email
 */

require("dotenv").config();

const express = require("express");
const axios = require("axios");
const multer = require("multer");
const { Storage } = require("@google-cloud/storage");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files (CSS, icons, etc.)
app.use(express.static("public"));

const upload = multer({ dest: "/tmp" });

const {
  NOTION_TOKEN,
  NOTION_DB_ID,
  CONFIG_DB_ID,
  GCS_BUCKET,
  GCS_PREFIX = "receipts",
  PORT = "8080",
  INITIAL_BALANCE = "0",
} = process.env;

function must(v, name) {
  if (!v) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
}
must(NOTION_TOKEN, "NOTION_TOKEN");
must(NOTION_DB_ID, "NOTION_DB_ID");
must(GCS_BUCKET, "GCS_BUCKET");

const notion = axios.create({
  baseURL: "https://api.notion.com/v1",
  headers: {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  },
});

/**
 * Notion property names (must match exactly)
 */
const EXP = {
  title: "使用用途",      // Title
  date: "利用日付",       // Date
  month: "利用月",        // Select (YYYY-MM)
  amount: "金額",         // Number
  vendor: "支払先",       // Rich text
  creator: "作成者",      // Select
  status: "ステータス",   // Select (完了/未精算/精算済)
  type: "種別",           // Select (補充/使用)
  receiptUrl: "領収書URL" // URL (stores gs://...)
};

const CONF = {
  title: "Name",          // Title (value must equal "AppConfig")
  opening: "期首残高",    // Number
  creators: "作成者一覧"  // Multi-select
};

const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET);

// =====================
// Signed URL helpers
// =====================
function parseGsUri(gs) {
  const m = String(gs || "").match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { bucket: m[1], object: m[2] };
}

async function signedUrlForGs(gsUri, { download = false } = {}) {
  const p = parseGsUri(gsUri);
  if (!p) throw new Error("Invalid gs:// URI");

  // Security: allow only this bucket
  if (p.bucket !== GCS_BUCKET) throw new Error("Bucket mismatch");

  const file = storage.bucket(p.bucket).file(p.object);
  const options = {
    version: "v4",
    action: "read",
    expires: Date.now() + 15 * 60 * 1000, // 15 min
    responseDisposition: download ? "attachment" : "inline",
  };

  const [url] = await file.getSignedUrl(options);
  return url;
}

app.get("/open", async (req, res) => {
  try {
    const gs = String(req.query.gcs || "");
    const url = await signedUrlForGs(gs, { download: false });
    res.redirect(302, url);
  } catch (e) {
    console.error("open error:", e);
    const msg = String(e?.message || "");
    if (msg.includes("client_email")) {
      return res
        .status(500)
        .send(
          "署名URLを生成できません。Cloud Run のサービスアカウント権限、またはローカルの GOOGLE_APPLICATION_CREDENTIALS（JSONキー）を確認してください。"
        );
    }
    res.status(400).send("開けませんでした。URL形式または権限を確認してください。");
  }
});

app.get("/download", async (req, res) => {
  try {
    const gs = String(req.query.gcs || "");
    const url = await signedUrlForGs(gs, { download: true });
    res.redirect(302, url);
  } catch (e) {
    console.error("download error:", e);
    const msg = String(e?.message || "");
    if (msg.includes("client_email")) {
      return res
        .status(500)
        .send(
          "署名URLを生成できません。Cloud Run のサービスアカウント権限、またはローカルの GOOGLE_APPLICATION_CREDENTIALS（JSONキー）を確認してください。"
        );
    }
    res.status(400).send("ダウンロードできませんでした。URL形式または権限を確認してください。");
  }
});

// =====================
// Utils
// =====================
function ymFromDate(dateStr) {
  const [y, m] = String(dateStr).split("-");
  return `${y}-${m}`;
}

function ymdTodayLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ymThisMonthLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function toNumberStrict(v) {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function guessExt(mimetype, originalname) {
  const extFromName = path.extname(originalname || "").toLowerCase();
  if (extFromName) return extFromName;
  if (mimetype === "image/jpeg") return ".jpg";
  if (mimetype === "image/png") return ".png";
  if (mimetype === "image/webp") return ".webp";
  if (mimetype === "image/heic") return ".heic";
  return "";
}

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function getTitleFromPage(p) {
  const t = p?.properties?.[EXP.title]?.title || [];
  return t.map((x) => x?.plain_text || "").join("");
}

function getRichTextFromPage(p, propName) {
  const rt = p?.properties?.[propName]?.rich_text || [];
  return rt.map((x) => x?.plain_text || "").join("");
}

function getDateFromPage(p) {
  return p?.properties?.[EXP.date]?.date?.start || "";
}

function getNumberFromPage(p) {
  const n = p?.properties?.[EXP.amount]?.number;
  return typeof n === "number" ? n : 0;
}

function getSelectNameFromPage(p, propName) {
  return p?.properties?.[propName]?.select?.name || "";
}

function getUrlFromPage(p) {
  return p?.properties?.[EXP.receiptUrl]?.url || "";
}

function pageLayout({ title, body }) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/css/app.css">
</head>
<body>
  <div class="container">
    <div class="topbar">
      <div class="brand">
        <div class="logo"></div>
        <div style="min-width:0;">
          <div class="title">${escapeHtml(title)}</div>
          <div class="subtitle">Petty Cash / Expense</div>
        </div>
      </div>
      <div class="row">
        <a class="btn ghost" href="/">表紙</a>
      </div>
    </div>

    ${body}
  </div>
</body>
</html>`;
}

// =====================
// Notion: Config
// =====================
async function getConfig() {
  const fallback = {
    openingBalance: Number(INITIAL_BALANCE) || 0,
    creators: [],
    hasConfigDb: Boolean(CONFIG_DB_ID),
    pageId: null,
  };

  if (!CONFIG_DB_ID) return fallback;

  const r = await notion.post(`/databases/${CONFIG_DB_ID}/query`, {
    page_size: 1,
    filter: { property: CONF.title, title: { equals: "AppConfig" } },
  });

  const page = (r.data.results || [])[0];
  if (!page) return fallback;

  const opening = page.properties?.[CONF.opening]?.number;
  const creatorsProp = page.properties?.[CONF.creators]?.multi_select || [];
  const creators = creatorsProp.map((x) => x.name).filter(Boolean);

  return {
    openingBalance: typeof opening === "number" ? opening : fallback.openingBalance,
    creators,
    hasConfigDb: true,
    pageId: page.id,
  };
}

async function saveConfig({ openingBalance, creators }) {
  if (!CONFIG_DB_ID) throw new Error("CONFIG_DB_ID is missing in .env");
  const cfg = await getConfig();
  if (!cfg.pageId) throw new Error('AppConfig record not found (Title must be "AppConfig").');

  await notion.patch(`/pages/${cfg.pageId}`, {
    properties: {
      [CONF.opening]: { number: openingBalance },
      [CONF.creators]: { multi_select: creators.map((name) => ({ name })) },
    },
  });
}

// =====================
// Notion: DB schema -> 利用月 options
// =====================
async function getExpenseMonthsFromSchema() {
  const r = await notion.get(`/databases/${NOTION_DB_ID}`);
  const prop = r.data?.properties?.[EXP.month];
  const opts = prop?.select?.options || [];
  const months = opts.map((o) => o.name).filter(Boolean);
  months.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // desc
  return months;
}

// =====================
// Notion: Expenses CRUD
// =====================
async function createExpensePage({
  type,
  title,
  date,
  amount,
  vendor,
  creator,
  status,
  receiptUrl,
}) {
  const month = ymFromDate(date);

  const payload = {
    parent: { database_id: NOTION_DB_ID },
    properties: {
      [EXP.title]: { title: [{ text: { content: title } }] },
      [EXP.date]: { date: { start: date } },
      [EXP.month]: { select: { name: month } },
      [EXP.amount]: { number: amount },
      [EXP.vendor]: { rich_text: [{ text: { content: vendor } }] },
      [EXP.status]: { select: { name: status } },
      [EXP.type]: { select: { name: type } },
    },
  };

  if (creator) payload.properties[EXP.creator] = { select: { name: creator } };
  if (receiptUrl) payload.properties[EXP.receiptUrl] = { url: receiptUrl };

  const res = await notion.post("/pages", payload);
  return res.data;
}

async function updateStatus(pageId, newStatusName) {
  await notion.patch(`/pages/${pageId}`, {
    properties: { [EXP.status]: { select: { name: newStatusName } } },
  });
}

async function queryExpensesPaged({ filter, sorts }) {
  let cursor = undefined;
  const all = [];

  while (true) {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;

    const r = await notion.post(`/databases/${NOTION_DB_ID}/query`, body);
    all.push(...(r.data.results || []));

    if (!r.data.has_more) break;
    cursor = r.data.next_cursor;
  }
  return all;
}

async function sumAmountByFilter(filter) {
  let cursor = undefined;
  let sum = 0;

  while (true) {
    const body = { page_size: 100, filter };
    if (cursor) body.start_cursor = cursor;

    const r = await notion.post(`/databases/${NOTION_DB_ID}/query`, body);
    const results = r.data.results || [];

    for (const p of results) {
      const n = p.properties?.[EXP.amount]?.number;
      if (typeof n === "number") sum += n;
    }

    if (!r.data.has_more) break;
    cursor = r.data.next_cursor;
  }

  return sum;
}

async function countByFilter(filter) {
  let cursor = undefined;
  let count = 0;

  while (true) {
    const body = { page_size: 100, filter };
    if (cursor) body.start_cursor = cursor;

    const r = await notion.post(`/databases/${NOTION_DB_ID}/query`, body);
    const results = r.data.results || [];
    count += results.length;

    if (!r.data.has_more) break;
    cursor = r.data.next_cursor;
  }
  return count;
}

async function sumAmountByType(typeName) {
  return sumAmountByFilter({ property: EXP.type, select: { equals: typeName } });
}

async function sumUnsettledTotal() {
  return sumAmountByFilter({
    and: [
      { property: EXP.type, select: { equals: "使用" } },
      { property: EXP.status, select: { equals: "未精算" } },
    ],
  });
}

// Recent activity (latest N)
async function getRecentActivity(limit = 6) {
  const pages = await queryExpensesPaged({
    filter: { property: EXP.type, select: { is_not_empty: true } },
    sorts: [{ property: EXP.date, direction: "descending" }],
  });
  const sliced = pages.slice(0, limit);
  return sliced.map((p) => ({
    pageId: p.id,
    date: getDateFromPage(p),
    month: getSelectNameFromPage(p, EXP.month),
    type: getSelectNameFromPage(p, EXP.type),
    title: getTitleFromPage(p),
    amount: getNumberFromPage(p),
    vendor: getRichTextFromPage(p, EXP.vendor),
    status: getSelectNameFromPage(p, EXP.status),
    receiptUrl: getUrlFromPage(p),
  }));
}

// =====================
// GCS: Receipt upload
// =====================
async function uploadReceiptToGCS({ localPath, date, mimetype, originalname }) {
  const month = ymFromDate(date);
  const ext = guessExt(mimetype, originalname);
  const key = `${GCS_PREFIX}/${month}/${randomId()}${ext}`;

  await bucket.upload(localPath, {
    destination: key,
    contentType: mimetype || "application/octet-stream",
    metadata: { cacheControl: "private, max-age=0, no-transform" },
  });

  // Cleanup tmp file (best-effort)
  try { fs.unlinkSync(localPath); } catch {}

  return `gs://${GCS_BUCKET}/${key}`;
}

// ============================================================================
// APIs
// ============================================================================

app.get("/meta", async (req, res) => {
  try {
    const months = await getExpenseMonthsFromSchema();
    res.json({ months });
  } catch (e) {
    console.error("meta error:", e.response?.data || e);
    res.status(500).json({ error: "Failed to load meta", detail: e.response?.data || String(e) });
  }
});

// Cover dashboard API (single call)
app.get("/cover_stats", async (req, res) => {
  try {
    const cfg = await getConfig();
    const opening = cfg.openingBalance;

    const replenish = await sumAmountByType("補充");
    const spend = await sumAmountByType("使用");
    const balance = opening + replenish - spend;

    const unsettled = await sumUnsettledTotal();

    const ym = ymThisMonthLocal();
    const monthSpend = await sumAmountByFilter({
      and: [
        { property: EXP.type, select: { equals: "使用" } },
        { property: EXP.month, select: { equals: ym } },
      ],
    });
    const monthCount = await countByFilter({
      and: [
        { property: EXP.type, select: { equals: "使用" } },
        { property: EXP.month, select: { equals: ym } },
      ],
    });

    const recent = await getRecentActivity(6);

    res.json({
      ym,
      opening,
      replenish,
      spend,
      balance,
      unsettled,
      monthSpend,
      monthCount,
      recent,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("cover_stats error:", e.response?.data || e);
    res.status(500).json({ error: "Failed to load cover stats", detail: e.response?.data || String(e) });
  }
});

// ============================================================================
// Pages
// ============================================================================

// Cover (Dashboard)
app.get("/", async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    pageLayout({
      title: "小口経費",
      body: `
<h1 style="margin-top:18px;">小口経費</h1>
<div class="muted">残高・未精算・当月の使用状況をまとめて確認できます。</div>

<div class="grid cols-3" style="margin-top:14px;">
  <div class="card">
    <div class="kpiLabel">小口残高</div>
    <div class="kpiValue" id="kpiBalance">—</div>
    <div class="kpiSub" id="kpiBalanceSub">読み込み中...</div>
  </div>

  <div class="card">
    <div class="kpiLabel">未精算合計</div>
    <div class="kpiValue" style="font-size:26px;" id="kpiUnsettled">—</div>
    <div class="kpiSub" id="kpiUnsettledSub">読み込み中...</div>
  </div>

  <div class="card">
    <div class="kpiLabel">当月の使用（<span id="kpiYm">—</span>）</div>
    <div class="kpiValue" style="font-size:26px;" id="kpiMonthSpend">—</div>
    <div class="kpiSub" id="kpiMonthSub">読み込み中...</div>
  </div>
</div>

<div class="card soft" style="margin-top:14px;">
  <div class="row">
    <a class="btn primary" href="/spend">経費使用を登録</a>
    <a class="btn" href="/replenish">経費補充を登録</a>
    <div class="spacer"></div>
    <a class="btn" href="/settlements">精算状況</a>
    <a class="btn" href="/images">画像一覧</a>
    <a class="btn" href="/settings">設定</a>
  </div>
  <div class="divider"></div>
  <div class="muted2" id="updatedAt">—</div>
</div>

<div class="card" style="margin-top:14px;">
  <div class="row" style="justify-content:space-between;">
    <div>
      <h2 style="margin:0 0 6px;">最近の履歴</h2>
      <div class="muted">直近6件を表示します。</div>
    </div>
    <a class="btn ghost" href="/settlements">精算へ</a>
  </div>

  <div class="tableWrap" style="margin-top:12px;">
    <table>
      <thead>
        <tr>
          <th>日付</th>
          <th>種別</th>
          <th>用途</th>
          <th class="right">金額</th>
          <th>支払先</th>
          <th>ステータス</th>
        </tr>
      </thead>
      <tbody id="recentTbody">
        <tr><td colspan="6" class="muted">読み込み中...</td></tr>
      </tbody>
    </table>
  </div>
</div>

<script>
function yen(n){ return (n||0).toLocaleString('ja-JP') + ' 円'; }
function esc(s){
  return String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function pillHtml(status){
  if (!status) return '';
  const cls = (status === '未精算') ? 'pill bad' : (status === '精算済' ? 'pill good' : 'pill');
  return '<span class="' + cls + '">' + esc(status) + '</span>';
}

(async () => {
  try {
    const r = await fetch('/cover_stats');
    const j = await r.json();
    if (j.error) throw new Error(j.error);

    document.getElementById('kpiYm').textContent = j.ym || '—';
    document.getElementById('kpiBalance').textContent = yen(j.balance);
    document.getElementById('kpiBalanceSub').textContent =
      '期首: ' + (j.opening||0).toLocaleString('ja-JP') +
      ' / 補充: ' + (j.replenish||0).toLocaleString('ja-JP') +
      ' / 使用: ' + (j.spend||0).toLocaleString('ja-JP');

    document.getElementById('kpiUnsettled').textContent = yen(j.unsettled);
    document.getElementById('kpiUnsettledSub').textContent = '未精算（種別=使用）の合計';

    document.getElementById('kpiMonthSpend').textContent = yen(j.monthSpend);
    document.getElementById('kpiMonthSub').textContent = '件数: ' + (j.monthCount||0) + ' 件';

    const dt = new Date(j.updatedAt);
    document.getElementById('updatedAt').textContent =
      '最終更新: ' + (isNaN(dt.getTime()) ? '—' : dt.toLocaleString('ja-JP'));

    const tbody = document.getElementById('recentTbody');
    const items = j.recent || [];
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">まだ登録がありません。上のボタンから登録してください。</td></tr>';
      return;
    }

    tbody.innerHTML = items.map(x => {
      const type = x.type || '';
      const typePill = '<span class="pill ' + (type==='補充'?'good':'') + '">' + esc(type) + '</span>';
      return '<tr>' +
        '<td>' + esc(x.date || '') + '</td>' +
        '<td>' + typePill + '</td>' +
        '<td>' + esc(x.title || '') + '</td>' +
        '<td class="right">' + (x.amount||0).toLocaleString('ja-JP') + '</td>' +
        '<td>' + esc(x.vendor || '') + '</td>' +
        '<td>' + pillHtml(x.status) + '</td>' +
      '</tr>';
    }).join('');
  } catch (e) {
    console.error(e);
    document.getElementById('recentTbody').innerHTML =
      '<tr><td colspan="6" class="muted">取得に失敗しました。Notion連携とプロパティ名を確認してください。</td></tr>';
    document.getElementById('kpiBalanceSub').textContent = '取得失敗';
    document.getElementById('kpiUnsettledSub').textContent = '取得失敗';
    document.getElementById('kpiMonthSub').textContent = '取得失敗';
  }
})();
</script>
`,
    })
  );
});

// Settings
app.get("/settings", async (req, res) => {
  try {
    const cfg = await getConfig();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      pageLayout({
        title: "設定",
        body: `
<h2>設定</h2>
<div class="muted" style="margin-bottom:10px;">
  Config DB: ${cfg.hasConfigDb ? "有効" : "未設定（.envにCONFIG_DB_IDを設定すると永続化できます）"}
</div>

<div class="card">
  <form method="POST" action="/settings">
    <div>
      <label>期首残高</label>
      <input type="text" name="openingBalance" value="${escapeHtml(cfg.openingBalance)}" inputmode="numeric" required />
      <div class="muted2" style="margin-top:6px;">例：100000</div>
    </div>

    <div style="margin-top:12px;">
      <label>作成者一覧（カンマ区切り）</label>
      <textarea name="creators" rows="4">${escapeHtml(cfg.creators.join(", "))}</textarea>
      <div class="muted2" style="margin-top:6px;">例：Wasei, Tanaka, Suzuki</div>
    </div>

    <div class="row" style="margin-top:12px;">
      <button type="submit">保存</button>
      <a class="btn" href="/">戻る</a>
    </div>
  </form>
</div>
`,
      })
    );
  } catch (e) {
    console.error(e.response?.data || e);
    res.status(500).send("設定画面の表示に失敗しました。");
  }
});

app.post("/settings", async (req, res) => {
  try {
    const opening = toNumberStrict(req.body.openingBalance);
    if (opening === null) return res.status(400).send("期首残高が数値ではありません。");

    const creators = String(req.body.creators ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!CONFIG_DB_ID) return res.status(400).send("CONFIG_DB_ID が未設定のため保存できません。");

    await saveConfig({ openingBalance: opening, creators });
    res.redirect("/settings");
  } catch (e) {
    console.error(e.response?.data || e);
    res.status(500).send("設定の保存に失敗しました。Config DBのIntegration接続とプロパティ名を確認してください。");
  }
});

// Replenish
app.get("/replenish", async (req, res) => {
  const cfg = await getConfig();
  const options = cfg.creators.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    pageLayout({
      title: "経費補充",
      body: `
<h2>経費補充</h2>
<div class="muted">補充はステータス「完了」で登録されます。</div>

<div class="card" style="margin-top:12px;">
  <form method="POST" action="/replenish">
    <div class="grid cols-2">
      <div>
        <label>利用日付</label>
        <input type="date" name="date" required value="${escapeHtml(ymdTodayLocal())}" />
      </div>
      <div>
        <label>金額（半角数字）</label>
        <input type="text" name="amount" inputmode="numeric" required placeholder="例：50000" />
      </div>
    </div>

    <div style="margin-top:12px;">
      <label>作成者</label>
      <select name="creator">
        <option value="">（未選択）</option>
        ${options}
      </select>
    </div>

    <div class="row" style="margin-top:12px;">
      <button type="submit">登録</button>
      <a class="btn" href="/">戻る</a>
    </div>
  </form>
</div>
`,
    })
  );
});

app.post("/replenish", async (req, res) => {
  try {
    const date = req.body.date;
    const amount = toNumberStrict(req.body.amount);
    const creator = (req.body.creator || "").trim();
    if (!date || amount === null) return res.status(400).json({ error: "Invalid date or amount" });

    await createExpensePage({
      type: "補充",
      title: "小口経費補填",
      date,
      amount,
      vendor: "N/A",
      creator,
      status: "完了",
      receiptUrl: "",
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      pageLayout({
        title: "登録完了",
        body: `
<div class="card">
  <h2 style="margin-top:0;">登録しました（補充）</h2>
  <div class="row" style="margin-top:10px;">
    <a class="btn primary" href="/replenish">続けて補充</a>
    <a class="btn" href="/">表紙へ</a>
  </div>
</div>
`,
      })
    );
  } catch (e) {
    console.error(e.response?.data || e);
    res.status(500).json({ error: "Failed to create Notion page", detail: e.response?.data || String(e) });
  }
});

// Spend
app.get("/spend", async (req, res) => {
  const cfg = await getConfig();
  const options = cfg.creators.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    pageLayout({
      title: "経費使用",
      body: `
<h2>経費使用</h2>
<div class="muted">領収書はGCSへ保存され、Notionの領収書URLに gs:// を保存します。</div>

<div class="card" style="margin-top:12px;">
  <form method="POST" action="/spend" enctype="multipart/form-data">
    <div class="grid cols-2">
      <div>
        <label>利用日付</label>
        <input type="date" name="date" required value="${escapeHtml(ymdTodayLocal())}" />
      </div>
      <div>
        <label>金額（半角数字）</label>
        <input type="text" name="amount" inputmode="numeric" required placeholder="例：1200" />
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:12px;">
      <div>
        <label>使用用途（タイトル）</label>
        <input type="text" name="title" required placeholder="例：備品購入" />
      </div>
      <div>
        <label>支払先</label>
        <input type="text" name="vendor" required placeholder="例：Amazon" />
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:12px;">
      <div>
        <label>作成者</label>
        <select name="creator">
          <option value="">（未選択）</option>
          ${options}
        </select>
      </div>
      <div>
        <label>ステータス</label>
        <div style="margin-top:8px;">
          <label style="margin-right:12px;">
            <input type="radio" name="status" value="未精算" checked /> 未精算
          </label>
          <label>
            <input type="radio" name="status" value="精算済" /> 精算済
          </label>
        </div>
      </div>
    </div>

    <div style="margin-top:12px;">
      <label>領収書（画像アップロード）</label>
      <input type="file" name="receipt" accept="image/*,.heic" />
      <div class="muted2" style="margin-top:6px;">HEICはブラウザで表示できない場合があります。その際はDLしてください。</div>
    </div>

    <div class="row" style="margin-top:12px;">
      <button type="submit">登録</button>
      <a class="btn" href="/">戻る</a>
    </div>
  </form>
</div>
`,
    })
  );
});

app.post("/spend", upload.single("receipt"), async (req, res) => {
  try {
    const date = req.body.date;
    const amount = toNumberStrict(req.body.amount);
    const title = (req.body.title || "").trim();
    const vendor = (req.body.vendor || "").trim();
    const creator = (req.body.creator || "").trim();
    const status = (req.body.status || "未精算").trim();

    if (!date || amount === null || !title || !vendor) return res.status(400).json({ error: "Invalid input" });

    let receiptUrl = "";
    if (req.file) {
      receiptUrl = await uploadReceiptToGCS({
        localPath: req.file.path,
        date,
        mimetype: req.file.mimetype,
        originalname: req.file.originalname,
      });
    }

    await createExpensePage({
      type: "使用",
      title,
      date,
      amount,
      vendor,
      creator,
      status,
      receiptUrl,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      pageLayout({
        title: "登録完了",
        body: `
<div class="card">
  <h2 style="margin-top:0;">登録しました（使用）</h2>
  <div class="row" style="margin-top:10px;">
    <a class="btn primary" href="/spend">続けて使用</a>
    <a class="btn" href="/">表紙へ</a>
    <a class="btn ghost" href="/settlements">精算状況へ</a>
  </div>
</div>
`,
      })
    );
  } catch (e) {
    console.error(e.response?.data || e);
    res.status(500).json({ error: "Failed to create Notion page", detail: e.response?.data || String(e) });
  }
});

// Images list
app.get("/images", async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    pageLayout({
      title: "画像一覧",
      body: `
<h2>画像一覧</h2>
<div class="muted">利用月を選択すると、該当月の領収書URLを一覧表示します。</div>

<div class="card soft" style="margin-top:12px;">
  <div class="row">
    <div style="min-width:220px;">
      <label>利用月</label>
      <select id="month"></select>
    </div>
    <button class="secondary" id="reload" type="button">表示</button>
    <div class="spacer"></div>
    <a class="btn" href="/">戻る</a>
  </div>
</div>

<div class="card" style="margin-top:12px;">
  <div class="row" style="justify-content:space-between;">
    <div class="muted" id="summary">読み込み中...</div>
  </div>

  <div class="tableWrap" style="margin-top:12px;">
    <table id="tbl">
      <thead>
        <tr>
          <th>利用日付</th>
          <th>使用用途</th>
          <th class="right">金額</th>
          <th>支払先</th>
          <th>証憑</th>
          <th>コピー</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
const monthSel = document.getElementById('month');
const tbody = document.querySelector('#tbl tbody');
const summary = document.getElementById('summary');

function setMonths(months) {
  monthSel.innerHTML = months.map(m => '<option value="' + m + '">' + m + '</option>').join('');
}

async function loadMonths() {
  const r = await fetch('/meta');
  const j = await r.json();
  if (j.months && j.months.length) setMonths(j.months);
}

function escHtml(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => { el.style.display = 'none'; }, 1200);
}

async function copyText(t) {
  await navigator.clipboard.writeText(t);
  showToast('コピーしました');
}

function safeJsString(s) {
  return String(s || "").replaceAll("\\\\","\\\\\\\\").replaceAll("'","\\\\'");
}

function rowHtml(x) {
  const url = x.receiptUrl || '';
  const openLink = url ? '<a href="/open?gcs=' + encodeURIComponent(url) + '" target="_blank" rel="noopener">開く</a>' : '';
  const dlLink = url ? '<a href="/download?gcs=' + encodeURIComponent(url) + '" target="_blank" rel="noopener" style="margin-left:8px;">DL</a>' : '';
  const copyBtn = url ? '<button type="button" class="secondary" onclick="copyText(\\'' + safeJsString(url) + '\\')">Copy</button>' : '';

  const receiptCell = url
    ? '<code>' + escHtml(url) + '</code><div style="margin-top:6px;">' + openLink + dlLink + '</div>'
    : '<span class="muted">—</span>';

  return '<tr>' +
    '<td>' + (x.date || '') + '</td>' +
    '<td>' + escHtml(x.title || '') + '</td>' +
    '<td class="right">' + (x.amount || 0).toLocaleString('ja-JP') + '</td>' +
    '<td>' + escHtml(x.vendor || '') + '</td>' +
    '<td>' + receiptCell + '</td>' +
    '<td>' + copyBtn + '</td>' +
  '</tr>';
}

async function loadData() {
  const m = monthSel.value;
  summary.textContent = '読み込み中...';
  tbody.innerHTML = '';
  const r = await fetch('/images/data?month=' + encodeURIComponent(m));
  const j = await r.json();
  if (j.error) { summary.textContent = '取得失敗: ' + j.error; return; }
  summary.textContent = '件数: ' + (j.items?.length || 0);
  const items = j.items || [];
  if (!items.length){
    tbody.innerHTML = '<tr><td colspan="6" class="muted">この月の領収書URLはまだありません。</td></tr>';
    return;
  }
  items.forEach(x => {
    const tr = document.createElement('tr');
    tr.innerHTML = rowHtml(x);
    tbody.appendChild(tr);
  });
}

document.getElementById('reload').addEventListener('click', loadData);

(async () => {
  await loadMonths();
  await loadData();
})();
</script>
`,
    })
  );
});

app.get("/images/data", async (req, res) => {
  try {
    const month = String(req.query.month || "").trim();
    if (!month) return res.status(400).json({ error: "month is required" });

    const pages = await queryExpensesPaged({
      filter: {
        and: [
          { property: EXP.type, select: { equals: "使用" } },
          { property: EXP.month, select: { equals: month } },
          { property: EXP.receiptUrl, url: { is_not_empty: true } },
        ],
      },
      sorts: [{ property: EXP.date, direction: "ascending" }],
    });

    const items = pages.map((p) => ({
      pageId: p.id,
      date: getDateFromPage(p),
      title: getTitleFromPage(p),
      amount: getNumberFromPage(p),
      vendor: getRichTextFromPage(p, EXP.vendor),
      status: getSelectNameFromPage(p, EXP.status),
      receiptUrl: getUrlFromPage(p),
    }));

    res.json({ items });
  } catch (e) {
    console.error("images/data error:", e.response?.data || e);
    res.status(500).json({ error: "Failed to load images", detail: e.response?.data || String(e) });
  }
});

// Settlements (productized)
app.get("/settlements", async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(
    pageLayout({
      title: "精算状況",
      body: `
<h2>精算状況</h2>
<div class="muted">月別の取引を確認し、未精算を「精算済」に更新できます。</div>

<div class="card soft" style="margin-top:12px;">
  <div class="grid cols-3">
    <div>
      <label>利用月</label>
      <select id="month"></select>
    </div>
    <div>
      <label>検索（用途 / 支払先）</label>
      <input id="q" type="text" placeholder="例：Amazon / 交通費" />
    </div>
    <div style="display:flex; align-items:flex-end; gap:10px;">
      <button class="secondary" id="reload" type="button">表示</button>
      <label style="display:flex; align-items:center; gap:8px; margin:0;">
        <input id="onlyUnsettled" type="checkbox" />
        未精算のみ
      </label>
    </div>
  </div>
</div>

<div class="grid cols-3" style="margin-top:12px;">
  <div class="card">
    <div class="kpiLabel">表示中 件数</div>
    <div class="kpiValue" style="font-size:26px;" id="kpiCount">—</div>
    <div class="kpiSub muted2" id="kpiCountSub">—</div>
  </div>
  <div class="card">
    <div class="kpiLabel">表示中 合計</div>
    <div class="kpiValue" style="font-size:26px;" id="kpiTotal">—</div>
    <div class="kpiSub muted2">フィルタ後の合計</div>
  </div>
  <div class="card">
    <div class="kpiLabel">表示中 未精算</div>
    <div class="kpiValue" style="font-size:26px;" id="kpiUnsettled">—</div>
    <div class="kpiSub muted2">フィルタ後の未精算合計</div>
  </div>
</div>

<div class="card" style="margin-top:12px;">
  <div class="row" style="justify-content:space-between;">
    <div class="muted" id="summary">読み込み中...</div>
    <div class="row">
      <a class="btn ghost" href="/spend">経費使用を追加</a>
      <a class="btn ghost" href="/images">画像一覧</a>
    </div>
  </div>

  <div class="tableWrap" style="margin-top:12px;">
    <table id="tbl">
      <thead>
        <tr>
          <th style="width:110px;">操作</th>
          <th>利用日付</th>
          <th>使用用途</th>
          <th class="right">金額</th>
          <th>支払先</th>
          <th>ステータス</th>
          <th>証憑</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <div class="muted2" style="margin-top:10px;">行をクリックすると詳細を表示します。</div>
</div>

<div id="toast" class="toast"></div>

<!-- Detail Modal -->
<div id="modalBackdrop" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:9998;"></div>
<div id="modal" style="display:none; position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
  width:min(760px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow:auto;
  border-radius:16px; border:1px solid rgba(255,255,255,0.18);
  background: rgba(20,20,24,0.92); color:#fff; z-index:9999; padding:16px; backdrop-filter: blur(10px); box-shadow: 0 18px 40px rgba(0,0,0,0.4);">
  <div class="row" style="justify-content:space-between; align-items:flex-start;">
    <div>
      <div class="muted2" style="font-size:12px;">取引詳細</div>
      <div id="mTitle" style="font-size:18px; font-weight:800; margin-top:2px;">—</div>
      <div class="muted" id="mSub" style="margin-top:6px;">—</div>
    </div>
    <button class="secondary" type="button" id="mClose">閉じる</button>
  </div>

  <div class="divider"></div>

  <div class="grid cols-2">
    <div>
      <div class="muted2" style="font-size:12px;">利用日付</div>
      <div id="mDate" style="margin-top:4px;">—</div>
    </div>
    <div>
      <div class="muted2" style="font-size:12px;">金額</div>
      <div id="mAmount" style="margin-top:4px; font-weight:800;">—</div>
    </div>
    <div>
      <div class="muted2" style="font-size:12px;">支払先</div>
      <div id="mVendor" style="margin-top:4px;">—</div>
    </div>
    <div>
      <div class="muted2" style="font-size:12px;">ステータス</div>
      <div id="mStatus" style="margin-top:4px;">—</div>
    </div>
    <div>
      <div class="muted2" style="font-size:12px;">作成者</div>
      <div id="mCreator" style="margin-top:4px;">—</div>
    </div>
    <div>
      <div class="muted2" style="font-size:12px;">利用月</div>
      <div id="mMonth" style="margin-top:4px;">—</div>
    </div>
  </div>

  <div class="divider"></div>

  <div>
    <div class="muted2" style="font-size:12px;">領収書URL</div>
    <div style="margin-top:6px;" id="mReceipt">—</div>
  </div>

  <div class="row" style="margin-top:12px;">
    <button type="button" id="mSettleBtn" style="display:none;">精算済にする</button>
    <button class="secondary" type="button" id="mCopyBtn" style="display:none;">URLをコピー</button>
    <a class="btn ghost" id="mOpen" href="#" target="_blank" rel="noopener" style="display:none;">開く</a>
    <a class="btn ghost" id="mDl" href="#" target="_blank" rel="noopener" style="display:none;">DL</a>
  </div>
</div>

<script>
let ALL = [];
let CURRENT = null;

const monthSel = document.getElementById('month');
const tbody = document.querySelector('#tbl tbody');
const summary = document.getElementById('summary');
const qEl = document.getElementById('q');
const onlyUnsettledEl = document.getElementById('onlyUnsettled');

function yen(n){ return (n||0).toLocaleString('ja-JP') + ' 円'; }
function esc(s){
  return String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => { el.style.display = 'none'; }, 1200);
}

async function copyText(t) {
  await navigator.clipboard.writeText(t);
  showToast('コピーしました');
}

function setMonths(months) {
  monthSel.innerHTML = months.map(m => '<option value="' + m + '">' + m + '</option>').join('');
}

async function loadMonths() {
  const r = await fetch('/meta');
  const j = await r.json();
  if (j.months && j.months.length) setMonths(j.months);
}

function statusPill(s) {
  if (!s) return '<span class="pill">—</span>';
  if (s === '未精算') return '<span class="pill bad">未精算</span>';
  if (s === '精算済') return '<span class="pill good">精算済</span>';
  return '<span class="pill">' + esc(s) + '</span>';
}

function receiptCell(url) {
  if (!url) return '<span class="muted">—</span>';
  const openLink = '<a href="/open?gcs=' + encodeURIComponent(url) + '" target="_blank" rel="noopener">開く</a>';
  const dlLink = '<a href="/download?gcs=' + encodeURIComponent(url) + '" target="_blank" rel="noopener" style="margin-left:8px;">DL</a>';
  return '<code>' + esc(url) + '</code><div style="margin-top:6px;">' + openLink + dlLink + '</div>';
}

function rowHtml(x) {
  const canSettle = x.status === '未精算';
  const settleBtn = canSettle
    ? '<button type="button" onclick="settleInline(\\'' + x.pageId + '\\', event)">精算</button>'
    : '<button type="button" class="secondary" disabled style="opacity:.55; cursor:not-allowed;">—</button>';

  return '<tr data-id="' + esc(x.pageId) + '" style="cursor:pointer;">' +
    '<td>' + settleBtn + '</td>' +
    '<td>' + esc(x.date || '') + '</td>' +
    '<td>' + esc(x.title || '') + '</td>' +
    '<td class="right">' + (x.amount || 0).toLocaleString('ja-JP') + '</td>' +
    '<td>' + esc(x.vendor || '') + '</td>' +
    '<td>' + statusPill(x.status) + '</td>' +
    '<td>' + receiptCell(x.receiptUrl || '') + '</td>' +
  '</tr>';
}

function applyFilters() {
  const m = monthSel.value;
  const q = (qEl.value || '').trim().toLowerCase();
  const onlyUnsettled = !!onlyUnsettledEl.checked;

  let items = ALL.slice();

  if (q) {
    items = items.filter(x => {
      const t = (x.title||'').toLowerCase();
      const v = (x.vendor||'').toLowerCase();
      return t.includes(q) || v.includes(q);
    });
  }
  if (onlyUnsettled) {
    items = items.filter(x => x.status === '未精算');
  }

  tbody.innerHTML = '';
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">条件に一致するデータがありません。</td></tr>';
  } else {
    items.forEach(x => {
      const tr = document.createElement('tr');
      tr.innerHTML = rowHtml(x);
      tr.setAttribute('data-id', x.pageId);
      tbody.appendChild(tr);
    });
  }

  const total = items.reduce((a,x)=>a+(x.amount||0),0);
  const unsettled = items.filter(x=>x.status==='未精算').reduce((a,x)=>a+(x.amount||0),0);

  document.getElementById('kpiCount').textContent = (items.length || 0).toLocaleString('ja-JP');
  document.getElementById('kpiCountSub').textContent =
    '月: ' + m + (q ? (' / 検索あり') : '') + (onlyUnsettled ? ' / 未精算のみ' : '');

  document.getElementById('kpiTotal').textContent = yen(total);
  document.getElementById('kpiUnsettled').textContent = yen(unsettled);

  summary.textContent = '月: ' + m + ' / 表示: ' + items.length + ' 件';
}

async function loadData() {
  const m = monthSel.value;
  summary.textContent = '読み込み中...';
  tbody.innerHTML = '';
  const r = await fetch('/settlements/data?month=' + encodeURIComponent(m));
  const j = await r.json();
  if (j.error) {
    summary.textContent = '取得失敗: ' + j.error;
    tbody.innerHTML = '<tr><td colspan="7" class="muted">取得に失敗しました。</td></tr>';
    return;
  }

  ALL = (j.items || []);
  if (!ALL.length) {
    summary.textContent = '月: ' + m + ' / 件数: 0';
    tbody.innerHTML = '<tr><td colspan="7" class="muted">この月の取引はまだありません。</td></tr>';
    document.getElementById('kpiCount').textContent = '0';
    document.getElementById('kpiTotal').textContent = yen(0);
    document.getElementById('kpiUnsettled').textContent = yen(0);
    return;
  }

  applyFilters();
}

async function settle(pageId) {
  const r = await fetch('/settle', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ pageId })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
}

window.settleInline = async function(pageId, ev) {
  if (ev) ev.stopPropagation();
  if (!confirm('この取引を「精算済」に更新しますか？')) return;
  try {
    await settle(pageId);
    showToast('更新しました');
    await loadData();
    if (CURRENT && CURRENT.pageId === pageId) {
      closeModal();
    }
  } catch (e) {
    alert('更新失敗: ' + String(e.message || e));
  }
};

// Row click -> modal (ignore clicks on links/buttons)
tbody.addEventListener('click', (ev) => {
  const tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : '';
  if (tag === 'a' || tag === 'button' || tag === 'input' || tag === 'label') return;

  const tr = ev.target.closest('tr');
  if (!tr) return;
  const id = tr.getAttribute('data-id');
  if (!id) return;
  const item = ALL.find(x => x.pageId === id);
  if (!item) return;
  openModal(item);
});

function openModal(item) {
  CURRENT = item;

  document.getElementById('mTitle').textContent = item.title || '—';
  document.getElementById('mSub').textContent = item.vendor ? ('支払先: ' + item.vendor) : '—';
  document.getElementById('mDate').textContent = item.date || '—';
  document.getElementById('mAmount').textContent = yen(item.amount || 0);
  document.getElementById('mVendor').textContent = item.vendor || '—';
  document.getElementById('mCreator').textContent = item.creator || '—';
  document.getElementById('mMonth').textContent = item.month || monthSel.value || '—';
  document.getElementById('mStatus').innerHTML = statusPill(item.status);

  const url = item.receiptUrl || '';
  const receiptBox = document.getElementById('mReceipt');

  if (url) {
    receiptBox.innerHTML = '<code>' + esc(url) + '</code>';
    const copyBtn = document.getElementById('mCopyBtn');
    copyBtn.style.display = '';
    copyBtn.onclick = () => copyText(url);

    const openA = document.getElementById('mOpen');
    const dlA = document.getElementById('mDl');
    openA.href = '/open?gcs=' + encodeURIComponent(url);
    dlA.href = '/download?gcs=' + encodeURIComponent(url);
    openA.style.display = '';
    dlA.style.display = '';
  } else {
    receiptBox.innerHTML = '<span class="muted">—</span>';
    document.getElementById('mCopyBtn').style.display = 'none';
    document.getElementById('mOpen').style.display = 'none';
    document.getElementById('mDl').style.display = 'none';
  }

  const settleBtn = document.getElementById('mSettleBtn');
  if (item.status === '未精算') {
    settleBtn.style.display = '';
    settleBtn.textContent = '精算済にする';
    settleBtn.onclick = async () => {
      if (!confirm('この取引を「精算済」に更新しますか？')) return;
      try {
        await settle(item.pageId);
        showToast('更新しました');
        closeModal();
        await loadData();
      } catch (e) {
        alert('更新失敗: ' + String(e.message || e));
      }
    };
  } else {
    settleBtn.style.display = 'none';
  }

  document.getElementById('modalBackdrop').style.display = '';
  document.getElementById('modal').style.display = '';
}

function closeModal() {
  document.getElementById('modalBackdrop').style.display = 'none';
  document.getElementById('modal').style.display = 'none';
  CURRENT = null;
}

document.getElementById('mClose').addEventListener('click', closeModal);
document.getElementById('modalBackdrop').addEventListener('click', closeModal);

document.getElementById('reload').addEventListener('click', loadData);
qEl.addEventListener('input', () => applyFilters());
onlyUnsettledEl.addEventListener('change', () => applyFilters());

(async () => {
  await loadMonths();
  await loadData();
})();
</script>
`,
    })
  );
});

app.get("/settlements/data", async (req, res) => {
  try {
    const month = String(req.query.month || "").trim();
    if (!month) return res.status(400).json({ error: "month is required" });

    const pages = await queryExpensesPaged({
      filter: {
        and: [
          { property: EXP.type, select: { equals: "使用" } },
          { property: EXP.month, select: { equals: month } },
        ],
      },
      sorts: [{ property: EXP.date, direction: "ascending" }],
    });

    const items = pages.map((p) => ({
      pageId: p.id,
      date: getDateFromPage(p),
      month: getSelectNameFromPage(p, EXP.month) || month,
      type: getSelectNameFromPage(p, EXP.type),
      title: getTitleFromPage(p),
      amount: getNumberFromPage(p),
      vendor: getRichTextFromPage(p, EXP.vendor),
      creator: getSelectNameFromPage(p, EXP.creator),
      status: getSelectNameFromPage(p, EXP.status),
      receiptUrl: getUrlFromPage(p),
    }));

    res.json({ items });
  } catch (e) {
    console.error("settlements/data error:", e.response?.data || e);
    res.status(500).json({ error: "Failed to load settlements", detail: e.response?.data || String(e) });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const pageId = String(req.body?.pageId || "").trim();
    if (!pageId) return res.status(400).json({ error: "pageId is required" });

    await updateStatus(pageId, "精算済");
    res.json({ ok: true });
  } catch (e) {
    console.error("settle error:", e.response?.data || e);
    res.status(500).json({ error: "Failed to update status", detail: e.response?.data || String(e) });
  }
});

// ============================================================================
// Start
// ============================================================================
app.listen(Number(PORT), () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Static: /public  (e.g. /css/app.css)`);
  console.log(`Using GCS bucket: ${GCS_BUCKET} (prefix: ${GCS_PREFIX})`);
});