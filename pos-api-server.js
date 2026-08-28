// 野烏金 POS 系統 - Node.js + Express 後端
// 部署到 Railway
// 日期：2026/8/14

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ============ Google Sheets API 設定 ============
const sheets = google.sheets('v4');
const SHEET_ID = process.env.GOOGLE_SHEET_ID; // 妳的 Sheet ID
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// ============ 庫存管理 ============
// 取得即時庫存
app.get('/api/inventory', async (req, res) => {
  try {
    const authClient = await auth.getClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '庫存表!A:H', // 庫存主表
      auth: authClient
    });

    const rows = response.data.values || [];
    const inventory = rows.map((row, idx) => ({
      id: row[0],
      name: row[1],
      barcode: row[5],
      price: row[7],
      high_stock: row[2],
      gaoxiong: row[3],
      taizhong: row[4],
      total: row[6]
    }));

    res.json({ status: 'success', data: inventory });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============ 模式 B：掃條碼銷售 ============
app.post('/api/sales/create', async (req, res) => {
  const { barcode, quantity, store, staff, customer_name, customer_phone } = req.body;

  try {
    const authClient = await auth.getClient();

    // 1. 查詢條碼對應的商品
    const inventoryResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '庫存表!A:H',
      auth: authClient
    });

    const rows = inventoryResponse.data.values || [];
    const product = rows.find(row => row[5] === barcode); // 比對條碼

    if (!product) {
      return res.status(404).json({ status: 'error', message: '商品不存在' });
    }

    // 2. 查詢當前庫存
    const storeColumn = store === '高雄' ? 3 : 4; // 高雄/台中對應欄位
    const currentStock = parseInt(product[storeColumn]) || 0;

    if (currentStock < quantity) {
      return res.status(400).json({ status: 'error', message: '庫存不足' });
    }

    // 3. 扣除庫存
    const newStock = currentStock - quantity;
    const rowIndex = rows.indexOf(product) + 1; // Google Sheets 從 1 開始計數

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `庫存表!${String.fromCharCode(66 + storeColumn)}${rowIndex}`, // 動態欄位
      valueInputOption: 'RAW',
      resource: { values: [[newStock]] },
      auth: authClient
    });

    // 4. 記錄銷售
    const timestamp = new Date().toISOString();
    const salesRecord = [
      timestamp,
      store,
      product[1], // 商品名
      quantity,
      product[7], // 單價
      product[7] * quantity, // 小計
      staff,
      customer_name || '客人',
      customer_phone || ''
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: '銷售記錄!A:I',
      valueInputOption: 'RAW',
      resource: { values: [salesRecord] },
      auth: authClient
    });

    res.json({
      status: 'success',
      message: '銷售記錄完成',
      data: {
        product_name: product[1],
        quantity: quantity,
        total: product[7] * quantity,
        new_stock: newStock,
        store: store,
        staff: staff
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============ 模式 A：ShopLine 匯入 ============
app.post('/api/shopline/import', async (req, res) => {
  const { file, store, staff } = req.body;

  try {
    // 解析 Excel 檔案邏輯（使用 xlsx 庫）
    // const workbook = XLSX.read(file, { type: 'array' });
    // 將銷售記錄逐筆寫入 Google Sheets

    res.json({
      status: 'success',
      message: 'ShopLine 匯入完成',
      data: { imported_count: 0 }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============ 模式 C：金額對應商品 ============
app.post('/api/amount/predict', async (req, res) => {
  const { amount, store } = req.body;

  try {
    const authClient = await auth.getClient();

    // 取得商品對應表
    const mappingResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '商品對應!A:B',
      auth: authClient
    });

    const mappings = mappingResponse.data.values || [];
    const match = mappings.find(row => parseInt(row[0]) === amount);

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
        suggested_products: match[1].split(','),
        confidence: 100
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============ 月度盤點報告 ============
app.get('/api/stocktake/report', async (req, res) => {
  const month = req.query.month; // 格式：2026-08

  try {
    const authClient = await auth.getClient();

    // 取得當月銷售記錄
    const salesResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '銷售記錄!A:I',
      auth: authClient
    });

    const sales = salesResponse.data.values || [];
    const monthSales = sales.filter(row => row[0]?.startsWith(month));

    // 計算盤差
    res.json({
      status: 'success',
      data: {
        month: month,
        expected_inventory: 0, // 計算邏輯
        actual_inventory: 0,
        difference: 0,
        difference_percentage: 0,
        sales_count: monthSales.length
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============ 人員銷售統計 ============
app.get('/api/staff/sales', async (req, res) => {
  const month = req.query.month;

  try {
    const authClient = await auth.getClient();

    const salesResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '銷售記錄!A:I',
      auth: authClient
    });

    const sales = salesResponse.data.values || [];
    const monthSales = sales.filter(row => row[0]?.startsWith(month));

    // 按人員聚合
    const staffStats = {};
    monthSales.forEach(row => {
      const staff = row[6];
      if (!staffStats[staff]) {
        staffStats[staff] = { count: 0, total: 0 };
      }
      staffStats[staff].count += 1;
      staffStats[staff].total += parseInt(row[5]) || 0;
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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ 啟動服務 ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`野烏金 POS API 運行中，連接埠 ${PORT}`);
});
