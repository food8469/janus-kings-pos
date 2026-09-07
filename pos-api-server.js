// 野烏金 POS 系統 API - 完整版
// 2026/9/7

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// ============ CORS 設定 ============
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

app.use(express.json({ limit: '50mb' }));

// ============ 硬編碼商品資料庫 ============
let PRODUCTS = [
  { id: 1, name: '一口吃烏魚子-鹽味', price: 1280, gaoxiong: 50, taizhong: 30 },
  { id: 2, name: '一口吃烏魚子-蜂蜜', price: 1380, gaoxiong: 40, taizhong: 25 },
  { id: 3, name: '炭烤烏魚子-經典', price: 1580, gaoxiong: 35, taizhong: 20 },
  { id: 4, name: '牛奶糖 6入', price: 210, gaoxiong: 100, taizhong: 80 },
  { id: 5, name: '烏魚子禮盒-精選', price: 2980, gaoxiong: 20, taizhong: 15 },
  { id: 6, name: '五味人生手拿盒', price: 399, gaoxiong: 60, taizhong: 40 },
  { id: 7, name: '烏金經典組合', price: 3500, gaoxiong: 15, taizhong: 10 },
  { id: 8, name: '烏魚子小禮包', price: 880, gaoxiong: 45, taizhong: 35 },
];

let SALES_RECORDS = [];

// ============ API 端點 ============

// 1. 獲得庫存
app.get('/api/inventory', (req, res) => {
  res.json({ status: 'success', data: PRODUCTS });
});

// 2. 銷售（結帳）
app.post('/api/sales/create', (req, res) => {
  const { product_id, quantity, store, staff, customer_name } = req.body;

  const product = PRODUCTS.find(p => p.id === product_id);
  if (!product) return res.status(404).json({ status: 'error', message: '商品不存在' });

  const storeKey = store === '高雄' ? 'gaoxiong' : 'taizhong';
  if (product[storeKey] < quantity) {
    return res.status(400).json({ status: 'error', message: '庫存不足' });
  }

  product[storeKey] -= quantity;

  const sale = {
    timestamp: new Date().toISOString(),
    product_name: product.name,
    quantity,
    price: product.price,
    total: product.price * quantity,
    store,
    staff,
    customer_name: customer_name || '客人'
  };

  SALES_RECORDS.push(sale);

  res.json({
    status: 'success',
    message: '銷售成功',
    data: sale
  });
});

// 3. 交易記錄
app.get('/api/sales/records', (req, res) => {
  const { month } = req.query;
  let records = SALES_RECORDS;

  if (month) {
    records = records.filter(r => r.timestamp.startsWith(month));
  }

  res.json({ status: 'success', data: records });
});

// 4. 員工統計
app.get('/api/staff/stats', (req, res) => {
  const stats = {};

  SALES_RECORDS.forEach(r => {
    if (!stats[r.staff]) stats[r.staff] = { sales: 0, amount: 0, gaoxiong: 0, taizhong: 0 };
    stats[r.staff].sales += 1;
    stats[r.staff].amount += r.total;
    if (r.store === '高雄') stats[r.staff].gaoxiong += 1;
    else stats[r.staff].taizhong += 1;
  });

  const data = Object.entries(stats).map(([name, stat]) => ({
    name,
    ...stat
  })).sort((a, b) => b.amount - a.amount);

  res.json({ status: 'success', data });
});

// 5. 盤點紀錄（目前庫存狀態）
app.get('/api/stocktake', (req, res) => {
  const stocktake = PRODUCTS.map(p => ({
    name: p.name,
    gaoxiong: p.gaoxiong,
    taizhong: p.taizhong,
    total: p.gaoxiong + p.taizhong,
    price: p.price
  }));

  res.json({ status: 'success', data: stocktake });
});

// 6. 編輯庫存
app.post('/api/inventory/update', (req, res) => {
  const { product_id, gaoxiong, taizhong } = req.body;

  const product = PRODUCTS.find(p => p.id === product_id);
  if (!product) return res.status(404).json({ status: 'error', message: '商品不存在' });

  if (gaoxiong !== undefined) product.gaoxiong = gaoxiong;
  if (taizhong !== undefined) product.taizhong = taizhong;

  res.json({ status: 'success', message: '庫存已更新', data: product });
});

// 7. 健康檢查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: 'complete', timestamp: new Date().toISOString() });
});

// ============ 啟動 ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`野烏金 POS API 運行中，連接埠 ${PORT}`);
});
