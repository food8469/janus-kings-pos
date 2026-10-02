// 野烏金 POS 系統 API - PostgreSQL 版
// 資料存在 Railway PostgreSQL，重新部署不會遺失

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
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
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS note TEXT;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS device_name TEXT;
    -- 員工（打卡密碼存雜湊值，不存原始密碼）
    CREATE TABLE IF NOT EXISTS staff (
      name       TEXT PRIMARY KEY,
      pin_hash   TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- 門市打卡裝置（只有登記過的裝置可以打卡）
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
app.get('/api/staff', async (req, res) => {
  const { rows } = await pool.query('SELECT name FROM staff ORDER BY created_at, name');
  res.json({ status: 'success', data: rows.map(r => r.name) });
});

// 前台：檢查這台裝置能不能打卡
app.get('/api/punch-device', async (req, res) => {
  const device = await findDevice(req.query.token);
  if (!device) return res.status(404).json({ status: 'error', message: '這台裝置尚未設定為門市打卡裝置' });
  res.json({ status: 'success', data: { name: device.name, store: device.store } });
});

// 前台：打卡（需要門市裝置 + 員工密碼）
app.post('/api/attendance/punch', async (req, res) => {
  const { staff, type, note, pin, device_token } = req.body || {};
  const name = String(staff || '').trim();
  if (!['in', 'out'].includes(type)) return res.status(400).json({ status: 'error', message: '打卡類型錯誤' });

  const device = await findDevice(device_token);
  if (!device) return res.status(403).json({ status: 'error', message: '這台裝置不能打卡，請店長到後台設定' });

  const { rows: [person] } = await pool.query('SELECT * FROM staff WHERE name = $1', [name]);
  if (!person) return res.status(400).json({ status: 'error', message: '請選擇人員' });
  if (!person.pin_hash) return res.status(400).json({ status: 'error', message: `${name} 還沒有打卡密碼，請店長到後台設定` });

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

// 後台：員工名單與密碼狀態
app.get('/api/admin/staff', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT name, pin_hash IS NOT NULL AS has_pin FROM staff ORDER BY created_at, name');
  res.json({ status: 'success', data: rows });
});

app.post('/api/admin/staff', requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ status: 'error', message: '請填員工名字' });
  const { rowCount } = await pool.query('INSERT INTO staff (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
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

// 後台：門市打卡裝置
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
  const token = crypto.randomBytes(24).toString('hex');
  const { rows: [device] } = await pool.query(
    'INSERT INTO punch_devices (token, name, store) VALUES ($1, $2, $3) RETURNING id, name, store, token',
    [token, name, store]);
  res.json({ status: 'success', message: '已設定為門市打卡裝置', data: device });
});

app.post('/api/admin/devices/revoke', requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query('UPDATE punch_devices SET revoked = TRUE WHERE id = $1', [req.body?.id]);
  if (!rowCount) return res.status(404).json({ status: 'error', message: '找不到這台裝置' });
  res.json({ status: 'success', message: '已停用這台裝置' });
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
