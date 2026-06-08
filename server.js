const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const initSqlJs = require("sql.js/dist/sql-asm.js");
const XLSX = require("xlsx");

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, "ledger.sqlite");
const PORT = Number(process.env.PORT || 3000);
const sessionStore = new Map();
const STORE_NAME = "于福记熟食店";

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function todayText() {
  return new Date().toISOString().slice(0, 10);
}

function monthText() {
  return todayText().slice(0, 7);
}

function parseDateText(value) {
  const parts = String(value || "").split("-").map(Number);
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return null;
  }
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

function formatDateText(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDateText(dateText, offsetDays) {
  const date = parseDateText(dateText);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return formatDateText(date);
}

function parseMonthText(value) {
  const parts = String(value || "").split("-").map(Number);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return new Date(Date.UTC(parts[0], parts[1] - 1, 1));
}

function formatMonthText(date) {
  return date.toISOString().slice(0, 7);
}

function shiftMonthText(monthValue, offsetMonths) {
  const date = parseMonthText(monthValue);
  date.setUTCMonth(date.getUTCMonth() + offsetMonths);
  return formatMonthText(date);
}

function money(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function intValue(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function createDbApi(db, persist) {
  function run(sql, params) {
    db.run(sql, params || []);
    persist();
  }

  function one(sql, params) {
    const stmt = db.prepare(sql, params || []);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  }

  function all(sql, params) {
    const stmt = db.prepare(sql, params || []);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  return { run, one, all, raw: db };
}

function createSchema(api) {
  const schemaSql = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sale_mode TEXT NOT NULL,
      unit TEXT NOT NULL,
      price REAL NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_ledgers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger_date TEXT NOT NULL UNIQUE,
      sales_total REAL NOT NULL DEFAULT 0,
      actual_received REAL NOT NULL DEFAULT 0,
      cash_amount REAL NOT NULL DEFAULT 0,
      wechat_amount REAL NOT NULL DEFAULT 0,
      alipay_amount REAL NOT NULL DEFAULT 0,
      refund_amount REAL NOT NULL DEFAULT 0,
      rounding_amount REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      updated_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sale_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_date TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS expense_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_date TEXT NOT NULL,
      expense_type TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `;

  api.raw.exec(schemaSql);
  persistNow(api);
}

function persistNow(api) {
  ensureDir(DATA_DIR);
  const data = api.raw.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function seedDatabase(api) {
  const existingUser = api.one("SELECT id FROM users LIMIT 1");
  if (existingUser) {
    return;
  }

  const now = new Date().toISOString();
  const ownerHash = bcrypt.hashSync("admin123", 10);
  const staffHash = bcrypt.hashSync("staff123", 10);

  api.run(
    "INSERT INTO users (username, password_hash, name, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
    ["owner", ownerHash, "店主", "owner", now]
  );
  api.run(
    "INSERT INTO users (username, password_hash, name, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
    ["staff", staffHash, "店员", "staff", now]
  );
}

async function loadDatabase() {
  ensureDir(DATA_DIR);
  const SQL = await initSqlJs();
  const existing = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  const db = existing ? new SQL.Database(existing) : new SQL.Database();
  const api = createDbApi(db, function persist() {
    persistNow(api);
  });
  createSchema(api);
  seedDatabase(api);
  return api;
}

function sanitizeUser(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at || null
  };
}

function requireOwner(req, res) {
  if (!req.user || req.user.role !== "owner") {
    res.status(403).json({ error: "Only the owner can access this feature." });
    return false;
  }
  return true;
}

function ownerOnlyLedger(ledger, isOwnerUser) {
  if (isOwnerUser) {
    return ledger;
  }
  return Object.assign({}, ledger, { profit: null });
}

function ensureLedger(api, date, userId) {
  const now = new Date().toISOString();
  const ledger = api.one("SELECT * FROM daily_ledgers WHERE ledger_date = ?", [date]);
  if (ledger) {
    return ledger;
  }

  api.run(
    "INSERT INTO daily_ledgers (ledger_date, sales_total, actual_received, cash_amount, wechat_amount, alipay_amount, refund_amount, rounding_amount, note, created_by, updated_by, created_at, updated_at) VALUES (?, 0, 0, 0, 0, 0, 0, 0, '', ?, ?, ?, ?)",
    [date, userId || null, userId || null, now, now]
  );
  return api.one("SELECT * FROM daily_ledgers WHERE ledger_date = ?", [date]);
}

function getExpensesTotal(api, date) {
  const row = api.one("SELECT COALESCE(SUM(amount), 0) AS total FROM expense_entries WHERE expense_date = ?", [date]);
  return money(row ? row.total : 0);
}

function getTopProducts(api, fromDate, toDate, limit) {
  const rows = api.all(
    "SELECT p.name, p.unit, p.sale_mode, ROUND(SUM(s.quantity), 2) AS total_quantity, ROUND(SUM(s.amount), 2) AS total_amount FROM sale_entries s JOIN products p ON p.id = s.product_id WHERE s.sale_date BETWEEN ? AND ? GROUP BY s.product_id ORDER BY SUM(s.amount) DESC, SUM(s.quantity) DESC LIMIT ?",
    [fromDate, toDate, limit]
  );
  return rows.map(function mapRow(row) {
    return {
      name: row.name,
      unit: row.unit,
      saleMode: row.sale_mode,
      totalQuantity: money(row.total_quantity),
      totalAmount: money(row.total_amount)
    };
  });
}

function getProductSalesSummary(api, fromDate, toDate) {
  const rows = api.all(
    "SELECT p.name, p.unit, p.sale_mode, ROUND(SUM(s.quantity), 2) AS total_quantity, ROUND(SUM(s.amount), 2) AS total_amount FROM sale_entries s JOIN products p ON p.id = s.product_id WHERE s.sale_date BETWEEN ? AND ? GROUP BY s.product_id ORDER BY SUM(s.amount) DESC, SUM(s.quantity) DESC, p.name ASC",
    [fromDate, toDate]
  );
  return rows.map(function mapRow(row) {
    return {
      name: row.name,
      unit: row.unit,
      saleMode: row.sale_mode,
      totalQuantity: money(row.total_quantity),
      totalAmount: money(row.total_amount)
    };
  });
}

function getLedgerBundle(api, date) {
  const ledger = ensureLedger(api, date);
  const sales = api.all(
    "SELECT s.id, s.sale_date, s.product_id, p.name AS product_name, p.sale_mode, p.unit, p.price, s.quantity, s.amount, s.note, s.created_by, s.created_at, s.updated_at FROM sale_entries s JOIN products p ON p.id = s.product_id WHERE s.sale_date = ? ORDER BY s.id DESC",
    [date]
  ).map(function mapSale(row) {
    return {
      id: row.id,
      date: row.sale_date,
      productId: row.product_id,
      productName: row.product_name,
      saleMode: row.sale_mode,
      unit: row.unit,
      price: money(row.price),
      quantity: money(row.quantity),
      amount: money(row.amount),
      note: row.note,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });

  const expenses = api.all(
    "SELECT * FROM expense_entries WHERE expense_date = ? ORDER BY id DESC",
    [date]
  ).map(function mapExpense(row) {
    return {
      id: row.id,
      date: row.expense_date,
      expenseType: row.expense_type,
      amount: money(row.amount),
      note: row.note,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });

  const expenseTotal = expenses.reduce(function sum(total, item) {
    return total + item.amount;
  }, 0);

  return {
    ledger: {
      id: ledger.id,
      date: ledger.ledger_date,
      salesTotal: money(ledger.sales_total),
      actualReceived: money(ledger.actual_received),
      cashAmount: money(ledger.cash_amount),
      wechatAmount: money(ledger.wechat_amount),
      alipayAmount: money(ledger.alipay_amount),
      refundAmount: money(ledger.refund_amount),
      roundingAmount: money(ledger.rounding_amount),
      note: ledger.note,
      expenseTotal: money(expenseTotal),
      profit: money(money(ledger.sales_total) - expenseTotal)
    },
    sales: sales,
    expenses: expenses,
    productSummary: getProductSalesSummary(api, date, date),
    topProducts: getTopProducts(api, date, date, 10)
  };
}

function getDailySummary(api, date) {
  return getLedgerBundle(api, date).ledger;
}

function getMonthlySummary(api, month) {
  const fromDate = month + "-01";
  const toDate = month + "-31";
  const ledgerRows = api.all(
    "SELECT ledger_date, sales_total, actual_received FROM daily_ledgers WHERE ledger_date BETWEEN ? AND ? ORDER BY ledger_date ASC",
    [fromDate, toDate]
  );
  const expenseRows = api.all(
    "SELECT expense_date, ROUND(SUM(amount), 2) AS total FROM expense_entries WHERE expense_date BETWEEN ? AND ? GROUP BY expense_date",
    [fromDate, toDate]
  );
  const expenseMap = {};
  expenseRows.forEach(function buildMap(row) {
    expenseMap[row.expense_date] = money(row.total);
  });

  const days = ledgerRows.map(function mapDay(row) {
    const expenseTotal = money(expenseMap[row.ledger_date] || 0);
    const salesTotal = money(row.sales_total);
    return {
      date: row.ledger_date,
      salesTotal: salesTotal,
      actualReceived: money(row.actual_received),
      expenseTotal: expenseTotal,
      profit: money(salesTotal - expenseTotal)
    };
  });

  const totals = days.reduce(
    function reduceTotal(acc, day) {
      acc.salesTotal += day.salesTotal;
      acc.actualReceived += day.actualReceived;
      acc.expenseTotal += day.expenseTotal;
      acc.profit += day.profit;
      return acc;
    },
    { salesTotal: 0, actualReceived: 0, expenseTotal: 0, profit: 0 }
  );

  return {
    month: month,
    totals: {
      salesTotal: money(totals.salesTotal),
      actualReceived: money(totals.actualReceived),
      expenseTotal: money(totals.expenseTotal),
      profit: money(totals.profit)
    },
    days: days,
    productSummary: getProductSalesSummary(api, fromDate, toDate),
    topProducts: getTopProducts(api, fromDate, toDate, 10)
  };
}

function getMonthlySaleEntries(api, month) {
  const fromDate = month + "-01";
  const toDate = month + "-31";
  const rows = api.all(
    "SELECT s.id, s.sale_date, p.name AS product_name, p.sale_mode, p.unit, p.price, s.quantity, s.amount, s.note, s.created_by, s.created_at, s.updated_at FROM sale_entries s JOIN products p ON p.id = s.product_id WHERE s.sale_date BETWEEN ? AND ? ORDER BY s.sale_date ASC, s.id ASC",
    [fromDate, toDate]
  );
  return rows.map(function mapRow(row) {
    return {
      id: row.id,
      date: row.sale_date,
      productName: row.product_name,
      saleMode: row.sale_mode,
      unit: row.unit,
      price: money(row.price),
      quantity: money(row.quantity),
      amount: money(row.amount),
      note: row.note,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

function getMonthlyExpenseEntries(api, month) {
  const fromDate = month + "-01";
  const toDate = month + "-31";
  const rows = api.all(
    "SELECT * FROM expense_entries WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date ASC, id ASC",
    [fromDate, toDate]
  );
  return rows.map(function mapRow(row) {
    return {
      id: row.id,
      date: row.expense_date,
      expenseType: row.expense_type,
      amount: money(row.amount),
      note: row.note,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

function getAnalyticsSummary(currentTotal, previousTotal) {
  const delta = money(currentTotal - previousTotal);
  const percent = previousTotal === 0 ? null : money((delta / previousTotal) * 100);
  return {
    currentTotal: money(currentTotal),
    previousTotal: money(previousTotal),
    delta: delta,
    deltaPercent: percent
  };
}

function getAnalyticsOverview(api, options) {
  const metric = options.metric === "actualReceived" ? "actual_received" : "sales_total";
  const metricKey = metric === "actual_received" ? "actualReceived" : "salesTotal";
  const dailyRange = [7, 30, 90].includes(options.dailyRange) ? options.dailyRange : 30;
  const endDate = options.endDate || todayText();
  const monthEnd = options.monthEnd || monthText();
  const dailyStart = shiftDateText(endDate, -(dailyRange - 1));
  const previousDailyStart = shiftDateText(dailyStart, -dailyRange);
  const previousDailyEnd = shiftDateText(dailyStart, -1);

  const dailyRows = api.all(
    "SELECT ledger_date, ROUND(" + metric + ", 2) AS total FROM daily_ledgers WHERE ledger_date BETWEEN ? AND ? ORDER BY ledger_date ASC",
    [previousDailyStart, endDate]
  );
  const dailyMap = {};
  dailyRows.forEach(function fillMap(row) {
    dailyMap[row.ledger_date] = money(row.total);
  });

  const dailySeries = [];
  let dailyCurrentTotal = 0;
  let cursor = dailyStart;
  for (let index = 0; index < dailyRange; index += 1) {
    const value = money(dailyMap[cursor] || 0);
    dailyCurrentTotal += value;
    dailySeries.push({ label: cursor.slice(5), date: cursor, value: value });
    cursor = shiftDateText(cursor, 1);
  }

  let previousCursor = previousDailyStart;
  let previousDailyTotal = 0;
  for (let index = 0; index < dailyRange; index += 1) {
    previousDailyTotal += money(dailyMap[previousCursor] || 0);
    previousCursor = shiftDateText(previousCursor, 1);
  }

  const monthSeries = [];
  const monthStart = shiftMonthText(monthEnd, -11);
  const monthRows = api.all(
    "SELECT substr(ledger_date, 1, 7) AS month_key, ROUND(SUM(" + metric + "), 2) AS total FROM daily_ledgers WHERE ledger_date BETWEEN ? AND ? GROUP BY substr(ledger_date, 1, 7) ORDER BY month_key ASC",
    [monthStart + "-01", monthEnd + "-31"]
  );
  const monthMap = {};
  monthRows.forEach(function fillMonthMap(row) {
    monthMap[row.month_key] = money(row.total);
  });

  let monthCursor = monthStart;
  for (let index = 0; index < 12; index += 1) {
    monthSeries.push({
      label: monthCursor.slice(5),
      month: monthCursor,
      value: money(monthMap[monthCursor] || 0)
    });
    monthCursor = shiftMonthText(monthCursor, 1);
  }

  const currentMonthTotal = money(monthMap[monthEnd] || 0);
  const previousMonthTotal = money(monthMap[shiftMonthText(monthEnd, -1)] || 0);

  return {
    metric: metricKey,
    dailyRange: dailyRange,
    endDate: endDate,
    monthEnd: monthEnd,
    daily: {
      series: dailySeries,
      summary: getAnalyticsSummary(dailyCurrentTotal, previousDailyTotal)
    },
    monthly: {
      series: monthSeries,
      summary: getAnalyticsSummary(currentMonthTotal, previousMonthTotal)
    }
  };
}

function createWorkbookForDaily(api, date) {
  const bundle = getLedgerBundle(api, date);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([bundle.ledger]),
    "日报总览"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(bundle.sales),
    "单品销售"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(bundle.expenses),
    "支出明细"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(bundle.topProducts),
    "热销排行"
  );
  return workbook;
}

function createWorkbookForMonthly(api, month) {
  const summary = getMonthlySummary(api, month);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([summary.totals]),
    "月度汇总"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(summary.days),
    "每日明细"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(summary.topProducts),
    "单品排行"
  );
  return workbook;
}

function createApp(api) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/health", function health(req, res) {
    res.json({ ok: true, date: todayText() });
  });

  app.use("/api", function authMiddleware(req, res, next) {
    if (req.path === "/auth/login") {
      return next();
    }
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const userId = sessionStore.get(token);
    if (!userId) {
      return res.status(401).json({ error: "未登录或登录已失效" });
    }
    const user = sanitizeUser(api.one("SELECT * FROM users WHERE id = ?", [userId]));
    if (!user || user.status !== "active") {
      return res.status(401).json({ error: "账号不可用" });
    }
    req.user = user;
    next();
  });

  app.post("/api/auth/login", function login(req, res) {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const user = api.one("SELECT * FROM users WHERE username = ?", [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "账号或密码错误" });
    }
    const token = crypto.randomBytes(24).toString("hex");
    sessionStore.set(token, user.id);
    res.json({ token: token, user: sanitizeUser(user) });
  });

  app.get("/api/auth/me", function me(req, res) {
    res.json({ user: req.user });
  });

  app.get("/api/users", function users(req, res) {
    if (req.user.role !== "owner") {
      return res.status(403).json({ error: "只有店主可查看账号列表" });
    }
    const users = api.all("SELECT id, username, name, role, status, created_at FROM users ORDER BY id ASC");
    res.json({ items: users });
  });

  app.post("/api/users", function saveUser(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const body = req.body || {};
    const now = new Date().toISOString();
    const id = body.id ? intValue(body.id, null) : null;
    const name = String(body.name || "").trim();
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const status = body.status === "inactive" ? "inactive" : "active";

    if (!name || !username) {
      return res.status(400).json({ error: "Name and username are required." });
    }

    const duplicate = api.one(
      "SELECT id FROM users WHERE username = ? AND (? IS NULL OR id != ?)",
      [username, id, id]
    );
    if (duplicate) {
      return res.status(400).json({ error: "That username is already in use." });
    }

    if (id) {
      const existing = api.one("SELECT * FROM users WHERE id = ?", [id]);
      if (!existing || existing.role !== "staff") {
        return res.status(404).json({ error: "Only staff accounts can be edited here." });
      }
      if (password) {
        api.run(
          "UPDATE users SET name = ?, username = ?, password_hash = ?, status = ? WHERE id = ?",
          [name, username, bcrypt.hashSync(password, 10), status, id]
        );
      } else {
        api.run(
          "UPDATE users SET name = ?, username = ?, status = ? WHERE id = ?",
          [name, username, status, id]
        );
      }
      return res.json({ success: true });
    }

    if (!password) {
      return res.status(400).json({ error: "A password is required when creating staff." });
    }

    api.run(
      "INSERT INTO users (username, password_hash, name, role, status, created_at) VALUES (?, ?, ?, 'staff', ?, ?)",
      [username, bcrypt.hashSync(password, 10), name, status, now]
    );
    res.json({ success: true });
  });

  app.post("/api/users/:id/reset-password", function resetUserPassword(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const userId = intValue(req.params.id, 0);
    const password = String((req.body || {}).password || "");
    if (!password) {
      return res.status(400).json({ error: "A new password is required." });
    }
    const existing = api.one("SELECT * FROM users WHERE id = ?", [userId]);
    if (!existing || existing.role !== "staff") {
      return res.status(404).json({ error: "Only staff accounts can be updated here." });
    }
    api.run("UPDATE users SET password_hash = ? WHERE id = ?", [bcrypt.hashSync(password, 10), userId]);
    res.json({ success: true });
  });

  app.delete("/api/users/:id", function deleteUser(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const userId = intValue(req.params.id, 0);
    const existing = api.one("SELECT * FROM users WHERE id = ?", [userId]);
    if (!existing || existing.role !== "staff") {
      return res.status(404).json({ error: "Only staff accounts can be deleted here." });
    }
    api.run("DELETE FROM users WHERE id = ?", [userId]);
    res.json({ success: true });
  });

  app.get("/api/products", function listProducts(req, res) {
    const includeInactive = req.query.includeInactive === "true";
    const rows = api.all(
      "SELECT * FROM products " + (includeInactive ? "" : "WHERE is_active = 1 ") + "ORDER BY sort_order ASC, id ASC"
    );
    res.json({
      items: rows.map(function mapProduct(row) {
        return {
          id: row.id,
          name: row.name,
          saleMode: row.sale_mode,
          unit: row.unit,
          price: money(row.price),
          isActive: Boolean(row.is_active),
          sortOrder: row.sort_order,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      })
    });
  });

  app.post("/api/products", function saveProduct(req, res) {
    if (req.user.role !== "owner") {
      return res.status(403).json({ error: "只有店主可以管理商品" });
    }
    const body = req.body || {};
    const now = new Date().toISOString();
    const id = body.id ? intValue(body.id, null) : null;
    const payload = {
      name: String(body.name || "").trim(),
      saleMode: body.saleMode === "weight" ? "weight" : "piece",
      unit: String(body.unit || "").trim() || "份",
      price: money(body.price),
      isActive: body.isActive === false ? 0 : 1,
      sortOrder: intValue(body.sortOrder, 0)
    };

    if (!payload.name) {
      return res.status(400).json({ error: "商品名称不能为空" });
    }

    if (id) {
      api.run(
        "UPDATE products SET name = ?, sale_mode = ?, unit = ?, price = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?",
        [payload.name, payload.saleMode, payload.unit, payload.price, payload.isActive, payload.sortOrder, now, id]
      );
    } else {
      api.run(
        "INSERT INTO products (name, sale_mode, unit, price, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [payload.name, payload.saleMode, payload.unit, payload.price, payload.isActive, payload.sortOrder, now, now]
      );
    }

    res.json({ success: true });
  });

  app.get("/api/ledger/:date", function getLedger(req, res) {
    const bundle = getLedgerBundle(api, req.params.date);
    if (req.user.role !== "owner") {
      bundle.ledger = ownerOnlyLedger(bundle.ledger, false);
      bundle.topProducts = [];
    }
    res.json(bundle);
  });

  app.put("/api/ledger/:date", function saveLedger(req, res) {
    const date = req.params.date;
    const current = ensureLedger(api, date, req.user.id);
    const now = new Date().toISOString();
    const body = req.body || {};
    api.run(
      "UPDATE daily_ledgers SET sales_total = ?, actual_received = ?, cash_amount = ?, wechat_amount = ?, alipay_amount = ?, refund_amount = ?, rounding_amount = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?",
      [
        money(body.salesTotal),
        money(body.actualReceived),
        money(body.cashAmount),
        money(body.wechatAmount),
        money(body.alipayAmount),
        money(body.refundAmount),
        money(body.roundingAmount),
        String(body.note || ""),
        req.user.id,
        now,
        current.id
      ]
    );
    const nextLedger = getLedgerBundle(api, date).ledger;
    res.json({ success: true, ledger: ownerOnlyLedger(nextLedger, req.user.role === "owner") });
  });

  app.post("/api/sales", function createSale(req, res) {
    const body = req.body || {};
    const productId = intValue(body.productId, 0);
    const product = api.one("SELECT * FROM products WHERE id = ?", [productId]);
    if (!product) {
      return res.status(400).json({ error: "商品不存在" });
    }
    const now = new Date().toISOString();
    const quantity = money(body.quantity);
    const amount = money(body.amount || quantity * Number(product.price));
    api.run(
      "INSERT INTO sale_entries (sale_date, product_id, quantity, amount, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [body.date, productId, quantity, amount, String(body.note || ""), req.user.id, now, now]
    );
    res.json({ success: true });
  });

  app.put("/api/sales/:id", function updateSale(req, res) {
    const body = req.body || {};
    const now = new Date().toISOString();
    api.run(
      "UPDATE sale_entries SET quantity = ?, amount = ?, note = ?, updated_at = ? WHERE id = ?",
      [money(body.quantity), money(body.amount), String(body.note || ""), now, intValue(req.params.id, 0)]
    );
    res.json({ success: true });
  });

  app.delete("/api/sales/:id", function deleteSale(req, res) {
    api.run("DELETE FROM sale_entries WHERE id = ?", [intValue(req.params.id, 0)]);
    res.json({ success: true });
  });

  app.get("/api/expenses/:date", function listExpenses(req, res) {
    const rows = api.all("SELECT * FROM expense_entries WHERE expense_date = ? ORDER BY id DESC", [req.params.date]);
    res.json({ items: rows });
  });

  app.post("/api/expenses", function createExpense(req, res) {
    const body = req.body || {};
    const now = new Date().toISOString();
    api.run(
      "INSERT INTO expense_entries (expense_date, expense_type, amount, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [body.date, body.expenseType === "purchase" ? "purchase" : "daily", money(body.amount), String(body.note || ""), req.user.id, now, now]
    );
    res.json({ success: true });
  });

  app.put("/api/expenses/:id", function updateExpense(req, res) {
    const body = req.body || {};
    const now = new Date().toISOString();
    api.run(
      "UPDATE expense_entries SET expense_type = ?, amount = ?, note = ?, updated_at = ? WHERE id = ?",
      [body.expenseType === "purchase" ? "purchase" : "daily", money(body.amount), String(body.note || ""), now, intValue(req.params.id, 0)]
    );
    res.json({ success: true });
  });

  app.delete("/api/expenses/:id", function deleteExpense(req, res) {
    api.run("DELETE FROM expense_entries WHERE id = ?", [intValue(req.params.id, 0)]);
    res.json({ success: true });
  });

  app.get("/api/reports/daily", function reportDaily(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const date = String(req.query.date || todayText());
    res.json({
      date: date,
      summary: getDailySummary(api, date),
      topProducts: getTopProducts(api, date, date, 10)
    });
  });

  app.get("/api/reports/monthly", function reportMonthly(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const month = String(req.query.month || monthText());
    res.json(getMonthlySummary(api, month));
  });

  app.get("/api/analytics", function analytics(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    res.json(
      getAnalyticsOverview(api, {
        metric: String(req.query.metric || "salesTotal"),
        dailyRange: intValue(req.query.dailyRange, 30),
        endDate: String(req.query.endDate || todayText()),
        monthEnd: String(req.query.monthEnd || monthText())
      })
    );
  });

  app.get("/api/export/daily", function exportDaily(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const date = String(req.query.date || todayText());
    const workbook = createWorkbookForDaily(api, date);
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent("日报-" + date + ".xlsx") + '"');
    res.send(Buffer.from(buffer));
  });

  app.get("/api/export/monthly", function exportMonthly(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const month = String(req.query.month || monthText());
    const workbook = createWorkbookForMonthly(api, month);
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent("月报-" + month + ".xlsx") + '"');
    res.send(Buffer.from(buffer));
  });

  app.get("*", function fallback(req, res) {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  return app;
}

function renameKeysForExport(row, mapping) {
  const next = {};
  Object.keys(mapping).forEach(function mapKey(key) {
    next[mapping[key]] = row[key];
  });
  return next;
}

function makeExportSheet(rows, mapping) {
  return XLSX.utils.json_to_sheet(
    rows.map(function mapRow(row) {
      return renameKeysForExport(row, mapping);
    })
  );
}

function createWorkbookForDaily(api, date) {
  const bundle = getLedgerBundle(api, date);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet([bundle.ledger], {
      id: "编号",
      date: "日期",
      salesTotal: "销售总额",
      actualReceived: "实际收款额",
      cashAmount: "现金",
      wechatAmount: "微信",
      alipayAmount: "支付宝",
      refundAmount: "退款金额",
      roundingAmount: "抹零金额",
      note: "备注",
      expenseTotal: "当日支出",
      profit: "简版利润"
    }),
    "日报总览"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(bundle.productSummary, {
      name: "商品名称",
      unit: "单位",
      saleMode: "销售方式",
      totalQuantity: "售卖数量/重量",
      totalAmount: "销售额"
    }),
    "单品汇总"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(bundle.sales, {
      id: "编号",
      date: "日期",
      productId: "商品编号",
      productName: "商品名称",
      saleMode: "销售方式",
      unit: "单位",
      price: "单价",
      quantity: "数量/重量",
      amount: "成交金额",
      note: "备注",
      createdBy: "录入人",
      createdAt: "创建时间",
      updatedAt: "更新时间"
    }),
    "单品销售"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(bundle.expenses, {
      id: "编号",
      date: "日期",
      expenseType: "支出类型",
      amount: "金额",
      note: "备注",
      createdBy: "录入人",
      createdAt: "创建时间",
      updatedAt: "更新时间"
    }),
    "支出明细"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(bundle.topProducts, {
      name: "商品名称",
      unit: "单位",
      saleMode: "销售方式",
      totalQuantity: "总销量",
      totalAmount: "销售额"
    }),
    "热销排行"
  );
  return workbook;
}

function createWorkbookForMonthly(api, month) {
  const summary = getMonthlySummary(api, month);
  const sales = getMonthlySaleEntries(api, month);
  const expenses = getMonthlyExpenseEntries(api, month);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet([summary.totals], {
      salesTotal: "销售总额",
      actualReceived: "实际收款额",
      expenseTotal: "总支出",
      profit: "简版利润"
    }),
    "月度汇总"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(summary.days, {
      date: "日期",
      salesTotal: "销售总额",
      actualReceived: "实际收款额",
      expenseTotal: "当日支出",
      profit: "简版利润"
    }),
    "每日销售汇总"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(summary.productSummary, {
      name: "商品名称",
      unit: "单位",
      saleMode: "销售方式",
      totalQuantity: "本月售卖数量/重量",
      totalAmount: "本月销售额"
    }),
    "单品月汇总"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(sales, {
      id: "编号",
      date: "日期",
      productName: "商品名称",
      saleMode: "销售方式",
      unit: "单位",
      price: "单价",
      quantity: "数量/重量",
      amount: "成交金额",
      note: "备注",
      createdBy: "录入人",
      createdAt: "创建时间",
      updatedAt: "更新时间"
    }),
    "单品销售明细"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(expenses, {
      id: "编号",
      date: "日期",
      expenseType: "支出类型",
      amount: "金额",
      note: "备注",
      createdBy: "录入人",
      createdAt: "创建时间",
      updatedAt: "更新时间"
    }),
    "支出明细"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(summary.topProducts, {
      name: "商品名称",
      unit: "单位",
      saleMode: "销售方式",
      totalQuantity: "总销量",
      totalAmount: "销售额"
    }),
    "单品排行"
  );
  return workbook;
}

async function startServer(port) {
  const api = await loadDatabase();
  const app = createApp(api);
  return new Promise(function launch(resolve) {
    const server = app.listen(port || PORT, function started() {
      resolve({ app: app, server: server, api: api });
    });
  });
}

if (require.main === module) {
  startServer(PORT).then(function onReady(info) {
    console.log(STORE_NAME + "已启动: http://localhost:" + info.server.address().port);
    console.log("店主账号 owner / admin123");
    console.log("店员账号 staff / staff123");
  }).catch(function onError(error) {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  startServer: startServer,
  todayText: todayText,
  monthText: monthText
};
