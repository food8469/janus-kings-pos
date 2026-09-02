// 野烏金 POS 系統 - Node.js + Express 後端
// 部署到 Railway
// 日期：2026/9/1
// 改動：支持 JSON 字符串格式的 GOOGLE_CREDENTIALS

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============ Google Sheets API 設定 ============
const sheets = google.sheets('v4');
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// 支持兩種格式：JSON 字符串或檔案路徑
let auth;
try {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
} catch (e) {
  // 如果不是 JSON，嘗試當作檔案路徑
  auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

// ============ 庫存管理 ============
app.get('/api/inventory', async (req, res) => {
  try {
    const authClient = await auth.getClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '庫存表!A:H',
      auth: authClient
    });

    const rows = response.data.values || [];
    const inventory = rows.slice(1).map((row) => ({
      id: row[0],
      name: row[1],
      price: parseInt(row[7]) || 0,
      high_stock: row[2],
      gaoxiong: parseInt(row[3]) || 0,
      taizhong: parseInt(row[4]) || 0,
      total: parseInt(row[6]) || 0
    }));

    res.json({ status: 'success', data: inventory });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============ 模式 B：商品名稱銷售 ============
app.post('/api/sales/create', async (req, res) => {
  const { product_name, quantity, store, staff, customer_name, customer_phone } = req.body;

  try {
    const authClient = await auth.getClient();

    // 1. 查詢商品名稱
    const inventoryResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '庫存表!A:H',
      auth: authClient
    });

    const rows = inventoryResponse.data.values || [];
    const product = rows.slice(1).find(row => row[1] === product_name);

    if (!product) {
      return res.status(404).json({ status: 'error', message: '商品不存在' });
    }

    // 2. 查詢當前庫存
    const storeColumn = store === '高雄' ? 3 : 4;
    const currentStock = parseInt(product[storeColumn]) || 0;

    if (currentStock < quantity) {
      return res.status(400).json({ status: 'error', message: '庫存不足' });
    }

    // 3. 扣除庫存
    const newStock = currentStock - quantity;
    const rowIndex = rows.indexOf(product) + 1;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `庫存表!${String.fromCharCode(65 + storeColumn)}${rowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [[newStock]] },
      auth: authClient
    });

    // 同時更新總庫存 (G 欄)
    const gaoxiongStock = parseInt(product[3]) || 0;
    const taichungStock = parseInt(product[4]) || 0;
    const newTotal = (store === '高雄' ? gaoxiongStock - quantity : gaoxiongStock) +
                     (store === '台中' ? taichungStock - quantity : taichungStock);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `庫存表!G${rowIndex}`,
      valueInputOption: 'RAW',
      resource: { values: [[newTotal]] },
      auth: authClient
    });

    // 4. 記錄銷售
    const timestamp = new Date().toISOString();
    const salesRecord = [
      timestamp,
      store,
      product[1],
      quantity,
      parseInt(product[7]) || 0,
      (parseInt(product[7]) || 0) * quantity,
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
        total: (parseInt(product[7]) || 0) * quantity,
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

    const mappingResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '商品對應!A:B',
      auth: authClient
    });

    const mappings = mappingResponse.data.values || [];
    const match = mappings.slice(1).find(row => parseInt(row[0]) === amount);

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
        suggested_products: match[1].split(',').map(p => p.trim()),
        confidence: 100
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ============ 月度盤點報告 ============
app.get('/api/stocktake/report', async (req, res) => {
  const month = req.query.month;

  try {
    const authClient = await auth.getClient();

    const salesResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '銷售記錄!A:I',
      auth: authClient
    });

    const sales = salesResponse.data.values || [];
    const monthSales = sales.slice(1).filter(row => row[0]?.startsWith(month));

    res.json({
      status: 'success',
      data: {
        month: month,
        expected_inventory: 0,
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
    const monthSales = sales.slice(1).filter(row => row[0]?.startsWith(month));

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
