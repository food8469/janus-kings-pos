// 野烏金 POS 系統 API - PostgreSQL 版
// 資料存在 Railway PostgreSQL，重新部署不會遺失

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');

// DATE 欄位（生日、加入日期）直接回傳 YYYY-MM-DD 文字，避免時區差一天
types.setTypeParser(1082, (v) => v);
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('缺少 DATABASE_URL：請在 Railway 的 Variables 加入 Postgres 的 DATABASE_URL');
  process.exit(1);
}

// Railway 內網 (*.railway.internal) 不用 SSL；公開連線需要
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('.railway.internal') ? false : { rejectUnauthorized: false },
});

// ============ 初始商品 ============
// 只在資料庫還沒有這些商品時建立一次。之後新增、改價格、下架都在後台操作，
// 改這裡不會覆蓋後台的修改。
const PRODUCTS = [
  { id: 101, series: '經典一口吃', name: '鹽味', price: 1280 },
  { id: 102, series: '經典一口吃', name: '紅酒', price: 1280 },
  { id: 103, series: '經典一口吃', name: '味噌', price: 1380 },
  { id: 104, series: '經典一口吃', name: '香辣', price: 1380 },
  { id: 105, series: '經典一口吃', name: '花雕', price: 1380 },
  { id: 106, series: '經典一口吃', name: '烏魚腱', price: 1280 },
  { id: 201, series: '頂規一口吃', name: '竹鹽', price: 1580 },
  { id: 202, series: '頂規一口吃', name: '玫瑰紅酒', price: 1580 },
  { id: 203, series: '頂規一口吃', name: '黑松露', price: 1580 },
  { id: 204, series: '頂規一口吃', name: '瑤柱干貝', price: 1580 },
  { id: 205, series: '頂規一口吃', name: '哇沙米', price: 1580 },
  { id: 301, series: '混搭款', name: '三珍', price: 1380 },
  { id: 302, series: '混搭款', name: '五珍', price: 1380 },
  { id: 303, series: '混搭款', name: '珍味', price: 1580 },
];

const STORE_KEYS = { '高雄': 'gaoxiong', '台中': 'taizhong' };

// 商品顯示名稱：「系列-口味」；系列和口味一樣（例如立體手拿盒）就只寫一次
const productLabel = (p) => (!p.name || p.series === p.name ? p.series : `${p.series}-${p.name}`);
const PAYMENT_METHODS = ['現金', 'LINE Pay', '信用卡'];
const STORES = ['高雄', '台中'];
// 門市顯示名稱（資料裡還是「高雄」「台中」，訊息裡高雄顯示成總部）
const storeName = (s) => (s === '高雄' ? '高雄總部' : `${s}門市`);

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id        INTEGER PRIMARY KEY,
      series    TEXT    NOT NULL,
      name      TEXT    NOT NULL,
      price     INTEGER NOT NULL,
      gaoxiong  INTEGER NOT NULL DEFAULT 0,
      taizhong  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sales (
      id            SERIAL PRIMARY KEY,
      product_id    INTEGER NOT NULL,
      product_name  TEXT    NOT NULL,
      price         INTEGER NOT NULL,
      quantity      INTEGER NOT NULL,
      total         INTEGER NOT NULL,
      store         TEXT    NOT NULL,
      staff         TEXT    NOT NULL,
      customer_name TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sales_created_at_idx ON sales (created_at);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
    -- 大分類（試吃、一口吃、整片兩數…），原有商品預設為「一口吃」
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '一口吃';
    -- 商品排列順序（後台可拖拉調整，前台照這個順序顯示）
    ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER;
    UPDATE products SET sort_order = id WHERE sort_order IS NULL;
    -- 商品圖片（壓縮後的 JPEG，存成 data URL）；image_version 用來讓瀏覽器換新圖
    ALTER TABLE products ADD COLUMN IF NOT EXISTS image TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS image_version INTEGER NOT NULL DEFAULT 0;
    -- 交班 / 關店小結
    CREATE TABLE IF NOT EXISTS shift_closes (
      id           SERIAL PRIMARY KEY,
      store        TEXT NOT NULL,
      staff        TEXT NOT NULL,
      start_at     TIMESTAMPTZ NOT NULL,
      end_at       TIMESTAMPTZ NOT NULL,
      orders       INTEGER NOT NULL,
      items        INTEGER NOT NULL,
      total        INTEGER NOT NULL,
      cash         INTEGER NOT NULL,
      linepay      INTEGER NOT NULL,
      card         INTEGER NOT NULL,
      other        INTEGER NOT NULL,
      discount     INTEGER NOT NULL,
      counted_cash INTEGER NOT NULL,
      diff         INTEGER NOT NULL,
      note         TEXT,
      device_name  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS shift_closes_store_idx ON shift_closes (store, end_at);
    -- 折扣優惠（後台設定，前台結帳時點選）
    -- type = amount：減 value 元；type = percent：打 value 折（9 = 9 折、85 = 85 折）；
    -- type = custom：結帳時店員自己輸入折扣金額（value 不用）
    CREATE TABLE IF NOT EXISTS discounts (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL,
      value      NUMERIC NOT NULL,
      min_spend  INTEGER NOT NULL DEFAULT 0,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      note       TEXT
    );
    ALTER TABLE discounts DROP CONSTRAINT IF EXISTS discounts_type_check;
    ALTER TABLE discounts ADD CONSTRAINT discounts_type_check CHECK (type IN ('amount', 'percent', 'custom'));
    -- 盤點：每次盤點一筆（日期、門市、盤點人），明細存每個商品的系統數量和實際數量
    CREATE TABLE IF NOT EXISTS stocktakes (
      id         SERIAL PRIMARY KEY,
      store      TEXT NOT NULL,
      count_date DATE NOT NULL,
      staff      TEXT,
      note       TEXT,
      applied    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS stocktake_items (
      id           SERIAL PRIMARY KEY,
      stocktake_id INTEGER NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
      product_id   INTEGER,
      category     TEXT,
      product_name TEXT NOT NULL,
      price        INTEGER NOT NULL DEFAULT 0,
      system_qty   INTEGER NOT NULL,
      counted_qty  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stocktake_items_parent_idx ON stocktake_items (stocktake_id);
    -- 從哪台門市平板盤點的（後台盤點是空白）
    ALTER TABLE stocktakes ADD COLUMN IF NOT EXISTS device_name TEXT;
    -- 門市調貨：to_store 叫貨 → from_store 出貨（庫存 −）→ to_store 進貨（庫存 +）
    -- status = requested（已叫貨）/ shipped（已出貨、運送中）/ received（已進貨）/ cancelled（已取消）
    CREATE TABLE IF NOT EXISTS transfer_orders (
      id           SERIAL PRIMARY KEY,
      from_store   TEXT NOT NULL,
      to_store     TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'requested',
      requested_by TEXT, requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), request_note TEXT,
      shipped_by   TEXT, shipped_at   TIMESTAMPTZ, ship_note    TEXT,
      received_by  TEXT, received_at  TIMESTAMPTZ, receive_note TEXT,
      cancelled_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS transfer_items (
      id           SERIAL PRIMARY KEY,
      order_id     INTEGER NOT NULL REFERENCES transfer_orders(id) ON DELETE CASCADE,
      product_id   INTEGER,
      category     TEXT,
      product_name TEXT NOT NULL,
      price        INTEGER NOT NULL DEFAULT 0,
      req_qty      INTEGER NOT NULL,
      ship_qty     INTEGER,
      recv_qty     INTEGER
    );
    CREATE INDEX IF NOT EXISTS transfer_items_parent_idx ON transfer_items (order_id);
    -- 前台圖卡圖片：key = 'cat:分類' 或 'series:分類|系列'
    CREATE TABLE IF NOT EXISTS tile_images (
      key     TEXT PRIMARY KEY,
      image   TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    -- 同一次結帳的品項共用一個單號
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS order_no TEXT;
    -- 整單折扣分到這一項的金額（total 已扣掉）
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount INTEGER NOT NULL DEFAULT 0;
    -- 顧客資料（姓名、電話、地址都可以空白）
    CREATE TABLE IF NOT EXISTS customers (
      id         SERIAL PRIMARY KEY,
      name       TEXT,
      phone      TEXT,
      address    TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS birthday DATE;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS note TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS source TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS joined_at DATE;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_id TEXT;
    -- 從舊系統匯入的累積消費（新系統的消費另外從 sales 計算）
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS legacy_spent INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS legacy_orders INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id INTEGER;
    -- 付款方式（現金 / LINE Pay / 信用卡）與統一編號
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_method TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS tax_id TEXT;
    CREATE INDEX IF NOT EXISTS sales_customer_id_idx ON sales (customer_id);
    -- 人員打卡
    CREATE TABLE IF NOT EXISTS attendance (
      id         SERIAL PRIMARY KEY,
      staff      TEXT NOT NULL,
      store      TEXT NOT NULL,
      type       TEXT NOT NULL CHECK (type IN ('in', 'out')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS attendance_created_at_idx ON attendance (created_at);
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS note TEXT;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS device_name TEXT;
    -- 員工（打卡密碼存雜湊值，不存原始密碼）
    CREATE TABLE IF NOT EXISTS staff (
      name       TEXT PRIMARY KEY,
      pin_hash   TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- 員工所屬門市：'高雄'、'台中'，NULL = 兩店都有
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS store TEXT;
    -- 員工排列順序（後台可拖拉調整，前台打卡和銷售人員照這個順序）
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS sort_order INTEGER;
    UPDATE staff SET sort_order = o.ord FROM (
      SELECT name, ROW_NUMBER() OVER (ORDER BY created_at, name) AS ord FROM staff
    ) o WHERE staff.name = o.name AND staff.sort_order IS NULL;
    -- 門市裝置（只有登記過的裝置可以使用前台與打卡）
    CREATE TABLE IF NOT EXISTS punch_devices (
      id         SERIAL PRIMARY KEY,
      token      TEXT NOT NULL UNIQUE,
      name       TEXT NOT NULL,
      store      TEXT NOT NULL,
      revoked    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // 員工名單是空的才放入預設人員（之後在後台管理）
  const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM staff');
  if (count === 0) {
    for (const name of ['陳淑貞', '黃亭菱', '林岱蓉', '蔡秀梅']) {
      await pool.query('INSERT INTO staff (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    }
  }
  for (const p of PRODUCTS) {
    await pool.query(
      `INSERT INTO products (id, series, name, price) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.series, p.name, p.price]
    );
  }
}

// 數字欄位：空值回傳 null，非整數或負數丟出錯誤
function toInt(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InputError(`${label}必須是 0 以上的整數`);
  return n;
}

class InputError extends Error {}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============ 後台密碼（瀏覽器會跳出帳號密碼視窗） ============
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const [type, encoded] = (req.headers.authorization || '').split(' ');
  if (type !== 'Basic' || !encoded) return false;
  const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
  return user === ADMIN_USER && rest.join(':') === ADMIN_PASSWORD;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send('尚未設定 ADMIN_PASSWORD，請到 Railway Variables 設定');
  }
  if (isAdmin(req)) return next();
  // 前台「登記裝置」表單自己輸入帳密，不要跳出瀏覽器的登入視窗
  if (!req.get('X-No-Auth-Prompt')) res.set('WWW-Authenticate', 'Basic realm="POS Admin", charset="UTF-8"');
  res.status(401).json({ status: 'error', message: '後台帳號或密碼錯誤' });
}

// 前台功能只限登記過的門市裝置（或已登入後台的管理者）
async function requireDevice(req, res, next) {
  const device = await findDevice(req.get('X-Device-Token'));
  if (device) {
    req.device = device;
    return next();
  }
  if (isAdmin(req)) {
    req.device = null;
    return next();
  }
  res.status(403).json({ status: 'error', code: 'DEVICE_NOT_AUTHORIZED', message: '此裝置未授權，請店長登記這台裝置' });
}

// ============ 頁面 ============
// 每次都向伺服器確認是不是最新版，平板 App 才不會一直用舊的頁面
const sendPage = (file) => (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, file));
};
app.get('/', sendPage('pos-checkout.html'));
app.get('/admin', requireAdmin, sendPage('pos-admin.html'));

// App 設定檔與圖示（加到主畫面用）
app.get(/^\/(manifest-(pos|admin)\.webmanifest|icon-(pos|admin)-(180|192|512)\.png)$/, (req, res) => {
  if (req.path.endsWith('.webmanifest')) res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, req.path.slice(1)));
});

// ============ API 端點 ============

// 1. 獲得庫存
app.get('/api/inventory', requireDevice, async (req, res) => {
  // 圖片本身很大，不放在清單裡；前台用 /api/products/:id/image 另外讀
  const { rows } = await pool.query(
    `SELECT id, category, series, name, price, gaoxiong, taizhong, active, sort_order,
            image IS NOT NULL AS has_image, image_version
     FROM products ORDER BY sort_order NULLS LAST, id`);
  res.json({ status: 'success', data: rows });
});

// 商品圖片（公開，網址帶 ?v= 版本號，瀏覽器可以長期快取）
app.get('/api/products/:id/image', async (req, res) => {
  const { rows: [p] } = await pool.query('SELECT image FROM products WHERE id = $1', [toInt(req.params.id, '商品')]);
  const m = p && p.image && p.image.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(m[1]).send(Buffer.from(m[2], 'base64'));
});

// ============ 交班 / 關店小結 ============
// 期間：這家門市上一次小結的結束時間 → 現在；第一次小結就從今天 0 點（台灣時間）開始
async function closeSummary(store) {
  const { rows: [last] } = await pool.query(
    'SELECT end_at FROM shift_closes WHERE store = $1 ORDER BY end_at DESC LIMIT 1', [store]);
  const { rows: [{ now, today }] } = await pool.query(
    `SELECT NOW() AS now, ((NOW() AT TIME ZONE 'Asia/Taipei')::date::timestamp AT TIME ZONE 'Asia/Taipei') AS today`);
  const start = last ? last.end_at : today;
  const { rows: [s] } = await pool.query(
    `SELECT COUNT(DISTINCT COALESCE(order_no, id::text))::int AS orders,
            COALESCE(SUM(quantity), 0)::int AS items,
            COALESCE(SUM(total), 0)::int AS total,
            COALESCE(SUM(total) FILTER (WHERE payment_method = '現金'), 0)::int AS cash,
            COALESCE(SUM(total) FILTER (WHERE payment_method = 'LINE Pay'), 0)::int AS linepay,
            COALESCE(SUM(total) FILTER (WHERE payment_method = '信用卡'), 0)::int AS card,
            COALESCE(SUM(total) FILTER (WHERE payment_method IS NULL OR payment_method NOT IN ('現金', 'LINE Pay', '信用卡')), 0)::int AS other,
            COALESCE(SUM(discount), 0)::int AS discount
     FROM sales WHERE store = $1 AND created_at > $2 AND created_at <= $3`, [store, start, now]);
  return { store, start_at: start, end_at: now, ...s };
}

// 前台：目前這一段的小結預覽（還沒存）
app.get('/api/pos/close/preview', requireDevice, async (req, res) => {
  const store = req.device ? req.device.store : req.query.store;
  if (!STORE_KEYS[store]) return res.status(400).json({ status: 'error', message: '門市錯誤' });
  res.json({ status: 'success', data: await closeSummary(store) });
});

// 前台：完成小結（金額由伺服器重新計算，不信任前台傳來的數字）
app.post('/api/pos/close', requireDevice, async (req, res) => {
  const store = req.device ? req.device.store : req.body?.store;
  if (!STORE_KEYS[store]) return res.status(400).json({ status: 'error', message: '門市錯誤' });
  const staff = cleanText(req.body?.staff, 30);
  if (!staff) return res.status(400).json({ status: 'error', message: '請選擇小結人員' });
  const counted = toInt(req.body?.counted_cash, '實點現金');
  if (counted === null) return res.status(400).json({ status: 'error', message: '請輸入實際點到的現金' });

  const s = await closeSummary(store);
  const { rows: [row] } = await pool.query(
    `INSERT INTO shift_closes (store, staff, start_at, end_at, orders, items, total, cash, linepay, card, other, discount,
                               counted_cash, diff, note, device_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
    [store, staff, s.start_at, s.end_at, s.orders, s.items, s.total, s.cash, s.linepay, s.card, s.other, s.discount,
     counted, counted - s.cash, cleanText(req.body?.note, 300), req.device ? req.device.name : '後台']);
  res.json({ status: 'success', message: '小結完成', data: row });
});

// 前台：這家門市最近的小結
app.get('/api/pos/close/history', requireDevice, async (req, res) => {
  const store = req.device ? req.device.store : req.query.store;
  const { rows } = await pool.query(
    'SELECT * FROM shift_closes WHERE store = $1 ORDER BY end_at DESC LIMIT 20', [store]);
  res.json({ status: 'success', data: rows });
});

// 後台：小結紀錄（?from=&to= 依小結日期，台灣時間）
app.get('/api/admin/closes', requireAdmin, async (req, res) => {
  const where = [], params = [];
  const local = `(end_at AT TIME ZONE 'Asia/Taipei')::date`;
  if (cleanDate(req.query.from)) { params.push(req.query.from); where.push(`${local} >= $${params.length}::date`); }
  if (cleanDate(req.query.to)) { params.push(req.query.to); where.push(`${local} <= $${params.length}::date`); }
  if (STORE_KEYS[req.query.store]) { params.push(req.query.store); where.push(`store = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT * FROM shift_closes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY end_at DESC LIMIT 2000`, params);
  res.json({ status: 'success', data: rows });
});

// 後台：刪除一筆小結（例如按錯）；刪掉後下一次小結會從前一筆的結束時間開始算
app.post('/api/admin/closes/delete', requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM shift_closes WHERE id = $1', [toInt(req.body?.id, '小結')]);
  if (!rowCount) return res.status(404).json({ status: 'error', message: '找不到這筆小結' });
  res.json({ status: 'success', message: '已刪除這筆小結' });
});

// ============ 折扣優惠 ============
const toDiscount = (r) => ({ ...r, value: Number(r.value) });

// 前台：上架中的優惠
app.get('/api/discounts', requireDevice, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM discounts WHERE active ORDER BY sort_order, id');
  res.json({ status: 'success', data: rows.map(toDiscount) });
});

// 後台：全部優惠
app.get('/api/admin/discounts', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM discounts ORDER BY sort_order, id');
  res.json({ status: 'success', data: rows.map(toDiscount) });
});

// 後台：新增（沒有 id）或修改（有 id）優惠
app.post('/api/admin/discounts', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 50);
  const type = ['percent', 'custom'].includes(b.type) ? b.type : 'amount';
  const value = type === 'custom' ? 0 : Number(b.value);
  const minSpend = toInt(b.min_spend, '滿額門檻') ?? 0;
  const note = String(b.note || '').trim().slice(0, 200) || null;
  const active = b.active === undefined ? true : !!b.active;
  if (!name) return res.status(400).json({ status: 'error', message: '請填優惠名稱' });
  if (type === 'amount' && !(Number.isInteger(value) && value > 0)) {
    return res.status(400).json({ status: 'error', message: '折抵金額請填大於 0 的整數' });
  }
  const rate = value < 10 ? value / 10 : value / 100;
  if (type === 'percent' && !(rate > 0 && rate < 1)) {
    return res.status(400).json({ status: 'error', message: '打折請填 1～99，例如 9 折填 9、85 折填 85' });
  }

  if (b.id) {
    const { rows: [d] } = await pool.query(
      `UPDATE discounts SET name = $2, type = $3, value = $4, min_spend = $5, note = $6, active = $7
       WHERE id = $1 RETURNING *`, [Number(b.id), name, type, value, minSpend, note, active]);
    if (!d) return res.status(404).json({ status: 'error', message: '找不到這個優惠' });
    return res.json({ status: 'success', message: '優惠已更新', data: toDiscount(d) });
  }
  const { rows: [d] } = await pool.query(
    `INSERT INTO discounts (name, type, value, min_spend, note, active, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM discounts)) RETURNING *`,
    [name, type, value, minSpend, note, active]);
  res.json({ status: 'success', message: '優惠已新增', data: toDiscount(d) });
});

// 後台：上架 / 停用
app.post('/api/admin/discounts/active', requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query('UPDATE discounts SET active = $2 WHERE id = $1', [Number(req.body?.id), !!req.body?.active]);
  if (!rowCount) return res.status(404).json({ status: 'error', message: '找不到這個優惠' });
  res.json({ status: 'success', message: req.body?.active ? '已啟用' : '已停用' });
});

// 後台：排序（ids 依新順序）
app.post('/api/admin/discounts/reorder', requireAdmin, async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  for (let i = 0; i < ids.length; i++) {
    await pool.query('UPDATE discounts SET sort_order = $2 WHERE id = $1', [ids[i], i + 1]);
  }
  res.json({ status: 'success', message: '排序已儲存' });
});

app.post('/api/admin/discounts/delete', requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM discounts WHERE id = $1', [Number(req.body?.id)]);
  if (!rowCount) return res.status(404).json({ status: 'error', message: '找不到這個優惠' });
  res.json({ status: 'success', message: '優惠已刪除' });
});

// ============ 前台圖卡圖片（分類卡、系列卡）============
const isImageData = (s) => /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s);

// 有哪些圖卡有圖：{ key: version }
app.get('/api/tile-images', requireDevice, async (req, res) => {
  const { rows } = await pool.query('SELECT key, version FROM tile_images');
  res.json({ status: 'success', data: Object.fromEntries(rows.map(r => [r.key, r.version])) });
});

// 圖卡圖片（公開，網址帶 ?v= 版本號，瀏覽器可以長期快取）
app.get('/api/tile-image', async (req, res) => {
  const { rows: [t] } = await pool.query('SELECT image FROM tile_images WHERE key = $1', [String(req.query.key || '')]);
  const m = t && t.image.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(m[1]).send(Buffer.from(m[2], 'base64'));
});

app.post('/api/admin/tile-images', requireAdmin, async (req, res) => {
  const key = String(req.body?.key || '').slice(0, 200);
  const image = String(req.body?.image || '');
  if (!/^(cat|series):./.test(key)) return res.status(400).json({ status: 'error', message: '圖卡錯誤' });
  if (!isImageData(image)) return res.status(400).json({ status: 'error', message: '圖片格式錯誤' });
  if (image.length > 2_000_000) return res.status(400).json({ status: 'error', message: '圖片太大' });
  await pool.query(
    `INSERT INTO tile_images (key, image) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET image = EXCLUDED.image, version = tile_images.version + 1`, [key, image]);
  res.json({ status: 'success', message: '已更新圖片' });
});

app.post('/api/admin/tile-images/delete', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM tile_images WHERE key = $1', [String(req.body?.key || '')]);
  res.json({ status: 'success', message: '已移除圖片' });
});

// 後台：上傳圖片，可以一次套用到好幾個商品（同一口味的不同重量）
app.post('/api/admin/products/image', requireAdmin, async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  const image = String(req.body?.image || '');
  if (!ids.length) return res.status(400).json({ status: 'error', message: '請選擇商品' });
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) return res.status(400).json({ status: 'error', message: '圖片格式錯誤' });
  if (image.length > 2_000_000) return res.status(400).json({ status: 'error', message: '圖片太大' });
  const { rowCount } = await pool.query(
    'UPDATE products SET image = $2, image_version = image_version + 1 WHERE id = ANY($1)', [ids, image]);
  res.json({ status: 'success', message: `已更新 ${rowCount} 個商品的圖片` });
});

// 後台：移除圖片
app.post('/api/admin/products/image/delete', requireAdmin, async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  if (!ids.length) return res.status(400).json({ status: 'error', message: '請選擇商品' });
  const { rowCount } = await pool.query(
    'UPDATE products SET image = NULL, image_version = image_version + 1 WHERE id = ANY($1)', [ids]);
  res.json({ status: 'success', message: `已移除 ${rowCount} 個商品的圖片` });
});

// 2. 銷售（結帳）
app.post('/api/sales/create', requireDevice, async (req, res) => {
  const { product_id, quantity, staff, customer_name, order_no } = req.body || {};
  // 門市以裝置登記的為準
  const store = req.device ? req.device.store : req.body?.store;
  const qty = parseInt(quantity, 10);
  const storeKey = STORE_KEYS[store];

  if (!qty || qty <= 0) return res.status(400).json({ status: 'error', message: '數量錯誤' });
  if (!storeKey) return res.status(400).json({ status: 'error', message: '門市錯誤' });
  if (!staff) return res.status(400).json({ status: 'error', message: '請選擇銷售人員' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [product] } = await client.query(
      'SELECT * FROM products WHERE id = $1 FOR UPDATE', [product_id]);
    if (!product) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'error', message: '商品不存在' });
    }
    if (!product.active) {
      await client.query('ROLLBACK');
      return res.status(400).json({ status: 'error', message: `${product.name} 已下架，請重新整理頁面` });
    }

    // 庫存不足仍可結帳（庫存會變負數，後台看得到），避免庫存沒登錄時店裡無法賣東西
    // 整單折扣分到這個品項的金額（不能超過這項的金額）
    const lineDiscount = toInt(req.body?.discount, '折扣') ?? 0;
    if (lineDiscount > product.price * qty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ status: 'error', message: '折扣不能超過商品金額' });
    }

    await client.query(
      `UPDATE products SET ${storeKey} = ${storeKey} - $1 WHERE id = $2`, [qty, product.id]);

    const { rows: [row] } = await client.query(
      `INSERT INTO sales (product_id, product_name, price, quantity, total, store, staff, customer_name, order_no, discount, customer_id,
                          payment_method, tax_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [product.id, productLabel(product), product.price, qty, product.price * qty - lineDiscount,
       store, staff, (customer_name || '').trim() || '客人', String(order_no || '').slice(0, 40) || null, lineDiscount,
       toInt(req.body?.customer_id, '顧客'),
       PAYMENT_METHODS.includes(req.body?.payment_method) ? req.body.payment_method : null,
       /^\d{8}$/.test(String(req.body?.tax_id || '')) ? String(req.body.tax_id) : null]
    );
    await client.query('COMMIT');

    res.json({ status: 'success', message: '銷售成功', data: toRecord(row) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

function toRecord(r) {
  return {
    id: r.id,
    timestamp: r.created_at,
    product_name: r.product_name,
    quantity: r.quantity,
    price: r.price,
    total: r.total,
    store: r.store,
    staff: r.staff,
    customer_name: r.customer_name,
    order_no: r.order_no,
    discount: r.discount || 0,
    payment_method: r.payment_method,
    tax_id: r.tax_id,
  };
}

// ============ 顧客 ============
const cleanText = (v, max) => String(v ?? '').trim().slice(0, max) || null;

// 搜尋顧客（姓名、電話、地址）；沒輸入就列出最近建立的。?all=1 給後台列出全部
app.get('/api/customers', requireDevice, async (req, res) => {
  const q = String(req.query.q || '').trim();
  // 電話比對時忽略 - ( ) 空格，手機、市話都能搜；電話開頭符合的排前面
  const digits = q.replace(/[\s\-()]/g, '');
  const phoneQ = /^\d+$/.test(digits) ? digits : '';
  const limit = req.query.all ? 5000 : 30;
  const { rows } = await pool.query(
    `SELECT c.*,
            (SELECT COUNT(DISTINCT COALESCE(order_no, id::text)) FROM sales WHERE customer_id = c.id)::int AS orders,
            (SELECT COALESCE(SUM(total), 0) FROM sales WHERE customer_id = c.id)::int AS spent,
            (SELECT MAX(created_at) FROM sales WHERE customer_id = c.id) AS last_visit
     FROM customers c
     WHERE $1 = '' OR c.name ILIKE '%' || $1 || '%' OR c.phone ILIKE '%' || $1 || '%' OR c.address ILIKE '%' || $1 || '%'
        OR ($2 <> '' AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE '%' || $2 || '%')
     ORDER BY ($2 <> '' AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE $2 || '%') DESC, c.created_at DESC
     LIMIT ${limit}`, [q, phoneQ]);
  res.json({ status: 'success', data: rows });
});

// 後台：刪除顧客（過去的銷售紀錄保留，只是不再連到這位顧客）
app.post('/api/admin/customers/delete', requireAdmin, async (req, res) => {
  const id = toInt(req.body?.id, '顧客');
  const { rowCount } = await pool.query('DELETE FROM customers WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ status: 'error', message: '找不到這位顧客' });
  await pool.query('UPDATE sales SET customer_id = NULL WHERE customer_id = $1', [id]);
  res.json({ status: 'success', message: '已刪除顧客（過去的銷售紀錄會保留）' });
});

// 新增顧客（三個欄位都可以空白，但至少要填一個）
app.post('/api/customers', requireDevice, async (req, res) => {
  const name = cleanText(req.body?.name, 30);
  const phone = cleanText(req.body?.phone, 30);
  const address = cleanText(req.body?.address, 200);
  const birthday = cleanDate(req.body?.birthday);
  const taxId = cleanTaxId(req.body?.tax_id);
  if (!name && !phone && !address) return res.status(400).json({ status: 'error', message: '請至少填姓名、電話或地址其中一個' });
  if (phone && /\d/.test(phone)) {
    // 只比數字：0912-345-678 和 0912345678 算同一支電話
    const { rows: [dup] } = await pool.query(
      `SELECT * FROM customers WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g') LIMIT 1`, [phone]);
    if (dup) return res.status(409).json({ status: 'error', message: `這支電話已經建檔（${dup.name || '未填姓名'}）`, data: dup });
  }
  const { rows: [customer] } = await pool.query(
    'INSERT INTO customers (name, phone, address, birthday, tax_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name, phone, address, birthday, taxId]);
  res.json({ status: 'success', message: '已新增顧客', data: customer });
});

// 日期欄位：YYYY-MM-DD 或空白
function cleanDate(v) {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// 統一編號：8 位數字，其他（含空白）當作沒填
function cleanTaxId(v) {
  const s = String(v ?? '').replace(/\s/g, '');
  if (!s) return null;
  if (!/^\d{8}$/.test(s)) throw new InputError('統一編號要是 8 位數字');
  return s;
}

// 修改顧客資料（只改有送來的欄位）
app.post('/api/customers/update', requireDevice, async (req, res) => {
  const body = req.body || {};
  const fields = {
    name: () => cleanText(body.name, 30),
    phone: () => cleanText(body.phone, 30),
    address: () => cleanText(body.address, 200),
    note: () => cleanText(body.note, 500),
    birthday: () => cleanDate(body.birthday),
    tax_id: () => cleanTaxId(body.tax_id),
  };
  const sets = [];
  const params = [toInt(body.id, '顧客')];
  for (const [key, value] of Object.entries(fields)) {
    if (body[key] === undefined) continue;
    params.push(value());
    sets.push(`${key} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ status: 'error', message: '沒有要修改的欄位' });
  const { rows: [customer] } = await pool.query(
    `UPDATE customers SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  if (!customer) return res.status(404).json({ status: 'error', message: '找不到這位顧客' });
  res.json({ status: 'success', message: '已更新顧客資料', data: customer });
});

// 後台：從 Excel 匯入顧客（電話已存在 → 只補空白欄位、更新舊系統消費；不存在 → 新增）
app.post('/api/admin/customers/import', requireAdmin, async (req, res) => {
  const list = Array.isArray(req.body?.customers) ? req.body.customers.slice(0, 5000) : [];
  if (!list.length) return res.status(400).json({ status: 'error', message: '沒有要匯入的資料' });
  let added = 0, updated = 0, skipped = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of list) {
      const row = {
        name: cleanText(c.name, 30), phone: cleanText(c.phone, 30), address: cleanText(c.address, 200),
        note: cleanText(c.note, 500), source: cleanText(c.source, 100),
        birthday: cleanDate(c.birthday), joined_at: cleanDate(c.joined_at),
        tax_id: /^\d{8}$/.test(String(c.tax_id ?? '')) ? String(c.tax_id) : null,
        legacy_spent: Math.max(0, Math.round(Number(c.legacy_spent) || 0)),
        legacy_orders: Math.max(0, Math.round(Number(c.legacy_orders) || 0)),
      };
      if (!row.name && !row.phone && !row.address) { skipped++; continue; }
      const { rows: [existing] } = row.phone
        ? await client.query('SELECT id FROM customers WHERE phone = $1 LIMIT 1', [row.phone])
        : { rows: [] };
      if (existing) {
        await client.query(
          `UPDATE customers SET
             name = COALESCE(name, $2), address = COALESCE(address, $3), note = COALESCE(note, $4),
             source = COALESCE(source, $5), birthday = COALESCE(birthday, $6), joined_at = COALESCE(joined_at, $7),
             legacy_spent = $8, legacy_orders = $9, tax_id = COALESCE(tax_id, $10)
           WHERE id = $1`,
          [existing.id, row.name, row.address, row.note, row.source, row.birthday, row.joined_at, row.legacy_spent, row.legacy_orders, row.tax_id]);
        updated++;
      } else {
        await client.query(
          `INSERT INTO customers (name, phone, address, note, source, birthday, joined_at, legacy_spent, legacy_orders, tax_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($7::date::timestamptz, NOW()))`,
          [row.name, row.phone, row.address, row.note, row.source, row.birthday, row.joined_at, row.legacy_spent, row.legacy_orders, row.tax_id]);
        added++;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json({ status: 'success', message: `匯入完成：新增 ${added} 位、更新 ${updated} 位、略過 ${skipped} 筆空白`, data: { added, updated, skipped } });
});

// 顧客的歷史購買紀錄（含以前只打名字、沒有建檔的舊訂單）
app.get('/api/customers/:id/history', requireDevice, async (req, res) => {
  const { rows: [customer] } = await pool.query('SELECT * FROM customers WHERE id = $1', [toInt(req.params.id, '顧客')]);
  if (!customer) return res.status(404).json({ status: 'error', message: '找不到這位顧客' });
  const { rows } = await pool.query(
    `SELECT * FROM sales
     WHERE customer_id = $1 OR (customer_id IS NULL AND $2::text IS NOT NULL AND customer_name = $2)
     ORDER BY created_at DESC LIMIT 300`, [customer.id, customer.name]);
  res.json({ status: 'success', data: { customer, sales: rows.map(toRecord) } });
});

// 台灣時間的「今天」條件
const TODAY_SQL = `(created_at AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date`;

// 前台：今日結帳紀錄（只限今天、指定門市）
app.get('/api/pos/sales/today', requireDevice, async (req, res) => {
  const store = req.device ? req.device.store : req.query.store;
  if (!STORE_KEYS[store]) return res.status(400).json({ status: 'error', message: '門市錯誤' });
  const { rows } = await pool.query(
    `SELECT * FROM sales WHERE ${TODAY_SQL} AND store = $1 ORDER BY created_at DESC LIMIT 500`,
    [store]);
  res.json({ status: 'success', data: rows.map(toRecord) });
});

// ============ 打卡安全：門市裝置 + 員工密碼 ============

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
}

function checkPin(pin, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

async function findDevice(token) {
  if (!token) return null;
  const { rows: [device] } = await pool.query(
    'SELECT id, name, store FROM punch_devices WHERE token = $1 AND NOT revoked', [String(token)]);
  return device || null;
}

// 密碼連續錯 5 次，鎖 5 分鐘（防止亂猜）
const pinFailures = new Map();
const MAX_PIN_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;

// 前台：員工名單（只有名字）
app.get('/api/staff', requireDevice, async (req, res) => {
  // 門市裝置只拿到這家門市的人員（含兩店都有的）；後台拿全部
  const store = req.device ? req.device.store : null;
  const { rows } = await pool.query(
    'SELECT name FROM staff WHERE $1::text IS NULL OR store IS NULL OR store = $1 ORDER BY sort_order NULLS LAST, created_at, name', [store]);
  res.json({ status: 'success', data: rows.map(r => r.name) });
});

// 前台：檢查這台裝置能不能打卡
app.get('/api/punch-device', async (req, res) => {
  const device = await findDevice(req.query.token);
  if (!device) return res.status(404).json({ status: 'error', message: '這台裝置尚未登記為門市裝置' });
  res.json({ status: 'success', data: { name: device.name, store: device.store } });
});

// 前台：打卡（需要門市裝置 + 員工密碼）
app.post('/api/attendance/punch', async (req, res) => {
  const { staff, type, note, pin, device_token } = req.body || {};
  const name = String(staff || '').trim();
  if (!['in', 'out'].includes(type)) return res.status(400).json({ status: 'error', message: '打卡類型錯誤' });

  const device = await findDevice(device_token || req.get('X-Device-Token'));
  if (!device) return res.status(403).json({ status: 'error', code: 'DEVICE_NOT_AUTHORIZED', message: '這台裝置不能打卡，請店長登記這台裝置' });

  const { rows: [person] } = await pool.query('SELECT * FROM staff WHERE name = $1', [name]);
  if (!person) return res.status(400).json({ status: 'error', message: '請選擇人員' });
  if (!person.pin_hash) return res.status(400).json({ status: 'error', message: `${name} 還沒有打卡密碼，請店長到後台設定` });
  if (person.store && person.store !== device.store) {
    return res.status(400).json({ status: 'error', message: `${name} 是${storeName(person.store)}的人員，不能在${storeName(device.store)}打卡` });
  }

  const fail = pinFailures.get(name);
  if (fail && fail.count >= MAX_PIN_FAILURES && Date.now() - fail.at < LOCK_MS) {
    const min = Math.ceil((LOCK_MS - (Date.now() - fail.at)) / 60000);
    return res.status(429).json({ status: 'error', message: `密碼錯太多次，請 ${min} 分鐘後再試` });
  }
  if (!checkPin(pin || '', person.pin_hash)) {
    const count = fail && Date.now() - fail.at < LOCK_MS ? fail.count + 1 : 1;
    pinFailures.set(name, { count, at: Date.now() });
    const left = MAX_PIN_FAILURES - count;
    return res.status(401).json({ status: 'error',
      message: left > 0 ? `密碼錯誤（再錯 ${left} 次會鎖定 5 分鐘）` : '密碼錯太多次，請 5 分鐘後再試' });
  }
  pinFailures.delete(name);

  // 門市以裝置設定為準，不能自己選
  const { rows: [row] } = await pool.query(
    'INSERT INTO attendance (staff, store, type, note, device_name) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [name, device.store, type, String(note || '').trim().slice(0, 200) || null, device.name]);
  res.json({ status: 'success', message: type === 'in' ? '上班打卡成功' : '下班打卡成功', data: row });
});

// 前台：員工自己改打卡密碼（門市裝置 + 舊密碼；錯太多次一樣會鎖住）
app.post('/api/staff/pin/change', requireDevice, async (req, res) => {
  const { staff, old_pin, new_pin } = req.body || {};
  const name = String(staff || '').trim();
  const { rows: [person] } = await pool.query('SELECT * FROM staff WHERE name = $1', [name]);
  if (!person) return res.status(400).json({ status: 'error', message: '請選擇人員' });
  if (!person.pin_hash) return res.status(400).json({ status: 'error', message: `${name} 還沒有打卡密碼，請店長到後台設定` });
  if (req.device && person.store && person.store !== req.device.store) {
    return res.status(400).json({ status: 'error', message: `${name} 是${storeName(person.store)}的人員，請在${storeName(person.store)}的平板改密碼` });
  }
  if (!/^\d{4,6}$/.test(String(new_pin || ''))) return res.status(400).json({ status: 'error', message: '新密碼請填 4～6 位數字' });

  const fail = pinFailures.get(name);
  if (fail && fail.count >= MAX_PIN_FAILURES && Date.now() - fail.at < LOCK_MS) {
    const min = Math.ceil((LOCK_MS - (Date.now() - fail.at)) / 60000);
    return res.status(429).json({ status: 'error', message: `密碼錯太多次，請 ${min} 分鐘後再試` });
  }
  if (!checkPin(old_pin || '', person.pin_hash)) {
    const count = fail && Date.now() - fail.at < LOCK_MS ? fail.count + 1 : 1;
    pinFailures.set(name, { count, at: Date.now() });
    const left = MAX_PIN_FAILURES - count;
    return res.status(401).json({ status: 'error',
      message: left > 0 ? `舊密碼錯誤（再錯 ${left} 次會鎖定 5 分鐘）` : '密碼錯太多次，請 5 分鐘後再試' });
  }
  pinFailures.delete(name);
  await pool.query('UPDATE staff SET pin_hash = $2 WHERE name = $1', [name, hashPin(String(new_pin))]);
  res.json({ status: 'success', message: '密碼已更改，下次打卡請用新密碼' });
});

// 後台：員工名單與密碼狀態
app.get('/api/admin/staff', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT name, store, pin_hash IS NOT NULL AS has_pin FROM staff ORDER BY sort_order NULLS LAST, created_at, name');
  res.json({ status: 'success', data: rows });
});

// 調整員工順序：names 依新的順序排列
app.post('/api/admin/staff/reorder', requireAdmin, async (req, res) => {
  const names = (Array.isArray(req.body?.names) ? req.body.names : []).map(String);
  if (!names.length) return res.status(400).json({ status: 'error', message: '沒有要排序的員工' });
  await pool.query(
    `UPDATE staff SET sort_order = o.ord
     FROM unnest($1::text[]) WITH ORDINALITY AS o(name, ord)
     WHERE staff.name = o.name`, [names]);
  res.json({ status: 'success', message: '已更新順序' });
});

// 設定員工所屬門市（空白 = 兩店都有）
app.post('/api/admin/staff/store', requireAdmin, async (req, res) => {
  const store = STORE_KEYS[req.body?.store] ? req.body.store : null;
  const { rowCount } = await pool.query('UPDATE staff SET store = $2 WHERE name = $1', [req.body?.name, store]);
  if (!rowCount) return res.status(404).json({ status: 'error', message: '找不到這位員工' });
  res.json({ status: 'success', message: '已更新門市' });
});

app.post('/api/admin/staff', requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ status: 'error', message: '請填員工名字' });
  const store = STORE_KEYS[req.body?.store] ? req.body.store : null;
  const { rowCount } = await pool.query(`INSERT INTO staff (name, store, sort_order)
     VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM staff)) ON CONFLICT DO NOTHING`, [name, store]);
  if (!rowCount) return res.status(400).json({ status: 'error', message: `${name} 已經存在` });
  res.json({ status: 'success', message: '已新增員工' });
});

app.post('/api/admin/staff/pin', requireAdmin, async (req, res) => {
  const { name, pin } = req.body || {};
  if (!/^\d{4,6}$/.test(String(pin || ''))) return res.status(400).json({ status: 'error', message: '密碼請填 4～6 位數字' });
  const { rowCount } = await pool.query('UPDATE staff SET pin_hash = $2 WHERE name = $1', [name, hashPin(String(pin))]);
  if (!rowCount) return res.status(404).json({ status: 'error', message: '找不到這位員工' });
  pinFailures.delete(name);
  res.json({ status: 'success', message: '密碼已設定' });
});

app.post('/api/admin/staff/delete', requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM staff WHERE name = $1', [req.body?.name]);
  if (!rowCount) return res.status(404).json({ status: 'error', message: '找不到這位員工' });
  res.json({ status: 'success', message: '已刪除員工（過去的打卡和銷售紀錄會保留）' });
});

// 後台：門市裝置
app.get('/api/admin/devices', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, store, created_at FROM punch_devices WHERE NOT revoked ORDER BY created_at');
  res.json({ status: 'success', data: rows });
});

app.post('/api/admin/devices', requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 30);
  const store = req.body?.store;
  if (!name) return res.status(400).json({ status: 'error', message: '請填裝置名稱（例：高雄櫃台平板）' });
  if (!STORE_KEYS[store]) return res.status(400).json({ status: 'error', message: '門市錯誤' });

  // 同名稱、同門市已經登記過（例如清了瀏覽器資料要重新登記）→ 沿用原本那台，不重複新增
  const { rows: [existing] } = await pool.query(
    'SELECT id, name, store, token FROM punch_devices WHERE name = $1 AND store = $2 AND NOT revoked ORDER BY id LIMIT 1',
    [name, store]);
  if (existing) return res.json({ status: 'success', message: '已重新登入這台門市裝置', data: existing });

  const token = crypto.randomBytes(24).toString('hex');
  const { rows: [device] } = await pool.query(
    'INSERT INTO punch_devices (token, name, store) VALUES ($1, $2, $3) RETURNING id, name, store, token',
    [token, name, store]);
  res.json({ status: 'success', message: '已登記為門市裝置', data: device });
});

app.post('/api/admin/devices/revoke', requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query('UPDATE punch_devices SET revoked = TRUE WHERE id = $1', [req.body?.id]);
  if (!rowCount) return res.status(404).json({ status: 'error', message: '找不到這台裝置' });
  res.json({ status: 'success', message: '已停用這台裝置' });
});

// 前台：今日打卡紀錄（指定門市）
app.get('/api/attendance/today', requireDevice, async (req, res) => {
  const store = req.device ? req.device.store : req.query.store;
  if (!STORE_KEYS[store]) return res.status(400).json({ status: 'error', message: '門市錯誤' });
  const { rows } = await pool.query(
    `SELECT * FROM attendance WHERE ${TODAY_SQL} AND store = $1 ORDER BY created_at DESC`,
    [store]);
  res.json({ status: 'success', data: rows });
});

// 後台：打卡時間（datetime-local 的 YYYY-MM-DDTHH:mm，台灣時間）
function punchTime(v) {
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/);
  return m ? `${m[1]}T${m[2]}${m[3] || ':00'}+08:00` : null;
}

// 後台：修改一筆打卡（時間、上班/下班、門市、備註）
app.post('/api/admin/attendance/update', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const sets = [], params = [toInt(b.id, '打卡紀錄')];
  const add = (sql, v) => { params.push(v); sets.push(sql.replace('?', `$${params.length}`)); };
  if (b.time !== undefined) {
    const t = punchTime(b.time);
    if (!t) return res.status(400).json({ status: 'error', message: '時間格式錯誤' });
    add('created_at = ?', t);
  }
  if (b.type !== undefined) {
    if (!['in', 'out'].includes(b.type)) return res.status(400).json({ status: 'error', message: '請選上班或下班' });
    add('type = ?', b.type);
  }
  if (b.store !== undefined) {
    if (!STORE_KEYS[b.store]) return res.status(400).json({ status: 'error', message: '門市錯誤' });
    add('store = ?', b.store);
  }
  if (b.note !== undefined) add('note = ?', cleanText(b.note, 200));
  if (!sets.length) return res.status(400).json({ status: 'error', message: '沒有要修改的欄位' });
  const { rows: [row] } = await pool.query(`UPDATE attendance SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  if (!row) return res.status(404).json({ status: 'error', message: '找不到這筆打卡紀錄' });
  res.json({ status: 'success', message: '已修改', data: row });
});

// 後台：刪除打卡紀錄
app.post('/api/admin/attendance/delete', requireAdmin, async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  if (!ids.length) return res.status(400).json({ status: 'error', message: '沒有要刪除的紀錄' });
  const { rowCount } = await pool.query('DELETE FROM attendance WHERE id = ANY($1)', [ids]);
  res.json({ status: 'success', message: `已刪除 ${rowCount} 筆打卡紀錄` });
});

// 後台：補登打卡（員工忘記打卡時）
app.post('/api/admin/attendance/create', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const staff = cleanText(b.staff, 30);
  const time = punchTime(b.time);
  if (!staff) return res.status(400).json({ status: 'error', message: '請選擇人員' });
  if (!['in', 'out'].includes(b.type)) return res.status(400).json({ status: 'error', message: '請選上班或下班' });
  if (!STORE_KEYS[b.store]) return res.status(400).json({ status: 'error', message: '門市錯誤' });
  if (!time) return res.status(400).json({ status: 'error', message: '請填打卡時間' });
  const { rows: [row] } = await pool.query(
    `INSERT INTO attendance (staff, store, type, note, device_name, created_at)
     VALUES ($1, $2, $3, $4, '後台補登', $5) RETURNING *`,
    [staff, b.store, b.type, cleanText(b.note, 200), time]);
  res.json({ status: 'success', message: '已補登打卡', data: row });
});

// 後台：打卡紀錄（?month=YYYY-MM）
app.get('/api/attendance', requireAdmin, async (req, res) => {
  const { sql, params } = dateFilter(req.query);
  const { rows } = await pool.query(
    `SELECT * FROM attendance ${sql} ORDER BY created_at LIMIT 5000`, params);
  res.json({ status: 'success', data: rows });
});

// 日期篩選（台灣時間）：?date=YYYY-MM-DD 或 ?month=YYYY-MM
function dateFilter(q) {
  const local = `(created_at AT TIME ZONE 'Asia/Taipei')`;
  if (q.date) return { sql: `WHERE to_char(${local}, 'YYYY-MM-DD') = $1`, params: [q.date] };
  if (q.month) return { sql: `WHERE to_char(${local}, 'YYYY-MM') = $1`, params: [q.month] };
  // 日期區間：?from=YYYY-MM-DD&to=YYYY-MM-DD（可只給一邊）
  const where = [], params = [];
  if (cleanDate(q.from)) { params.push(q.from); where.push(`${local}::date >= $${params.length}::date`); }
  if (cleanDate(q.to)) { params.push(q.to); where.push(`${local}::date <= $${params.length}::date`); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// 3. 交易記錄
app.get('/api/sales/records', requireAdmin, async (req, res) => {
  let { sql, params } = dateFilter(req.query);
  if (req.query.staff) {
    params = [...params, req.query.staff];
    sql += `${sql ? ' AND' : 'WHERE'} staff = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM sales ${sql} ORDER BY created_at DESC LIMIT 10000`, params);
  res.json({ status: 'success', data: rows.map(r => ({ ...toRecord(r), product_id: r.product_id })) });
});

// 匯入交易紀錄（例如舊系統資料）：不扣庫存；編號已存在的略過，避免重複匯入
app.post('/api/admin/sales/import', requireAdmin, async (req, res) => {
  const list = Array.isArray(req.body?.sales) ? req.body.sales.slice(0, 10000) : [];
  if (!list.length) return res.status(400).json({ status: 'error', message: '沒有要匯入的資料' });
  const { rows: products } = await pool.query('SELECT id, series, name FROM products');
  const findProduct = (name) => products.find(p => productLabel(p) === name || `${p.series}-${p.name}` === name || p.name === name);

  let added = 0, skipped = 0, invalid = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of list) {
      const id = Number.isInteger(Number(s.id)) && Number(s.id) > 0 ? Number(s.id) : null;
      if (id) {
        const { rows: [exists] } = await client.query('SELECT 1 FROM sales WHERE id = $1', [id]);
        if (exists) { skipped++; continue; }
      }
      // 空白欄位當成「沒有」，不是 0
      const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? NaN : Number(String(v).replace(/[,$NT\s]/g, '')));
      const name = cleanText(s.product_name, 100);
      const qty = Math.round(num(s.quantity));
      const discount = Math.max(0, Math.round(num(s.discount) || 0));
      let price = Math.round(num(s.price));
      let total = Math.round(num(s.total));
      if (!Number.isFinite(price) && Number.isFinite(total) && qty) price = Math.round((total + discount) / qty);
      if (!Number.isFinite(total) && Number.isFinite(price)) total = price * qty - discount;
      if (!name || !qty || qty < 0 || !Number.isFinite(price) || !Number.isFinite(total)) { invalid++; continue; }

      const time = s.time && !isNaN(new Date(s.time)) ? new Date(s.time) : new Date();
      const product = findProduct(name);
      await client.query(
        `INSERT INTO sales (product_id, product_name, price, quantity, total, discount, store, staff, customer_name,
                            order_no, payment_method, tax_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [product ? product.id : 0, name, price, qty, total, discount,
         cleanText(s.store, 20) || '未指定', cleanText(s.staff, 30) || '未指定', cleanText(s.customer_name, 30) || '客人',
         cleanText(s.order_no, 40), PAYMENT_METHODS.includes(s.payment_method) ? s.payment_method : cleanText(s.payment_method, 20),
         /^\d{8}$/.test(String(s.tax_id || '')) ? String(s.tax_id) : null, time]);
      added++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json({ status: 'success', message: `匯入完成：新增 ${added} 筆、已存在略過 ${skipped} 筆、資料不完整略過 ${invalid} 筆`,
    data: { added, skipped, invalid } });
});

// 修改單筆銷售（銷售人員、數量、客人）；數量改變時庫存跟著調整
app.post('/api/admin/sales/update', requireAdmin, async (req, res) => {
  const { id, staff, quantity, customer_name, payment_method } = req.body || {};
  const qty = quantity === undefined ? null : toInt(quantity, '數量');
  const payment = PAYMENT_METHODS.includes(payment_method) ? payment_method : null;
  if (qty === 0) return res.status(400).json({ status: 'error', message: '數量不能是 0，不要這筆請用刪除' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [sale] } = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [id]);
    if (!sale) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'error', message: '找不到這筆銷售' });
    }
    const newQty = qty ?? sale.quantity;
    const storeKey = STORE_KEYS[sale.store];
    if (newQty !== sale.quantity && storeKey) {
      // 多賣 → 扣庫存；少賣 → 加回庫存（商品已刪除就略過）
      await client.query(
        `UPDATE products SET ${storeKey} = ${storeKey} - $1 WHERE id = $2`, [newQty - sale.quantity, sale.product_id]);
    }
    const { rows: [row] } = await client.query(
      `UPDATE sales SET quantity = $2,
              discount = LEAST(discount, price * $2),
              total = price * $2 - LEAST(discount, price * $2),
              staff = COALESCE($3, staff), customer_name = COALESCE($4, customer_name),
              payment_method = COALESCE($5, payment_method)
       WHERE id = $1 RETURNING *`,
      [id, newQty, String(staff || '').trim() || null,
       customer_name === undefined ? null : String(customer_name).trim() || '客人', payment]);
    await client.query('COMMIT');
    res.json({ status: 'success', message: '已修改', data: toRecord(row) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// 刪除銷售紀錄（ids 陣列）；賣出的數量加回庫存
app.post('/api/admin/sales/delete', requireAdmin, async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  if (!ids.length) return res.status(400).json({ status: 'error', message: '沒有要刪除的紀錄' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('DELETE FROM sales WHERE id = ANY($1) RETURNING *', [ids]);
    for (const sale of rows) {
      const storeKey = STORE_KEYS[sale.store];
      if (storeKey) {
        await client.query(
          `UPDATE products SET ${storeKey} = ${storeKey} + $1 WHERE id = $2`, [sale.quantity, sale.product_id]);
      }
    }
    await client.query('COMMIT');
    res.json({ status: 'success', message: `已刪除 ${rows.length} 筆，庫存已加回`, data: { deleted: rows.length } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// 4. 員工統計
app.get('/api/staff/stats', requireAdmin, async (req, res) => {
  const { sql, params } = dateFilter(req.query);
  const { rows } = await pool.query(
    `SELECT staff AS name,
            COUNT(*)::int AS sales,
            SUM(total)::int AS amount,
            COUNT(*) FILTER (WHERE store = '高雄')::int AS gaoxiong,
            COUNT(*) FILTER (WHERE store = '台中')::int AS taizhong
     FROM sales ${sql}
     GROUP BY staff ORDER BY amount DESC`, params);
  res.json({ status: 'success', data: rows });
});

// 5. 盤點紀錄（目前庫存狀態）
app.get('/api/stocktake', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, category, CASE WHEN series = name THEN name ELSE series || '-' || name END AS name, gaoxiong, taizhong,
            gaoxiong + taizhong AS total, price
     FROM products ORDER BY sort_order NULLS LAST, id`);
  res.json({ status: 'success', data: rows });
});

// 盤點列表（含差異統計）：from / to（盤點日期）、store、limit
async function listStocktakes({ from, to, store, limit = 1000 }) {
  const where = [], params = [];
  if (cleanDate(from)) { params.push(from); where.push(`t.count_date >= $${params.length}::date`); }
  if (cleanDate(to)) { params.push(to); where.push(`t.count_date <= $${params.length}::date`); }
  if (STORES.includes(store)) { params.push(store); where.push(`t.store = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT t.*,
            COUNT(i.id)::int AS items,
            COUNT(i.id) FILTER (WHERE i.counted_qty <> i.system_qty)::int AS diff_items,
            COALESCE(SUM(i.counted_qty - i.system_qty), 0)::int AS diff_qty,
            COALESCE(SUM((i.counted_qty - i.system_qty) * i.price), 0)::int AS diff_amount
     FROM stocktakes t LEFT JOIN stocktake_items i ON i.stocktake_id = t.id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY t.id ORDER BY t.count_date DESC, t.id DESC LIMIT ${Number(limit) || 1000}`, params);
  return rows;
}

async function getStocktake(id) {
  const { rows: [t] } = await pool.query('SELECT * FROM stocktakes WHERE id = $1', [id]);
  if (!t) return null;
  const { rows: items } = await pool.query('SELECT * FROM stocktake_items WHERE stocktake_id = $1 ORDER BY id', [id]);
  return { ...t, items };
}

// 新增盤點：b.items = [{ product_id, counted }]；b.apply = true 時把庫存改成實際數量
async function createStocktake(b, store, date, deviceName) {
  if (!STORES.includes(store)) throw new InputError('請選擇門市');
  if (!date) throw new InputError('請選擇盤點日期');
  const list = (Array.isArray(b.items) ? b.items : [])
    .map(i => ({ id: Number(i.product_id), counted: toInt(i.counted, '實際數量') }))
    .filter(i => Number.isInteger(i.id) && i.counted !== null);
  if (!list.length) throw new InputError('請至少填一個商品的實際數量');

  const col = store === '高雄' ? 'gaoxiong' : 'taizhong';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [t] } = await client.query(
      `INSERT INTO stocktakes (store, count_date, staff, note, applied, device_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [store, date, cleanText(b.staff, 30), cleanText(b.note, 500), !!b.apply, deviceName || null]);
    for (const i of list) {
      // 鎖住商品列，系統數量以存檔當下為準
      const { rows: [p] } = await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [i.id]);
      if (!p) continue;
      await client.query(
        `INSERT INTO stocktake_items (stocktake_id, product_id, category, product_name, price, system_qty, counted_qty)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [t.id, p.id, p.category, productLabel(p), p.price, p[col], i.counted]);
      if (b.apply) await client.query(`UPDATE products SET ${col} = $2 WHERE id = $1`, [p.id, i.counted]);
    }
    await client.query('COMMIT');
    return { t, message: b.apply ? '盤點已儲存，庫存已更新為實際數量' : '盤點已儲存（庫存沒有變動）' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 後台：盤點紀錄列表 ?from=&to=&store=
app.get('/api/admin/stocktakes', requireAdmin, async (req, res) => {
  res.json({ status: 'success', data: await listStocktakes(req.query) });
});

// 後台：一次盤點的明細
app.get('/api/admin/stocktakes/:id', requireAdmin, async (req, res) => {
  const t = await getStocktake(toInt(req.params.id, '盤點'));
  if (!t) return res.status(404).json({ status: 'error', message: '找不到這筆盤點' });
  res.json({ status: 'success', data: t });
});

// 後台：新增盤點
app.post('/api/admin/stocktakes', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const { t, message } = await createStocktake(b, b.store, cleanDate(b.date), null);
  res.json({ status: 'success', message, data: t });
});

// ---- 前台（門市平板）盤點：門市固定是裝置登記的門市 ----
const deviceStore = (req) => (req.device ? req.device.store : req.query.store || req.body?.store);

// 前台：這家門市的商品和目前庫存
app.get('/api/pos/stocktake/products', requireDevice, async (req, res) => {
  const store = deviceStore(req);
  if (!STORES.includes(store)) return res.status(400).json({ status: 'error', message: '門市錯誤' });
  const col = store === '高雄' ? 'gaoxiong' : 'taizhong';
  const { rows } = await pool.query(
    `SELECT id, category, series, name, price, ${col} AS qty FROM products ORDER BY sort_order NULLS LAST, id`);
  res.json({ status: 'success', data: rows.map(p => ({ id: p.id, category: p.category, name: productLabel(p), price: p.price, qty: p.qty })) });
});

// 前台：這家門市最近的盤點
app.get('/api/pos/stocktakes', requireDevice, async (req, res) => {
  res.json({ status: 'success', data: await listStocktakes({ store: deviceStore(req), limit: 30 }) });
});

app.get('/api/pos/stocktakes/:id', requireDevice, async (req, res) => {
  const t = await getStocktake(toInt(req.params.id, '盤點'));
  if (!t || t.store !== deviceStore(req)) return res.status(404).json({ status: 'error', message: '找不到這筆盤點' });
  res.json({ status: 'success', data: t });
});

// 前台：新增盤點（日期 = 今天，台灣時間）
app.post('/api/pos/stocktakes', requireDevice, async (req, res) => {
  const { rows: [{ today }] } = await pool.query(`SELECT to_char((NOW() AT TIME ZONE 'Asia/Taipei')::date, 'YYYY-MM-DD') AS today`);
  const { t, message } = await createStocktake(req.body || {}, deviceStore(req), today, req.device?.name);
  res.json({ status: 'success', message, data: t });
});

// ============ 門市調貨：叫貨 → 出貨 → 進貨 ============
const TRANSFER_STATUS = { requested: '已叫貨', shipped: '已出貨', received: '已進貨', cancelled: '已取消' };
const stockCol = (store) => (store === '高雄' ? 'gaoxiong' : 'taizhong');

// 列表：store（叫貨或出貨方是這家）、status、from / to（叫貨日期）
async function listTransfers({ store, status, from, to, limit = 1000 }) {
  const where = [], params = [];
  if (STORES.includes(store)) { params.push(store); where.push(`(t.from_store = $${params.length} OR t.to_store = $${params.length})`); }
  if (TRANSFER_STATUS[status]) { params.push(status); where.push(`t.status = $${params.length}`); }
  const day = `(t.requested_at AT TIME ZONE 'Asia/Taipei')::date`;
  if (cleanDate(from)) { params.push(from); where.push(`${day} >= $${params.length}::date`); }
  if (cleanDate(to)) { params.push(to); where.push(`${day} <= $${params.length}::date`); }
  const { rows } = await pool.query(
    `SELECT t.*, COUNT(i.id)::int AS items,
            COALESCE(SUM(i.req_qty), 0)::int AS req_total,
            COALESCE(SUM(i.ship_qty), 0)::int AS ship_total,
            COALESCE(SUM(i.recv_qty), 0)::int AS recv_total
     FROM transfer_orders t LEFT JOIN transfer_items i ON i.order_id = t.id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY t.id
     ORDER BY CASE t.status WHEN 'requested' THEN 0 WHEN 'shipped' THEN 1 ELSE 2 END, t.id DESC
     LIMIT ${Number(limit) || 1000}`, params);
  return rows;
}

async function getTransfer(id, client = pool) {
  const { rows: [t] } = await client.query('SELECT * FROM transfer_orders WHERE id = $1', [id]);
  if (!t) return null;
  const { rows: items } = await client.query('SELECT * FROM transfer_items WHERE order_id = $1 ORDER BY id', [id]);
  return { ...t, items };
}

// 叫貨：toStore 叫貨，由另一家門市出貨（還不動庫存）
async function createTransfer(b, toStore) {
  if (!STORES.includes(toStore)) throw new InputError('請選擇叫貨的門市');
  const fromStore = STORES.find(s => s !== toStore);
  const list = (Array.isArray(b.items) ? b.items : [])
    .map(i => ({ id: Number(i.product_id), qty: toInt(i.qty, '數量') }))
    .filter(i => Number.isInteger(i.id) && i.qty);
  if (!list.length) throw new InputError('請至少填一個商品要叫幾個');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [t] } = await client.query(
      `INSERT INTO transfer_orders (from_store, to_store, requested_by, request_note) VALUES ($1, $2, $3, $4) RETURNING *`,
      [fromStore, toStore, cleanText(b.staff, 30), cleanText(b.note, 500)]);
    for (const i of list) {
      const { rows: [p] } = await client.query('SELECT * FROM products WHERE id = $1', [i.id]);
      if (!p) continue;
      await client.query(
        `INSERT INTO transfer_items (order_id, product_id, category, product_name, price, req_qty) VALUES ($1, $2, $3, $4, $5, $6)`,
        [t.id, p.id, p.category, productLabel(p), p.price, i.qty]);
    }
    await client.query('COMMIT');
    return t;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 出貨或收貨：step = 'ship'（出貨方庫存 −）或 'receive'（叫貨方庫存 +）
// b.items = [{ id: 調貨明細 id, qty }]，沒給的照叫貨（出貨）數量；store = 操作的門市（後台為 null，不檢查）
async function advanceTransfer(id, step, b, store) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM transfer_orders WHERE id = $1 FOR UPDATE', [id]);
    const t = await getTransfer(id, client);
    if (!t) throw new InputError('找不到這張調貨單');
    const ship = step === 'ship';
    if (t.status !== (ship ? 'requested' : 'shipped')) throw new InputError(`這張調貨單目前是「${TRANSFER_STATUS[t.status]}」，不能${ship ? '出貨' : '進貨'}`);
    const myStore = ship ? t.from_store : t.to_store;
    if (store && store !== myStore) throw new InputError(`要由${storeName(myStore)}${ship ? '出貨' : '進貨'}`);
    const given = new Map((Array.isArray(b.items) ? b.items : []).map(i => [Number(i.id), toInt(i.qty, '數量')]));
    const col = stockCol(myStore);
    for (const i of t.items) {
      const fallback = ship ? i.req_qty : i.ship_qty;
      const qty = given.has(i.id) && given.get(i.id) !== null ? given.get(i.id) : fallback;
      await client.query(`UPDATE transfer_items SET ${ship ? 'ship_qty' : 'recv_qty'} = $2 WHERE id = $1`, [i.id, qty]);
      if (i.product_id && qty) await client.query(`UPDATE products SET ${col} = ${col} ${ship ? '-' : '+'} $2 WHERE id = $1`, [i.product_id, qty]);
    }
    await client.query(
      ship
        ? `UPDATE transfer_orders SET status = 'shipped', shipped_by = $2, shipped_at = NOW(), ship_note = $3 WHERE id = $1`
        : `UPDATE transfer_orders SET status = 'received', received_by = $2, received_at = NOW(), receive_note = $3 WHERE id = $1`,
      [id, cleanText(b.staff, 30), cleanText(b.note, 500)]);
    await client.query('COMMIT');
    return ship ? `已出貨，${myStore}庫存已扣除` : `已進貨，${myStore}庫存已增加`;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 取消：已叫貨直接取消；已出貨（後台才可以）把出貨方扣掉的庫存加回去
async function cancelTransfer(id, store) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM transfer_orders WHERE id = $1 FOR UPDATE', [id]);
    const t = await getTransfer(id, client);
    if (!t) throw new InputError('找不到這張調貨單');
    if (t.status === 'received' || t.status === 'cancelled') throw new InputError(`這張調貨單已經${TRANSFER_STATUS[t.status]}，不能取消`);
    if (store && t.status !== 'requested') throw new InputError('已經出貨了，要取消請到後台處理');
    if (store && store !== t.to_store && store !== t.from_store) throw new InputError('找不到這張調貨單');
    if (t.status === 'shipped') {
      const col = stockCol(t.from_store);
      for (const i of t.items) if (i.product_id && i.ship_qty) await client.query(`UPDATE products SET ${col} = ${col} + $2 WHERE id = $1`, [i.product_id, i.ship_qty]);
    }
    await client.query(`UPDATE transfer_orders SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [id]);
    await client.query('COMMIT');
    return t.status === 'shipped' ? `已取消，${t.from_store}出貨的數量已加回庫存` : '已取消叫貨';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 後台
app.get('/api/admin/transfers', requireAdmin, async (req, res) => {
  res.json({ status: 'success', data: await listTransfers(req.query) });
});
app.get('/api/admin/transfers/:id', requireAdmin, async (req, res) => {
  const t = await getTransfer(toInt(req.params.id, '調貨單'));
  if (!t) return res.status(404).json({ status: 'error', message: '找不到這張調貨單' });
  res.json({ status: 'success', data: t });
});
app.post('/api/admin/transfers', requireAdmin, async (req, res) => {
  const t = await createTransfer(req.body || {}, req.body?.to_store);
  res.json({ status: 'success', message: `已叫貨，等${t.from_store}出貨`, data: t });
});
app.post('/api/admin/transfers/:id/ship', requireAdmin, async (req, res) => {
  res.json({ status: 'success', message: await advanceTransfer(toInt(req.params.id, '調貨單'), 'ship', req.body || {}, null) });
});
app.post('/api/admin/transfers/:id/receive', requireAdmin, async (req, res) => {
  res.json({ status: 'success', message: await advanceTransfer(toInt(req.params.id, '調貨單'), 'receive', req.body || {}, null) });
});
app.post('/api/admin/transfers/:id/cancel', requireAdmin, async (req, res) => {
  res.json({ status: 'success', message: await cancelTransfer(toInt(req.params.id, '調貨單'), null) });
});

// 前台（門市平板）：只看得到跟自己門市有關的調貨單
app.get('/api/pos/transfers', requireDevice, async (req, res) => {
  res.json({ status: 'success', data: await listTransfers({ store: deviceStore(req), limit: 30 }) });
});
app.get('/api/pos/transfers/:id', requireDevice, async (req, res) => {
  const t = await getTransfer(toInt(req.params.id, '調貨單'));
  const store = deviceStore(req);
  if (!t || (t.from_store !== store && t.to_store !== store)) return res.status(404).json({ status: 'error', message: '找不到這張調貨單' });
  res.json({ status: 'success', data: t });
});
app.post('/api/pos/transfers', requireDevice, async (req, res) => {
  const t = await createTransfer(req.body || {}, deviceStore(req));
  res.json({ status: 'success', message: `已叫貨，等${t.from_store}出貨`, data: t });
});
app.post('/api/pos/transfers/:id/ship', requireDevice, async (req, res) => {
  res.json({ status: 'success', message: await advanceTransfer(toInt(req.params.id, '調貨單'), 'ship', req.body || {}, deviceStore(req)) });
});
app.post('/api/pos/transfers/:id/receive', requireDevice, async (req, res) => {
  res.json({ status: 'success', message: await advanceTransfer(toInt(req.params.id, '調貨單'), 'receive', req.body || {}, deviceStore(req)) });
});
app.post('/api/pos/transfers/:id/cancel', requireDevice, async (req, res) => {
  res.json({ status: 'success', message: await cancelTransfer(toInt(req.params.id, '調貨單'), deviceStore(req)) });
});

// 修改盤點紀錄（日期、盤點人、備註、實際數量）。只改紀錄，不動目前庫存
app.post('/api/admin/stocktakes/update', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const id = toInt(b.id, '盤點');
  const date = cleanDate(b.date);
  const { rows: [t] } = await pool.query(
    `UPDATE stocktakes SET count_date = COALESCE($2, count_date), staff = $3, note = $4 WHERE id = $1 RETURNING *`,
    [id, date, cleanText(b.staff, 30), cleanText(b.note, 500)]);
  if (!t) return res.status(404).json({ status: 'error', message: '找不到這筆盤點' });
  for (const i of Array.isArray(b.items) ? b.items : []) {
    const counted = toInt(i.counted, '實際數量');
    if (counted === null) continue;
    await pool.query('UPDATE stocktake_items SET counted_qty = $3 WHERE id = $1 AND stocktake_id = $2', [Number(i.id), id, counted]);
  }
  res.json({ status: 'success', message: '盤點紀錄已更新' });
});

app.post('/api/admin/stocktakes/delete', requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM stocktakes WHERE id = $1', [toInt(req.body?.id, '盤點')]);
  if (!rowCount) return res.status(404).json({ status: 'error', message: '找不到這筆盤點' });
  res.json({ status: 'success', message: '已刪除盤點紀錄（目前庫存不受影響）' });
});

// 6. 編輯庫存
app.post('/api/inventory/update', requireAdmin, async (req, res) => {
  const { product_id, gaoxiong, taizhong } = req.body || {};
  const { rows: [product] } = await pool.query(
    `UPDATE products
     SET gaoxiong = COALESCE($2, gaoxiong), taizhong = COALESCE($3, taizhong)
     WHERE id = $1 RETURNING *`,
    [product_id, Number.isInteger(gaoxiong) ? gaoxiong : null, Number.isInteger(taizhong) ? taizhong : null]);
  if (!product) return res.status(404).json({ status: 'error', message: '商品不存在' });
  res.json({ status: 'success', message: '庫存已更新', data: product });
});

// 8. 新增商品
app.post('/api/products/create', requireAdmin, async (req, res) => {
  const { category, series, name, price, gaoxiong, taizhong } = req.body || {};
  // 只有品名必填；沒填的欄位給預設值，之後可在後台修改
  const n = String(name || '').trim() || String(series || '').trim();
  if (!n) return res.status(400).json({ status: 'error', message: '請至少填口味/重量' });
  const s = String(series || '').trim() || n;
  const c = String(category || '').trim() || '未分類';
  // 價格沒填當作 0（例如試吃品，只扣庫存不收錢）
  const p = toInt(price, '價格') ?? 0;

  // 同一個大分類裡不能重複；不同大分類可以用一樣的名字（例：經典一口吃、頂規一口吃都有「鹽味」）
  const { rows: [dup] } = await pool.query(
    'SELECT id FROM products WHERE category = $1 AND series = $2 AND name = $3', [c, s, n]);
  if (dup) return res.status(400).json({ status: 'error', message: `「${c}」裡已經有「${s === n ? s : `${s}-${n}`}」了` });

  const { rows: [product] } = await pool.query(
    `INSERT INTO products (id, category, series, name, price, gaoxiong, taizhong, sort_order)
     VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM products), $1, $2, $3, $4, $5, $6,
             (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM products))
     RETURNING *`,
    [c, s, n, p, toInt(gaoxiong, '高雄庫存') ?? 0, toInt(taizhong, '台中庫存') ?? 0]);
  res.json({ status: 'success', message: '商品已新增', data: product });
});

// 9. 修改商品（大分類、系列、品名、價格、上架/下架）
app.post('/api/products/update', requireAdmin, async (req, res) => {
  const { product_id, category, series, name, price, active } = req.body || {};
  const text = (v) => (v === undefined ? null : String(v).trim() || null);
  // 口味/重量刻意清空（送空字串）→ 沒有口味/重量，品名跟系列一樣（例：血腥瑪麗-試吃 → 血腥瑪麗）
  const clearName = name !== undefined && String(name).trim() === '';
  const { rows: [product] } = await pool.query(
    `UPDATE products
     SET series = COALESCE($2, series),
         name = CASE WHEN $7 THEN COALESCE($2, series) ELSE COALESCE($3, name) END,
         price = COALESCE($4, price), active = COALESCE($5, active),
         category = COALESCE($6, category)
     WHERE id = $1 RETURNING *`,
    [product_id, text(series), text(name), toInt(price, '價格'),
     typeof active === 'boolean' ? active : null, text(category), clearName]);
  if (!product) return res.status(404).json({ status: 'error', message: '商品不存在' });
  res.json({ status: 'success', message: '商品已更新', data: product });
});

// 11. 調整商品順序：ids 依新的順序排列（後台拖拉或 ▲▼）
app.post('/api/admin/products/reorder', requireAdmin, async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  if (!ids.length) return res.status(400).json({ status: 'error', message: '沒有要排序的商品' });
  await pool.query(
    `UPDATE products SET sort_order = o.ord
     FROM unnest($1::int[]) WITH ORDINALITY AS o(id, ord)
     WHERE products.id = o.id`, [ids]);
  res.json({ status: 'success', message: '已更新順序' });
});

// 10. 刪除商品（銷售紀錄已存當時的品名與價格，不受影響）
app.post('/api/products/delete', requireAdmin, async (req, res) => {
  const { product_id } = req.body || {};
  const { rows: [product] } = await pool.query(
    'DELETE FROM products WHERE id = $1 RETURNING *', [product_id]);
  if (!product) return res.status(404).json({ status: 'error', message: '商品不存在' });
  res.json({ status: 'success', message: '商品已刪除', data: product });
});

// 7. 健康檢查
app.get('/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', version: 'postgres', timestamp: new Date().toISOString() });
});

// 錯誤處理
app.use((err, req, res, next) => {
  if (err instanceof InputError) return res.status(400).json({ status: 'error', message: err.message });
  console.error(err);
  res.status(500).json({ status: 'error', message: '伺服器錯誤' });
});

// ============ 啟動 ============
initDb()
  .then(() => app.listen(PORT, () => console.log(`野烏金 POS API 運行中，連接埠 ${PORT}`)))
  .catch((err) => {
    console.error('資料庫初始化失敗', err);
    process.exit(1);
  });
