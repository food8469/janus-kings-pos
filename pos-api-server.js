// 野烏金 POS 系統 API - PostgreSQL 版
// 資料存在 Railway PostgreSQL，重新部署不會遺失

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
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
    -- 同一次結帳的品項共用一個單號
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS order_no TEXT;
    -- 人員打卡
    CREATE TABLE IF NOT EXISTS attendance (
      id         SERIAL PRIMARY KEY,
      staff      TEXT NOT NULL,
      store      TEXT NOT NULL,
      type       TEXT NOT NULL CHECK (type IN ('in', 'out')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS attendance_created_at_idx ON attendance (created_at);
  `);
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
app.use(express.json({ limit: '1mb' }));

// ============ 後台密碼（瀏覽器會跳出帳號密碼視窗） ============
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send('尚未設定 ADMIN_PASSWORD，請到 Railway Variables 設定');
  }
  const [type, encoded] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && encoded) {
    const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user === ADMIN_USER && rest.join(':') === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="POS Admin", charset="UTF-8"');
  res.status(401).json({ status: 'error', message: '需要登入後台' });
}

// ============ 頁面 ============
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'pos-checkout.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'pos-admin.html')));

// ============ API 端點 ============

// 1. 獲得庫存
app.get('/api/inventory', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM products ORDER BY id');
  res.json({ status: 'success', data: rows });
});

// 2. 銷售（結帳）
app.post('/api/sales/create', async (req, res) => {
  const { product_id, quantity, store, staff, customer_name, order_no } = req.body || {};
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
    await client.query(
      `UPDATE products SET ${storeKey} = ${storeKey} - $1 WHERE id = $2`, [qty, product.id]);

    const { rows: [row] } = await client.query(
      `INSERT INTO sales (product_id, product_name, price, quantity, total, store, staff, customer_name, order_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [product.id, `${product.series}-${product.name}`, product.price, qty, product.price * qty,
       store, staff, (customer_name || '').trim() || '客人', String(order_no || '').slice(0, 40) || null]
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
  };
}

// 台灣時間的「今天」條件
const TODAY_SQL = `(created_at AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date`;

// 前台：今日結帳紀錄（只限今天、指定門市）
app.get('/api/pos/sales/today', async (req, res) => {
  if (!STORE_KEYS[req.query.store]) return res.status(400).json({ status: 'error', message: '門市錯誤' });
  const { rows } = await pool.query(
    `SELECT * FROM sales WHERE ${TODAY_SQL} AND store = $1 ORDER BY created_at DESC LIMIT 500`,
    [req.query.store]);
  res.json({ status: 'success', data: rows.map(toRecord) });
});

// 前台：打卡
app.post('/api/attendance/punch', async (req, res) => {
  const { staff, store, type } = req.body || {};
  if (!String(staff || '').trim()) return res.status(400).json({ status: 'error', message: '請選擇人員' });
  if (!STORE_KEYS[store]) return res.status(400).json({ status: 'error', message: '門市錯誤' });
  if (!['in', 'out'].includes(type)) return res.status(400).json({ status: 'error', message: '打卡類型錯誤' });
  const { rows: [row] } = await pool.query(
    'INSERT INTO attendance (staff, store, type) VALUES ($1, $2, $3) RETURNING *',
    [String(staff).trim(), store, type]);
  res.json({ status: 'success', message: type === 'in' ? '上班打卡成功' : '下班打卡成功', data: row });
});

// 前台：今日打卡紀錄（指定門市）
app.get('/api/attendance/today', async (req, res) => {
  if (!STORE_KEYS[req.query.store]) return res.status(400).json({ status: 'error', message: '門市錯誤' });
  const { rows } = await pool.query(
    `SELECT * FROM attendance WHERE ${TODAY_SQL} AND store = $1 ORDER BY created_at DESC`,
    [req.query.store]);
  res.json({ status: 'success', data: rows });
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
  return { sql: '', params: [] };
}

// 3. 交易記錄
app.get('/api/sales/records', requireAdmin, async (req, res) => {
  const { sql, params } = dateFilter(req.query);
  const { rows } = await pool.query(
    `SELECT * FROM sales ${sql} ORDER BY created_at DESC LIMIT 2000`, params);
  res.json({ status: 'success', data: rows.map(toRecord) });
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
    `SELECT id, category, series || '-' || name AS name, gaoxiong, taizhong,
            gaoxiong + taizhong AS total, price
     FROM products ORDER BY id`);
  res.json({ status: 'success', data: rows });
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
  if (!n) return res.status(400).json({ status: 'error', message: '請至少填品名' });
  const s = String(series || '').trim() || n;
  const c = String(category || '').trim() || '未分類';
  // 價格沒填當作 0（例如試吃品，只扣庫存不收錢）
  const p = toInt(price, '價格') ?? 0;

  const { rows: [dup] } = await pool.query(
    'SELECT id FROM products WHERE series = $1 AND name = $2', [s, n]);
  if (dup) return res.status(400).json({ status: 'error', message: `「${s}-${n}」已經存在` });

  const { rows: [product] } = await pool.query(
    `INSERT INTO products (id, category, series, name, price, gaoxiong, taizhong)
     VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM products), $1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [c, s, n, p, toInt(gaoxiong, '高雄庫存') ?? 0, toInt(taizhong, '台中庫存') ?? 0]);
  res.json({ status: 'success', message: '商品已新增', data: product });
});

// 9. 修改商品（大分類、系列、品名、價格、上架/下架）
app.post('/api/products/update', requireAdmin, async (req, res) => {
  const { product_id, category, series, name, price, active } = req.body || {};
  const text = (v) => (v === undefined ? null : String(v).trim() || null);
  const { rows: [product] } = await pool.query(
    `UPDATE products
     SET series = COALESCE($2, series), name = COALESCE($3, name),
         price = COALESCE($4, price), active = COALESCE($5, active),
         category = COALESCE($6, category)
     WHERE id = $1 RETURNING *`,
    [product_id, text(series), text(name), toInt(price, '價格'),
     typeof active === 'boolean' ? active : null, text(category)]);
  if (!product) return res.status(404).json({ status: 'error', message: '商品不存在' });
  res.json({ status: 'success', message: '商品已更新', data: product });
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
