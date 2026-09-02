// 野烏金 POS 系統 - 測試版（硬編碼商品）
// 用於快速測試前端功能，不需要 Google 認證
// 日期：2026/9/2

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============ 硬編碼的商品列表 ============
const PRODUCTS = [
  { id: '1', name: '一口吃烏魚子-鹽味', price: 1280, gaoxiong: 50, taizhong: 30, total: 80 },
  { id: '2', name: '一口吃烏魚子-蜂蜜', price: 1380, gaoxiong: 40, taizhong: 25, total: 65 },
  { id: '3', name: '炭烤烏魚子-經典', price: 1580, gaoxiong: 35, taizhong: 20, total: 55 },
  { id: '4', name: '牛奶糖 6入', price: 210, gaoxiong: 100, taizhong: 80, total: 180 },
  { id: '5', name: '烏魚子禮盒-精選', price: 2980, gaoxiong: 20, taizhong: 15, total: 35 },
  { id: '6', name: '五味人生手拿盒', price: 399, gaoxiong: 60, taizhong: 40, total: 100 },
  { id: '7', name: '烏金經典組合', price: 3500, gaoxiong: 15, taizhong: 10, total: 25 },
  { id: '8', name: '烏魚子小禮包', price: 880, gaoxiong: 45, taizhong: 35, total: 80 },
];

// ============ 硬編碼的商品對應表 ============
const MAPPINGS = [
  { amount: 210, products: '牛奶糖 6入' },
  { amount: 399, products: '五味人生手拿盒' },
  { amount: 880, products: '烏魚子小禮包' },
  { amount: 1280, products: '一口吃烏魚子-鹽味' },
  { amount: 1380, products: '一口吃烏魚子-蜂蜜' },
  { amount: 1580, products: '炭烤烏魚子-經典' },
  { amount: 2980, products: '烏魚子禮盒-精選' },
  { amount: 3500, products: '烏金經典組合' },
];

// 模擬銷售記錄
let SALES_RECORDS = [];

// ============ 庫存管理 ============
app.get('/api/inventory', (req, res) => {
  try {
    const inventory = PRODUCTS.map(p => ({
      id: p.id,
      name: p.name,
      price: p.price,
      gaoxiong: p.gaoxiong,
      taizhong: p.taizhong,
      total: p.total
    }));

    res.json({ status: 'success', data: inventory });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============ 模式 B：商品名稱銷售 ============
app.post('/api/sales/create', (req, res) => {
  const { product_name, quantity, store, staff, customer_name, customer_phone } = req.body;

  try {
    // 1. 查詢商品
    const product = PRODUCTS.find(p => p.name === product_name);

    if (!product) {
      return res.status(404).json({ status: 'error', message: '商品不存在' });
    }

    // 2. 查詢當前庫存
    const storeColumn = store === '高雄' ? 'gaoxiong' : 'taizhong';
    const currentStock = product[storeColumn];

    if (currentStock < quantity) {
      return res.status(400).json({ status: 'error', message: '庫存不足' });
    }

    // 3. 扣除庫存（模擬）
    product[storeColumn] -= quantity;
    product.total -= quantity;

    // 4. 記錄銷售
    const timestamp = new Date().toISOString();
    const saleRecord = {
      timestamp,
      store,
      product_name,
      quantity,
      price: product.price,
      total: product.price * quantity,
      staff,
      customer_name: customer_name || '客人',
      customer_phone: customer_phone || ''
    };

    SALES_RECORDS.push(saleRecord);

    res.json({
      status: 'success',
      message: '銷售記錄完成',
      data: {
        product_name: product.name,
        quantity: quantity,
        total: product.price * quantity,
        new_stock: product[storeColumn],
        store: store,
        staff: staff
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============ 模式 A：ShopLine 匯入 ============
app.post('/api/shopline/import', (req, res) => {
  try {
    res.json({
      status: 'success',
      message: 'ShopLine 匯入完成 (測試版)',
      data: { imported_count: 0 }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============ 模式 C：金額對應商品 ============
app.post('/api/amount/predict', (req, res) => {
  const { amount, store } = req.body;

  try {
    const match = MAPPINGS.find(m => m.amount === amount);

    if (!match) {
      return res.json({
        status: 'warning',
        message: '無精確匹配，請手動確認',
        suggestions: []
      });
    }

    res.json({
      status: 'success',
      data: {
        amount: amount,
        suggested_products: match.products.split(',').map(p => p.trim()),
        confidence: 100
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============ 月度盤點報告 ============
app.get('/api/stocktake/report', (req, res) => {
  const month = req.query.month;

  try {
    const monthSales = SALES_RECORDS.filter(r => r.timestamp.startsWith(month));

    res.json({
      status: 'success',
      data: {
        month: month,
        sales_count: monthSales.length,
        total_amount: monthSales.reduce((sum, r) => sum + r.total, 0)
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============ 人員銷售統計 ============
app.get('/api/staff/sales', (req, res) => {
  const month = req.query.month;

  try {
    const monthSales = SALES_RECORDS.filter(r => r.timestamp.startsWith(month));

    const staffStats = {};
    monthSales.forEach(r => {
      if (!staffStats[r.staff]) {
        staffStats[r.staff] = { count: 0, total: 0 };
      }
      staffStats[r.staff].count += 1;
      staffStats[r.staff].total += r.total;
    });

    const ranking = Object.entries(staffStats)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.total - a.total);

    res.json({ status: 'success', data: ranking });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============ 健康檢查 ============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: 'test', timestamp: new Date().toISOString() });
});

// ============ 啟動服務 ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`野烏金 POS API (測試版) 運行中，連接埠 ${PORT}`);
});
