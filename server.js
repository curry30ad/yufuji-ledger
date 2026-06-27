const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const initSqlJs = require("sql.js/dist/sql-asm.js");
const Tesseract = require("tesseract.js");
const XLSX = require("xlsx");

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, "ledger.sqlite");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const TESSDATA_DIR = path.join(DATA_DIR, "tessdata");
const RECEIPT_LEXICON_PATH = path.join(__dirname, "receipt-lexicon.json");
const PORT = Number(process.env.PORT || 3000);
const sessionStore = new Map();
const DEFAULT_STORE_NAME = "\u4e8e\u798f\u8bb0\u719f\u98df\u5e97";
const STORE_NAME = "\u4e8e\u798f\u8bb0\u719f\u98df\u5e97";
const OWNER_DISPLAY_NAME = "\u4e8e\u798f\u8bb0";
const LEGACY_STORE_NAME_MAPPINGS = [
  { from: "é»è®¤é¨åº", to: DEFAULT_STORE_NAME },
  { from: "????", to: DEFAULT_STORE_NAME },
  { from: "??1", to: "门店1" }
];
const EXPENSE_TYPE_LABELS = {
  purchase: "进货支出",
  rent: "房租",
  utilities: "水电",
  labor: "人工",
  packaging: "包装耗材",
  platform_fee: "平台抽成",
  delivery: "配送费",
  other_daily: "其他日常支出"
};
const DEFAULT_RECEIPT_LEXICON = {
  ignoreLineKeywords: [],
  fieldPrefixes: [],
  unitKeywords: [],
  foodKeywords: [],
  ocrCorrections: {}
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function todayText() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeLegacyStoreName(value) {
  const rawText = String(value || "").trim();
  const matched = LEGACY_STORE_NAME_MAPPINGS.find(function findMapping(item) {
    return item.from === rawText;
  });
  return matched ? matched.to : rawText;
}

function normalizeStoreName(value) {
  const text = normalizeLegacyStoreName(value);
  return text || DEFAULT_STORE_NAME;
}

function isPlaceholderStoreName(value) {
  return /^store\d+$/i.test(String(value || "").trim());
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

function loadReceiptLexicon() {
  if (!fs.existsSync(RECEIPT_LEXICON_PATH)) {
    return Object.assign({}, DEFAULT_RECEIPT_LEXICON);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(RECEIPT_LEXICON_PATH, "utf8"));
    return {
      ignoreLineKeywords: Array.isArray(parsed.ignoreLineKeywords) ? parsed.ignoreLineKeywords : [],
      fieldPrefixes: Array.isArray(parsed.fieldPrefixes) ? parsed.fieldPrefixes : [],
      unitKeywords: Array.isArray(parsed.unitKeywords) ? parsed.unitKeywords : [],
      foodKeywords: Array.isArray(parsed.foodKeywords) ? parsed.foodKeywords : [],
      ocrCorrections: parsed && parsed.ocrCorrections ? parsed.ocrCorrections : {}
    };
  } catch (error) {
    return Object.assign({}, DEFAULT_RECEIPT_LEXICON);
  }
}

const RECEIPT_LEXICON = loadReceiptLexicon();

function normalizeMatchText(value) {
  let normalized = String(value || "")
    .toLowerCase()
    .replace(/[ï¼?]/g, " ")
    .replace(/[ï¼ï¼()ãã\[\]<>ãã]/g, "")
    .replace(/[ï¼?ã?!ï¼ï¼?ã?\\|_\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  Object.keys(RECEIPT_LEXICON.ocrCorrections || {}).forEach(function applyCorrection(key) {
    const from = String(key || "").toLowerCase();
    const to = String(RECEIPT_LEXICON.ocrCorrections[key] || "").toLowerCase();
    if (from && to) {
      normalized = normalized.split(from).join(to);
    }
  });
  return normalized.replace(/\s+/g, "");
}

function tokenizeMatchText(value) {
  const compact = normalizeMatchText(value);
  const tokens = [];
  for (let index = 0; index < compact.length; index += 1) {
    tokens.push(compact[index]);
    if (index < compact.length - 1) {
      tokens.push(compact.slice(index, index + 2));
    }
  }
  return Array.from(new Set(tokens.filter(Boolean)));
}

function cleanReceiptLine(line) {
  let next = String(line || "").trim();
  RECEIPT_LEXICON.fieldPrefixes.forEach(function stripPrefix(prefix) {
    next = next.replace(new RegExp("^" + prefix + "\\s*[:ï¼]?\\s*\\d*\\s*"), "");
  });
  Object.keys(RECEIPT_LEXICON.ocrCorrections || {}).forEach(function applyCorrection(key) {
    next = next.split(key).join(RECEIPT_LEXICON.ocrCorrections[key]);
  });
  return next.trim();
}

function shouldIgnoreReceiptLine(line) {
  const normalizedLine = normalizeMatchText(line);
  return RECEIPT_LEXICON.ignoreLineKeywords.some(function hasKeyword(keyword) {
    return normalizedLine.includes(normalizeMatchText(keyword));
  });
}

function containsReceiptFoodKeyword(line) {
  const normalizedLine = normalizeMatchText(line);
  return RECEIPT_LEXICON.foodKeywords.some(function hasKeyword(keyword) {
    return normalizedLine.includes(normalizeMatchText(keyword));
  });
}

function parseProductKeywords(value) {
  return String(value || "")
    .split(/[\n,，;；、|]/)
    .map(function mapKeyword(item) {
      return String(item || "").trim();
    })
    .filter(Boolean);
}

function splitReceiptLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(function mapLine(line) {
      return line.trim();
    })
    .filter(function filterLine(line) {
      return line.length >= 2;
    });
}

function money(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function intValue(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function normalizeExpenseType(value) {
  const text = String(value || "").trim();
  return Object.prototype.hasOwnProperty.call(EXPENSE_TYPE_LABELS, text) ? text : "other_daily";
}

function expenseTypeLabel(value) {
  return EXPENSE_TYPE_LABELS[normalizeExpenseType(value)] || EXPENSE_TYPE_LABELS.other_daily;
}

function buildProfitMetrics(salesTotal, purchaseTotal, expenseTotal) {
  const grossProfit = money(money(salesTotal) - money(purchaseTotal));
  const actualProfit = money(grossProfit - money(expenseTotal));
  return {
    grossProfit: grossProfit,
    actualProfit: actualProfit,
    profit: actualProfit
  };
}

function normalizePurchaseItemPayload(item) {
  const payload = item || {};
  const quantity = money(payload.quantity);
  const unitCost = money(payload.unitCost);
  return {
    productName: String(payload.productName || "").trim(),
    quantity: quantity,
    unit: String(payload.unit || "").trim(),
    unitCost: unitCost,
    totalCost: payload.totalCost === undefined || payload.totalCost === null || payload.totalCost === ""
      ? money(quantity * unitCost)
      : money(payload.totalCost)
  };
}

function createPurchaseOrderNo(date, storeName) {
  const datePart = String(date || todayText()).replace(/-/g, "");
  const storePart = Buffer.from(String(storeName || DEFAULT_STORE_NAME)).toString("hex").slice(0, 4).toUpperCase() || "MAIN";
  const randomPart = crypto.randomBytes(2).toString("hex").toUpperCase();
  return "PO-" + datePart + "-" + storePart + "-" + randomPart;
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
      store_name TEXT NOT NULL DEFAULT '${DEFAULT_STORE_NAME}',
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '',
      sale_mode TEXT NOT NULL,
      unit TEXT NOT NULL,
      price REAL NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      keywords TEXT NOT NULL DEFAULT '',
      default_unit TEXT NOT NULL DEFAULT '',
      last_unit_cost REAL NOT NULL DEFAULT 0,
      last_supplier TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_ledgers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger_date TEXT NOT NULL,
      store_name TEXT NOT NULL DEFAULT '${DEFAULT_STORE_NAME}',
      sales_total REAL NOT NULL DEFAULT 0,
      actual_received REAL NOT NULL DEFAULT 0,
      cash_amount REAL NOT NULL DEFAULT 0,
      wechat_amount REAL NOT NULL DEFAULT 0,
      alipay_amount REAL NOT NULL DEFAULT 0,
      member_card_amount REAL NOT NULL DEFAULT 0,
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
      store_name TEXT NOT NULL DEFAULT '${DEFAULT_STORE_NAME}',
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
      store_name TEXT NOT NULL DEFAULT '${DEFAULT_STORE_NAME}',
      expense_type TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_date TEXT NOT NULL,
      store_name TEXT NOT NULL DEFAULT '${DEFAULT_STORE_NAME}',
      purchase_order_no TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT '',
      unit_cost REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      supplier TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `;

  api.raw.exec(schemaSql);
  persistNow(api);
}

function tableHasColumn(api, tableName, columnName) {
  const columns = api.all("PRAGMA table_info(" + tableName + ")");
  return columns.some(function checkColumn(column) {
    return column.name === columnName;
  });
}

function ensureColumn(api, tableName, definition) {
  const columnName = definition.split(/\s+/)[0];
  if (!tableHasColumn(api, tableName, columnName)) {
    api.raw.exec("ALTER TABLE " + tableName + " ADD COLUMN " + definition);
  }
}

function ensurePurchaseProductSeeded(api) {
  const seededRow = api.one("SELECT id FROM purchase_products LIMIT 1");
  if (seededRow) {
    return;
  }
  const rows = api.all(`
    SELECT p.product_name, p.unit, p.unit_cost, p.supplier, p.created_at, p.updated_at
    FROM purchase_entries p
    INNER JOIN (
      SELECT product_name, MAX(COALESCE(updated_at, created_at)) AS latest_at
      FROM purchase_entries
      WHERE TRIM(product_name) <> ''
      GROUP BY product_name
    ) latest
      ON latest.product_name = p.product_name
     AND latest.latest_at = COALESCE(p.updated_at, p.created_at)
    WHERE TRIM(p.product_name) <> ''
    ORDER BY p.product_name ASC, p.id DESC
  `);
  const insertedNames = new Set();
  rows.forEach(function seedRow(row) {
    const productName = String(row.product_name || "").trim();
    if (!productName || insertedNames.has(productName)) {
      return;
    }
    insertedNames.add(productName);
    const createdAt = row.created_at || row.updated_at || new Date().toISOString();
    const updatedAt = row.updated_at || row.created_at || createdAt;
    api.run(
      "INSERT INTO purchase_products (name, keywords, default_unit, last_unit_cost, last_supplier, is_active, sort_order, created_at, updated_at) VALUES (?, '', ?, ?, ?, 1, 0, ?, ?)",
      [
        productName,
        String(row.unit || "").trim(),
        money(row.unit_cost),
        String(row.supplier || "").trim(),
        createdAt,
        updatedAt
      ]
    );
  });
}

function rebuildPurchaseProductByName(api, productName) {
  const normalizedName = String(productName || "").trim();
  if (!normalizedName) {
    return;
  }
  const latestEntry = api.one(
    "SELECT * FROM purchase_entries WHERE product_name = ? ORDER BY purchase_date DESC, COALESCE(updated_at, created_at) DESC, id DESC LIMIT 1",
    [normalizedName]
  );
  if (!latestEntry) {
    api.run("DELETE FROM purchase_products WHERE name = ?", [normalizedName]);
    return;
  }
  const existing = api.one("SELECT * FROM purchase_products WHERE name = ?", [normalizedName]);
  const createdAt = existing ? existing.created_at : (latestEntry.created_at || latestEntry.updated_at || new Date().toISOString());
  const updatedAt = latestEntry.updated_at || latestEntry.created_at || new Date().toISOString();
  const keywords = existing ? String(existing.keywords || "") : "";
  const isActive = existing ? intValue(existing.is_active, 1) : 1;
  const sortOrder = existing ? intValue(existing.sort_order, 0) : 0;

  if (existing) {
    api.run(
      "UPDATE purchase_products SET keywords = ?, default_unit = ?, last_unit_cost = ?, last_supplier = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?",
      [
        keywords,
        String(latestEntry.unit || "").trim(),
        money(latestEntry.unit_cost),
        String(latestEntry.supplier || "").trim(),
        isActive,
        sortOrder,
        updatedAt,
        existing.id
      ]
    );
  } else {
    api.run(
      "INSERT INTO purchase_products (name, keywords, default_unit, last_unit_cost, last_supplier, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        normalizedName,
        keywords,
        String(latestEntry.unit || "").trim(),
        money(latestEntry.unit_cost),
        String(latestEntry.supplier || "").trim(),
        isActive,
        sortOrder,
        createdAt,
        updatedAt
      ]
    );
  }
}

function getPurchaseProducts(api, includeInactive) {
  return api.all(
    "SELECT * FROM purchase_products " + (includeInactive ? "" : "WHERE is_active = 1 ") + "ORDER BY sort_order ASC, id ASC"
  ).map(function mapPurchaseProduct(row) {
    return {
      id: row.id,
      name: row.name,
      keywords: row.keywords || "",
      defaultUnit: row.default_unit || "",
      lastUnitCost: money(row.last_unit_cost),
      lastSupplier: row.last_supplier || "",
      isActive: Boolean(row.is_active),
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

function normalizePurchaseProductPayload(body) {
  const source = body || {};
  return {
    name: String(source.name || "").trim(),
    keywords: String(source.keywords || "").trim(),
    defaultUnit: String(source.defaultUnit || "").trim(),
    lastUnitCost: money(source.lastUnitCost),
    lastSupplier: String(source.lastSupplier || "").trim(),
    isActive: source.isActive === false ? 0 : 1,
    sortOrder: intValue(source.sortOrder, 0)
  };
}

function ensureDailyLedgerCompositeKey(api) {
  const indexes = api.all("PRAGMA index_list(daily_ledgers)");
  const hasCompositeIndex = indexes.some(function hasIndex(index) {
    const info = api.all("PRAGMA index_info(" + index.name + ")");
    const names = info.map(function mapColumn(column) {
      return column.name;
    });
    return names.length === 2 && names[0] === "ledger_date" && names[1] === "store_name";
  });

  if (tableHasColumn(api, "daily_ledgers", "store_name") && hasCompositeIndex) {
    return;
  }

  api.raw.exec(`
    CREATE TABLE daily_ledgers_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledger_date TEXT NOT NULL,
      store_name TEXT NOT NULL DEFAULT '${DEFAULT_STORE_NAME}',
      sales_total REAL NOT NULL DEFAULT 0,
      actual_received REAL NOT NULL DEFAULT 0,
      cash_amount REAL NOT NULL DEFAULT 0,
      wechat_amount REAL NOT NULL DEFAULT 0,
      alipay_amount REAL NOT NULL DEFAULT 0,
      member_card_amount REAL NOT NULL DEFAULT 0,
      refund_amount REAL NOT NULL DEFAULT 0,
      rounding_amount REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      updated_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  if (tableHasColumn(api, "daily_ledgers", "store_name")) {
    api.raw.exec(`
      INSERT INTO daily_ledgers_new (
        id, ledger_date, store_name, sales_total, actual_received, cash_amount, wechat_amount,
        alipay_amount, member_card_amount, refund_amount, rounding_amount, note, created_by, updated_by, created_at, updated_at
      )
      SELECT
        id, ledger_date, COALESCE(NULLIF(store_name, ''), '${DEFAULT_STORE_NAME}'), sales_total, actual_received,
        cash_amount, wechat_amount, alipay_amount, ${tableHasColumn(api, "daily_ledgers", "member_card_amount") ? "member_card_amount" : "0"}, refund_amount, rounding_amount, note,
        created_by, updated_by, created_at, updated_at
      FROM daily_ledgers
    `);
  } else {
    api.raw.exec(`
      INSERT INTO daily_ledgers_new (
        id, ledger_date, store_name, sales_total, actual_received, cash_amount, wechat_amount,
        alipay_amount, member_card_amount, refund_amount, rounding_amount, note, created_by, updated_by, created_at, updated_at
      )
      SELECT
        id, ledger_date, '${DEFAULT_STORE_NAME}', sales_total, actual_received, cash_amount, wechat_amount,
        alipay_amount, ${tableHasColumn(api, "daily_ledgers", "member_card_amount") ? "member_card_amount" : "0"}, refund_amount, rounding_amount, note, created_by, updated_by, created_at, updated_at
      FROM daily_ledgers
    `);
  }

  api.raw.exec("DROP TABLE daily_ledgers");
  api.raw.exec("ALTER TABLE daily_ledgers_new RENAME TO daily_ledgers");
  api.raw.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_ledgers_date_store ON daily_ledgers(ledger_date, store_name)");
}

function mergeLegacyDailyLedgerStore(api, fromStoreName, toStoreName) {
  const sourceRows = api.all("SELECT * FROM daily_ledgers WHERE store_name = ? ORDER BY ledger_date ASC, id ASC", [fromStoreName]);
  sourceRows.forEach(function mergeRow(sourceRow) {
    const targetRow = api.one("SELECT * FROM daily_ledgers WHERE ledger_date = ? AND store_name = ?", [sourceRow.ledger_date, toStoreName]);
    if (!targetRow) {
      api.run("UPDATE daily_ledgers SET store_name = ? WHERE id = ?", [toStoreName, sourceRow.id]);
      return;
    }

    const mergedNote = [String(targetRow.note || "").trim(), String(sourceRow.note || "").trim()]
      .filter(Boolean)
      .join(" | ");

    api.run(
      "UPDATE daily_ledgers SET sales_total = ?, actual_received = ?, cash_amount = ?, wechat_amount = ?, alipay_amount = ?, member_card_amount = ?, refund_amount = ?, rounding_amount = ?, note = ?, updated_at = ? WHERE id = ?",
      [
        money(targetRow.sales_total) + money(sourceRow.sales_total),
        money(targetRow.actual_received) + money(sourceRow.actual_received),
        money(targetRow.cash_amount) + money(sourceRow.cash_amount),
        money(targetRow.wechat_amount) + money(sourceRow.wechat_amount),
        money(targetRow.alipay_amount) + money(sourceRow.alipay_amount),
        money(targetRow.member_card_amount) + money(sourceRow.member_card_amount),
        money(targetRow.refund_amount) + money(sourceRow.refund_amount),
        money(targetRow.rounding_amount) + money(sourceRow.rounding_amount),
        mergedNote,
        new Date().toISOString(),
        targetRow.id
      ]
    );
    api.run("DELETE FROM daily_ledgers WHERE id = ?", [sourceRow.id]);
  });
}

function migrateSchema(api) {
  ensureColumn(api, "users", "store_name TEXT NOT NULL DEFAULT '" + DEFAULT_STORE_NAME + "'");
  ensureColumn(api, "products", "keywords TEXT NOT NULL DEFAULT ''");
  ensureColumn(api, "purchase_products", "keywords TEXT NOT NULL DEFAULT ''");
  ensureColumn(api, "purchase_products", "default_unit TEXT NOT NULL DEFAULT ''");
  ensureColumn(api, "purchase_products", "last_unit_cost REAL NOT NULL DEFAULT 0");
  ensureColumn(api, "purchase_products", "last_supplier TEXT NOT NULL DEFAULT ''");
  ensureColumn(api, "purchase_products", "is_active INTEGER NOT NULL DEFAULT 1");
  ensureColumn(api, "purchase_products", "sort_order INTEGER NOT NULL DEFAULT 0");
  ensureColumn(api, "sale_entries", "store_name TEXT NOT NULL DEFAULT '" + DEFAULT_STORE_NAME + "'");
  ensureColumn(api, "expense_entries", "store_name TEXT NOT NULL DEFAULT '" + DEFAULT_STORE_NAME + "'");
  ensureColumn(api, "purchase_entries", "store_name TEXT NOT NULL DEFAULT '" + DEFAULT_STORE_NAME + "'");
  ensureColumn(api, "purchase_entries", "purchase_order_no TEXT NOT NULL DEFAULT ''");
  ensureColumn(api, "purchase_entries", "supplier TEXT NOT NULL DEFAULT ''");
  ensureDailyLedgerCompositeKey(api);
  ensureColumn(api, "daily_ledgers", "member_card_amount REAL NOT NULL DEFAULT 0");
  api.raw.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_products_name ON purchase_products(name)");
  api.raw.exec("CREATE INDEX IF NOT EXISTS idx_sale_entries_date_store ON sale_entries(sale_date, store_name)");
  api.raw.exec("CREATE INDEX IF NOT EXISTS idx_expense_entries_date_store ON expense_entries(expense_date, store_name)");
  api.raw.exec("CREATE INDEX IF NOT EXISTS idx_purchase_entries_date_store ON purchase_entries(purchase_date, store_name)");
  api.raw.exec("CREATE INDEX IF NOT EXISTS idx_purchase_entries_order_no ON purchase_entries(purchase_order_no)");

  api.run("UPDATE users SET store_name = ? WHERE store_name IS NULL OR TRIM(store_name) = ''", [DEFAULT_STORE_NAME]);
  api.run("UPDATE sale_entries SET store_name = ? WHERE store_name IS NULL OR TRIM(store_name) = ''", [DEFAULT_STORE_NAME]);
  api.run("UPDATE expense_entries SET store_name = ? WHERE store_name IS NULL OR TRIM(store_name) = ''", [DEFAULT_STORE_NAME]);
  api.run("UPDATE purchase_entries SET store_name = ? WHERE store_name IS NULL OR TRIM(store_name) = ''", [DEFAULT_STORE_NAME]);
  api.run("UPDATE expense_entries SET expense_type = 'other_daily' WHERE expense_type IS NULL OR TRIM(expense_type) = '' OR expense_type = 'daily'", []);
  api.run("UPDATE daily_ledgers SET store_name = ? WHERE store_name IS NULL OR TRIM(store_name) = ''", [DEFAULT_STORE_NAME]);
  LEGACY_STORE_NAME_MAPPINGS.forEach(function applyLegacyStoreMapping(item) {
    api.run("UPDATE users SET store_name = ? WHERE store_name = ?", [item.to, item.from]);
    mergeLegacyDailyLedgerStore(api, item.from, item.to);
    api.run("UPDATE sale_entries SET store_name = ? WHERE store_name = ?", [item.to, item.from]);
    api.run("UPDATE expense_entries SET store_name = ? WHERE store_name = ?", [item.to, item.from]);
    api.run("UPDATE purchase_entries SET store_name = ? WHERE store_name = ?", [item.to, item.from]);
  });
  api.run("UPDATE users SET name = ?, store_name = ? WHERE username = 'owner'", [OWNER_DISPLAY_NAME, DEFAULT_STORE_NAME]);
  ensurePurchaseProductSeeded(api);
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
  const store1Hash = bcrypt.hashSync("123456", 10);
  const store2Hash = bcrypt.hashSync("123456", 10);
  api.run(
    "INSERT INTO users (username, password_hash, name, store_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ["owner", ownerHash, OWNER_DISPLAY_NAME, DEFAULT_STORE_NAME, "owner", now]
  );
  api.run(
    "INSERT INTO users (username, password_hash, name, store_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ["store1", store1Hash, "门店1", "门店1", "staff", now]
  );
  api.run(
    "INSERT INTO users (username, password_hash, name, store_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ["store2", store2Hash, "门店2", "门店2", "staff", now]
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
  migrateSchema(api);
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
    storeName: normalizeStoreName(row.store_name),
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
  return Object.assign({}, ledger, { grossProfit: null, actualProfit: null, profit: null });
}

function getAvailableStores(api) {
  const rows = api.all(`
    SELECT store_name FROM users WHERE role = 'staff'
    UNION
    SELECT store_name FROM daily_ledgers
    UNION
    SELECT store_name FROM sale_entries
    UNION
    SELECT store_name FROM expense_entries
    UNION
    SELECT store_name FROM purchase_entries
  `);
  const values = rows.map(function mapStore(row) {
    return normalizeStoreName(row.store_name);
  }).filter(function filterStoreName(storeName) {
    return Boolean(storeName) && !isPlaceholderStoreName(storeName);
  });
  const unique = Array.from(new Set(values));
  if (!unique.length) {
    unique.push(DEFAULT_STORE_NAME);
  }
  return unique.sort();
}

function resolveRequestedStoreName(req, inputStoreName, allowAll) {
  if (!req.user || req.user.role !== "owner") {
    return normalizeStoreName(req.user && req.user.storeName);
  }
  if (allowAll && String(inputStoreName || "").trim() === "all") {
    return null;
  }
  return normalizeStoreName(inputStoreName);
}

function resolveStoreName(req, inputStoreName) {
  if (!req.user || req.user.role !== "owner") {
    return normalizeStoreName(req.user && req.user.storeName);
  }
  return normalizeStoreName(inputStoreName);
}

function canAccessStore(req, storeName) {
  if (!req.user) {
    return false;
  }
  if (req.user.role === "owner") {
    return true;
  }
  return normalizeStoreName(req.user.storeName) === normalizeStoreName(storeName);
}

function requireStoreAccess(req, res, storeName) {
  if (canAccessStore(req, storeName)) {
    return true;
  }
  res.status(403).json({ error: "You cannot operate on another store's records." });
  return false;
}

function ensureWritableRecord(req, res, row, notFoundMessage) {
  if (!row) {
    res.status(404).json({ error: notFoundMessage });
    return null;
  }
  if (!requireStoreAccess(req, res, row.store_name)) {
    return null;
  }
  return row;
}

function buildStoreFilter(columnName, storeName) {
  if (!storeName) {
    return { clause: "", params: [] };
  }
  return { clause: " AND " + columnName + " = ?", params: [normalizeStoreName(storeName)] };
}

function ensureLedger(api, date, userId, storeName) {
  const now = new Date().toISOString();
  const normalizedStoreName = normalizeStoreName(storeName);
  const ledger = api.one("SELECT * FROM daily_ledgers WHERE ledger_date = ? AND store_name = ?", [date, normalizedStoreName]);
  if (ledger) {
    return ledger;
  }

  api.run(
    "INSERT INTO daily_ledgers (ledger_date, store_name, sales_total, actual_received, cash_amount, wechat_amount, alipay_amount, member_card_amount, refund_amount, rounding_amount, note, created_by, updated_by, created_at, updated_at) VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, '', ?, ?, ?, ?)",
    [date, normalizedStoreName, userId || null, userId || null, now, now]
  );
  return api.one("SELECT * FROM daily_ledgers WHERE ledger_date = ? AND store_name = ?", [date, normalizedStoreName]);
}

function getExpensesTotal(api, date, storeName) {
  const filter = buildStoreFilter("store_name", storeName);
  const row = api.one(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM expense_entries WHERE expense_date = ?" + filter.clause,
    [date].concat(filter.params)
  );
  return money(row ? row.total : 0);
}

function getPurchasesTotal(api, date, storeName) {
  const filter = buildStoreFilter("store_name", storeName);
  const row = api.one(
    "SELECT COALESCE(SUM(total_cost), 0) AS total FROM purchase_entries WHERE purchase_date = ?" + filter.clause,
    [date].concat(filter.params)
  );
  return money(row ? row.total : 0);
}

function getTopProducts(api, fromDate, toDate, limit, storeName) {
  const filter = buildStoreFilter("s.store_name", storeName);
  const rows = api.all(
    "SELECT p.name, p.unit, p.sale_mode, ROUND(SUM(s.quantity), 2) AS total_quantity, ROUND(SUM(s.amount), 2) AS total_amount FROM sale_entries s JOIN products p ON p.id = s.product_id WHERE s.sale_date BETWEEN ? AND ?" + filter.clause + " GROUP BY s.product_id ORDER BY SUM(s.amount) DESC, SUM(s.quantity) DESC LIMIT ?",
    [fromDate, toDate].concat(filter.params).concat([limit])
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

function getActiveProducts(api) {
  return api.all(
    "SELECT id, name, keywords, sale_mode, unit, price FROM products WHERE is_active = 1 ORDER BY sort_order ASC, id ASC"
  ).map(function mapProduct(row) {
    const normalizedName = normalizeMatchText(row.name);
    const aliasKeywords = parseProductKeywords(row.keywords);
    const aliasTokens = aliasKeywords.map(function mapAlias(keyword) {
      return {
        text: keyword,
        normalized: normalizeMatchText(keyword),
        tokens: tokenizeMatchText(keyword)
      };
    }).filter(function filterAlias(item) {
      return item.normalized;
    });
    return {
      id: row.id,
      name: row.name,
      keywords: row.keywords || "",
      saleMode: row.sale_mode,
      unit: row.unit,
      price: money(row.price),
      normalizedName: normalizedName,
      tokens: tokenizeMatchText(row.name),
      aliasTokens: aliasTokens
    };
  });
}

function getReceiptProductScore(line, product) {
  const normalizedLine = normalizeMatchText(line);
  const lineTokens = tokenizeMatchText(line);
  if (!product || !product.normalizedName) {
    return 0;
  }

  function scoreAgainst(normalizedTarget, targetTokens) {
    if (!normalizedTarget) {
      return 0;
    }
    if (normalizedLine.includes(normalizedTarget)) {
      return 100 + normalizedTarget.length;
    }

    const tokenMatches = targetTokens.filter(function (token) {
      return lineTokens.includes(token);
    }).length;
    const tokenRatio = targetTokens.length ? tokenMatches / targetTokens.length : 0;
    const overlapChars = normalizedTarget.split("").filter(function (char) {
      return normalizedLine.includes(char);
    }).length;
    const charRatio = overlapChars / normalizedTarget.length;
    const ratio = Math.max(tokenRatio, charRatio);
    if (normalizedTarget.length >= 2 && ratio >= 0.55) {
      return Math.round(ratio * 90);
    }
    return 0;
  }

  var bestScore = scoreAgainst(product.normalizedName, product.tokens);
  (product.aliasTokens || []).forEach(function checkAlias(alias) {
    bestScore = Math.max(bestScore, scoreAgainst(alias.normalized, alias.tokens));
  });
  return bestScore;
}

function getReceiptProductRecommendations(line, products, limit) {
  return products.map(function mapProduct(product) {
    return {
      productId: product.id,
      productName: product.name,
      unit: product.unit,
      score: getReceiptProductScore(line, product)
    };
  }).filter(function filterItem(item) {
    return item.score > 0;
  }).sort(function sortItems(a, b) {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return String(a.productName).localeCompare(String(b.productName), "zh-CN");
  }).slice(0, limit || 3);
}

function findBestReceiptProduct(line, products) {
  const recommendations = getReceiptProductRecommendations(line, products, 1);
  if (!recommendations.length || recommendations[0].score < 50) {
    return null;
  }
  const product = products.find(function findProduct(item) {
    return item.id === recommendations[0].productId;
  });
  return product
    ? { product: product, score: recommendations[0].score }
    : null;
}

function extractReceiptQuantity(line, product) {
  const text = String(line || "");
  const weightMatch = text.match(/(\d+(?:\.\d+)?)\s*(斤|公斤|kg|KG|千克|g|克|两)/);
  if (weightMatch) {
    const rawValue = Number(weightMatch[1]);
    const unitText = String(weightMatch[2] || "").toLowerCase();
    if (unitText === "公斤" || unitText === "kg" || unitText === "千克") {
      return money(rawValue * 2);
    }
    if (unitText === "g" || unitText === "克") {
      return money(rawValue / 500);
    }
    if (unitText === "两") {
      return money(rawValue / 10);
    }
    return money(rawValue);
  }

  const pieceMatch = text.match(/(\d+(?:\.\d+)?)\s*(份|盒|袋|包|个|串|只)/);
  if (pieceMatch) {
    return money(pieceMatch[1]);
  }

  const allNumbers = text.match(/\d+(?:\.\d+)?/g) || [];
  if (!allNumbers.length) {
    return product && product.saleMode === "weight" ? 0.5 : 1;
  }

  if (product && product.saleMode === "weight") {
    const decimalNumber = allNumbers.find(function findDecimal(item) {
      return String(item).includes(".");
    });
    return money(decimalNumber || allNumbers[0]);
  }

  const integerNumber = allNumbers.find(function findInteger(item) {
    return !String(item).includes(".");
  });
  return money(integerNumber || allNumbers[0]);
}

function extractReceiptAmount(line) {
  const text = String(line || "");
  const currencyMatches = [...text.matchAll(/(?:¥|￥)\s*(\d+\.\d{1,2})/g)].map(function mapMatch(match) {
    return Number(match[1]);
  });
  if (!currencyMatches.length) {
    const compactAmountMatch = text.match(/(?:¥|￥|#)\s*(\d{3,6})(?!\d)/);
    if (!compactAmountMatch) {
      return null;
    }
    const compactValue = Number(compactAmountMatch[1]);
    return compactValue >= 100 ? money(compactValue / 100) : money(compactValue);
  }
  return money(currencyMatches[currencyMatches.length - 1]);
}

async function scanReceiptImage(api, imagePath) {
  const products = getActiveProducts(api);
  ensureDir(TESSDATA_DIR);
  const result = await Tesseract.recognize(imagePath, "chi_sim+eng", {
    langPath: "http://127.0.0.1:" + PORT + "/tessdata",
    logger: function noop() {}
  });
  const text = result && result.data ? result.data.text : "";
  const lines = splitReceiptLines(text).map(cleanReceiptLine).filter(Boolean);
  const matchedItems = [];
  const unmatchedItems = [];

  lines.forEach(function handleLine(line) {
    if (shouldIgnoreReceiptLine(line)) {
      return;
    }
    const productMatch = findBestReceiptProduct(line, products);
    if (!productMatch) {
      const recommendedProducts = getReceiptProductRecommendations(line, products, 3);
      unmatchedItems.push({
        sourceLine: line,
        guessedQuantity: extractReceiptQuantity(line, null),
        guessedAmount: extractReceiptAmount(line),
        recommendedProducts: recommendedProducts
      });
      return;
    }
    const quantity = extractReceiptQuantity(line, productMatch.product);
    if (!quantity) {
      unmatchedItems.push({
        sourceLine: line,
        guessedQuantity: "",
        guessedAmount: extractReceiptAmount(line),
        recommendedProducts: getReceiptProductRecommendations(line, products, 3)
      });
      return;
    }
    matchedItems.push({
      productId: productMatch.product.id,
      productName: productMatch.product.name,
      saleMode: productMatch.product.saleMode,
      unit: productMatch.product.unit,
      quantity: quantity,
      amount: extractReceiptAmount(line),
      confidence: productMatch.score,
      sourceLine: line
    });
  });

  const mergedItems = [];
  matchedItems.forEach(function mergeItem(item) {
    const existing = mergedItems.find(function findItem(current) {
      return current.productId === item.productId;
    });
    if (existing) {
      existing.quantity = money(existing.quantity + item.quantity);
      existing.amount = item.amount === null && existing.amount === null
        ? null
        : money((existing.amount || 0) + (item.amount || 0));
      existing.sourceLine = existing.sourceLine + " | " + item.sourceLine;
      existing.confidence = Math.max(existing.confidence, item.confidence);
      return;
    }
    mergedItems.push(item);
  });

  return {
    rawText: text,
    recognizedItems: mergedItems,
    unmatchedItems: unmatchedItems,
    unmatchedLines: unmatchedItems.map(function mapItem(item) {
      return item.sourceLine;
    })
  };
}

function getProductSalesSummary(api, fromDate, toDate, storeName) {
  const filter = buildStoreFilter("s.store_name", storeName);
  const rows = api.all(
    "SELECT p.name, p.unit, p.sale_mode, ROUND(SUM(s.quantity), 2) AS total_quantity, ROUND(SUM(s.amount), 2) AS total_amount FROM sale_entries s JOIN products p ON p.id = s.product_id WHERE s.sale_date BETWEEN ? AND ?" + filter.clause + " GROUP BY s.product_id ORDER BY SUM(s.amount) DESC, SUM(s.quantity) DESC, p.name ASC",
    [fromDate, toDate].concat(filter.params)
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

function getPurchaseEntries(api, date, storeName) {
  const normalizedStoreName = storeName ? normalizeStoreName(storeName) : null;
  const filter = buildStoreFilter("store_name", normalizedStoreName);
  return api.all(
    "SELECT * FROM purchase_entries WHERE purchase_date = ?" + filter.clause + " ORDER BY purchase_order_no DESC, id ASC",
    [date].concat(filter.params)
  ).map(function mapRow(row) {
    return {
      id: row.id,
      date: row.purchase_date,
      storeName: normalizeStoreName(row.store_name),
      purchaseOrderNo: row.purchase_order_no || "",
      productName: row.product_name,
      quantity: money(row.quantity),
      unit: row.unit || "",
      unitCost: money(row.unit_cost),
      totalCost: money(row.total_cost),
      supplier: row.supplier || "",
      note: row.note || "",
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

function getMonthlyPurchaseEntries(api, month, storeName) {
  const fromDate = month + "-01";
  const toDate = month + "-31";
  const normalizedStoreName = storeName ? normalizeStoreName(storeName) : null;
  const filter = buildStoreFilter("store_name", normalizedStoreName);
  return api.all(
    "SELECT * FROM purchase_entries WHERE purchase_date BETWEEN ? AND ?" + filter.clause + " ORDER BY purchase_date ASC, purchase_order_no ASC, id ASC",
    [fromDate, toDate].concat(filter.params)
  ).map(function mapRow(row) {
    return {
      id: row.id,
      date: row.purchase_date,
      storeName: normalizeStoreName(row.store_name),
      purchaseOrderNo: row.purchase_order_no || "",
      productName: row.product_name,
      quantity: money(row.quantity),
      unit: row.unit || "",
      unitCost: money(row.unit_cost),
      totalCost: money(row.total_cost),
      supplier: row.supplier || "",
      note: row.note || "",
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
}

function getMonthlyPurchaseSummary(api, month, storeName) {
  const entries = getMonthlyPurchaseEntries(api, month, storeName);
  const totalCost = entries.reduce(function sum(acc, item) {
    return acc + money(item.totalCost);
  }, 0);
  const orderCount = Array.from(new Set(entries.map(function mapOrder(item) {
    return String(item.purchaseOrderNo || "").trim();
  }).filter(Boolean))).length;
  return {
    totalCost: money(totalCost),
    entryCount: entries.length,
    orderCount: orderCount,
    productCount: Array.from(new Set(entries.map(function mapItem(item) {
      return String(item.productName || "").trim();
    }).filter(Boolean))).length
  };
}

function getMonthlyPurchaseProductSummary(api, month, storeName) {
  const entries = getMonthlyPurchaseEntries(api, month, storeName);
  const grouped = {};

  entries.forEach(function groupEntry(item) {
    const productName = String(item.productName || "").trim();
    if (!productName) {
      return;
    }
    if (!grouped[productName]) {
      grouped[productName] = {
        productName: productName,
        totalQuantity: 0,
        unitSet: new Set(),
        totalCost: 0,
        entryCount: 0,
        supplierSet: new Set(),
        lastUnitCost: 0,
        lastPurchaseDate: item.date || "",
        lastStoreName: item.storeName || ""
      };
    }
    const current = grouped[productName];
    current.totalQuantity = money(current.totalQuantity + money(item.quantity));
    current.totalCost = money(current.totalCost + money(item.totalCost));
    current.entryCount += 1;
    if (item.unit) {
      current.unitSet.add(String(item.unit).trim());
    }
    if (item.supplier) {
      current.supplierSet.add(String(item.supplier).trim());
    }
    const currentStamp = String(item.updatedAt || item.createdAt || item.date || "");
    const latestStamp = String(current._latestStamp || "");
    if (!latestStamp || currentStamp >= latestStamp) {
      current._latestStamp = currentStamp;
      current.lastUnitCost = money(item.unitCost);
      current.lastPurchaseDate = item.date || "";
      current.lastStoreName = item.storeName || "";
    }
  });

  return Object.keys(grouped).sort(function sortNames(a, b) {
    return a.localeCompare(b, "zh-CN");
  }).map(function mapGroup(key) {
    const item = grouped[key];
    const units = Array.from(item.unitSet);
    const suppliers = Array.from(item.supplierSet);
    return {
      productName: item.productName,
      totalQuantity: money(item.totalQuantity),
      unit: units.length === 1 ? units[0] : units.join(" / "),
      totalCost: money(item.totalCost),
      entryCount: item.entryCount,
      averageCost: item.entryCount ? money(item.totalCost / item.entryCount) : 0,
      lastUnitCost: money(item.lastUnitCost),
      supplierSummary: suppliers.join(" / "),
      lastPurchaseDate: item.lastPurchaseDate,
      lastStoreName: item.lastStoreName
    };
  });
}

function getMonthlyPurchaseDailySummary(api, month, storeName) {
  const entries = getMonthlyPurchaseEntries(api, month, storeName);
  const grouped = {};

  entries.forEach(function groupEntry(item) {
    const date = item.date || "";
    if (!date) {
      return;
    }
    if (!grouped[date]) {
      grouped[date] = {
        date: date,
        storeSet: new Set(),
        productSet: new Set(),
        orderSet: new Set(),
        entryCount: 0,
        totalQuantity: 0,
        totalCost: 0
      };
    }
    const current = grouped[date];
    current.entryCount += 1;
    current.totalQuantity = money(current.totalQuantity + money(item.quantity));
    current.totalCost = money(current.totalCost + money(item.totalCost));
    if (item.storeName) {
      current.storeSet.add(String(item.storeName).trim());
    }
    if (item.productName) {
      current.productSet.add(String(item.productName).trim());
    }
    if (item.purchaseOrderNo) {
      current.orderSet.add(String(item.purchaseOrderNo).trim());
    }
  });

  return Object.keys(grouped).sort().map(function mapGroup(key) {
    const item = grouped[key];
    return {
      date: item.date,
      storeName: Array.from(item.storeSet).join(" / "),
      productCount: item.productSet.size,
      orderCount: item.orderSet.size,
      entryCount: item.entryCount,
      totalQuantity: money(item.totalQuantity),
      totalCost: money(item.totalCost)
    };
  });
}

function getMonthlyStoreSalesSummary(api, month) {
  const fromDate = month + "-01";
  const toDate = month + "-31";
  const saleRows = api.all(
    "SELECT store_name, ROUND(SUM(sales_total), 2) AS sales_total, ROUND(SUM(actual_received), 2) AS actual_received FROM daily_ledgers WHERE ledger_date BETWEEN ? AND ? GROUP BY store_name ORDER BY store_name ASC",
    [fromDate, toDate]
  );
  const purchaseRows = api.all(
    "SELECT store_name, ROUND(SUM(total_cost), 2) AS total_cost FROM purchase_entries WHERE purchase_date BETWEEN ? AND ? GROUP BY store_name ORDER BY store_name ASC",
    [fromDate, toDate]
  );
  const expenseRows = api.all(
    "SELECT store_name, ROUND(SUM(amount), 2) AS total FROM expense_entries WHERE expense_date BETWEEN ? AND ? GROUP BY store_name ORDER BY store_name ASC",
    [fromDate, toDate]
  );
  const purchaseMap = {};
  const expenseMap = {};
  purchaseRows.forEach(function fillPurchaseMap(row) {
    purchaseMap[normalizeStoreName(row.store_name)] = money(row.total_cost);
  });
  expenseRows.forEach(function fillExpenseMap(row) {
    expenseMap[normalizeStoreName(row.store_name)] = money(row.total);
  });
  return saleRows.map(function mapRow(row) {
    const storeName = normalizeStoreName(row.store_name);
    const salesTotal = money(row.sales_total);
    const purchaseTotal = money(purchaseMap[storeName] || 0);
    const expenseTotal = money(expenseMap[storeName] || 0);
    const profitMetrics = buildProfitMetrics(salesTotal, purchaseTotal, expenseTotal);
    return {
      storeName: storeName,
      salesTotal: salesTotal,
      actualReceived: money(row.actual_received),
      purchaseTotal: purchaseTotal,
      expenseTotal: expenseTotal,
      grossProfit: profitMetrics.grossProfit,
      actualProfit: profitMetrics.actualProfit,
      profit: profitMetrics.actualProfit
    };
  });
}

function getInventorySummary(api, date, storeName) {
  const normalizedStoreName = storeName ? normalizeStoreName(storeName) : null;
  const purchaseFilter = buildStoreFilter("store_name", normalizedStoreName);
  const saleFilter = buildStoreFilter("s.store_name", normalizedStoreName);
  const purchaseRows = api.all(
    "SELECT product_name, unit, ROUND(SUM(quantity), 2) AS total_quantity FROM purchase_entries WHERE purchase_date <= ?" + purchaseFilter.clause + " GROUP BY product_name, unit ORDER BY product_name ASC",
    [date].concat(purchaseFilter.params)
  );
  const saleRows = api.all(
    "SELECT p.name AS product_name, p.unit, ROUND(SUM(s.quantity), 2) AS total_quantity FROM sale_entries s JOIN products p ON p.id = s.product_id WHERE s.sale_date <= ?" + saleFilter.clause + " GROUP BY p.name, p.unit ORDER BY p.name ASC",
    [date].concat(saleFilter.params)
  );
  const grouped = {};

  purchaseRows.forEach(function mapPurchase(row) {
    const key = String(row.product_name || "").trim();
    if (!key) {
      return;
    }
    grouped[key] = {
      productName: key,
      unit: row.unit || "",
      purchasedQuantity: money(row.total_quantity),
      soldQuantity: 0,
      balanceQuantity: money(row.total_quantity)
    };
  });

  saleRows.forEach(function mapSale(row) {
    const key = String(row.product_name || "").trim();
    if (!key) {
      return;
    }
    if (!grouped[key]) {
      grouped[key] = {
        productName: key,
        unit: row.unit || "",
        purchasedQuantity: 0,
        soldQuantity: 0,
        balanceQuantity: 0
      };
    }
    grouped[key].soldQuantity = money(grouped[key].soldQuantity + money(row.total_quantity));
    grouped[key].balanceQuantity = money(grouped[key].purchasedQuantity - grouped[key].soldQuantity);
    if (!grouped[key].unit && row.unit) {
      grouped[key].unit = row.unit;
    }
  });

  return Object.keys(grouped).sort(function sortName(a, b) {
    return a.localeCompare(b, "zh-CN");
  }).map(function mapKey(key) {
    const item = grouped[key];
    return {
      productName: item.productName,
      unit: item.unit,
      purchasedQuantity: money(item.purchasedQuantity),
      soldQuantity: money(item.soldQuantity),
      balanceQuantity: money(item.balanceQuantity)
    };
  });
}

function getLedgerBundle(api, date, storeName) {
  const normalizedStoreName = storeName ? normalizeStoreName(storeName) : null;
  const ledgerRows = normalizedStoreName
    ? [ensureLedger(api, date, null, normalizedStoreName)]
    : api.all("SELECT * FROM daily_ledgers WHERE ledger_date = ? ORDER BY store_name ASC", [date]);
  const ledger = ledgerRows.length
    ? ledgerRows.reduce(function sumLedger(acc, row) {
        acc.sales_total += money(row.sales_total);
        acc.actual_received += money(row.actual_received);
        acc.cash_amount += money(row.cash_amount);
        acc.wechat_amount += money(row.wechat_amount);
        acc.alipay_amount += money(row.alipay_amount);
        acc.member_card_amount += money(row.member_card_amount);
        acc.refund_amount += money(row.refund_amount);
        acc.rounding_amount += money(row.rounding_amount);
        if (row.note) {
          acc.notes.push((row.store_name || DEFAULT_STORE_NAME) + ": " + row.note);
        }
        return acc;
      }, {
        id: null,
        ledger_date: date,
        store_name: normalizedStoreName || "All Stores",
        sales_total: 0,
        actual_received: 0,
        cash_amount: 0,
        wechat_amount: 0,
        alipay_amount: 0,
        member_card_amount: 0,
        refund_amount: 0,
        rounding_amount: 0,
        notes: []
      })
    : {
        id: null,
        ledger_date: date,
        store_name: normalizedStoreName || "å¨é¨é¨åº",
        sales_total: 0,
        actual_received: 0,
        cash_amount: 0,
        wechat_amount: 0,
        alipay_amount: 0,
        member_card_amount: 0,
        refund_amount: 0,
        rounding_amount: 0,
        notes: []
      };
  const saleFilter = buildStoreFilter("s.store_name", normalizedStoreName);
  const sales = api.all(
    "SELECT s.id, s.sale_date, s.store_name, s.product_id, p.name AS product_name, p.sale_mode, p.unit, p.price, s.quantity, s.amount, s.note, s.created_by, s.created_at, s.updated_at FROM sale_entries s JOIN products p ON p.id = s.product_id WHERE s.sale_date = ?" + saleFilter.clause + " ORDER BY s.id DESC",
    [date].concat(saleFilter.params)
  ).map(function mapSale(row) {
    return {
      id: row.id,
      date: row.sale_date,
      storeName: normalizeStoreName(row.store_name),
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

  const expenseFilter = buildStoreFilter("store_name", normalizedStoreName);
  const expenses = api.all(
    "SELECT * FROM expense_entries WHERE expense_date = ?" + expenseFilter.clause + " ORDER BY id DESC",
    [date].concat(expenseFilter.params)
  ).map(function mapExpense(row) {
    return {
      id: row.id,
      date: row.expense_date,
      storeName: normalizeStoreName(row.store_name),
      expenseType: normalizeExpenseType(row.expense_type),
      expenseLabel: expenseTypeLabel(row.expense_type),
      amount: money(row.amount),
      note: row.note,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  });
  const purchases = getPurchaseEntries(api, date, normalizedStoreName);

  const expenseTotal = expenses.reduce(function sum(total, item) {
    return total + item.amount;
  }, 0);
  const purchaseTotal = purchases.reduce(function sum(total, item) {
    return total + item.totalCost;
  }, 0);
  const profitMetrics = buildProfitMetrics(ledger.sales_total, purchaseTotal, expenseTotal);

  return {
    ledger: {
      id: ledger.id,
      date: ledger.ledger_date,
      storeName: normalizeStoreName(ledger.store_name),
      salesTotal: money(ledger.sales_total),
      actualReceived: money(ledger.actual_received),
      cashAmount: money(ledger.cash_amount),
      wechatAmount: money(ledger.wechat_amount),
      alipayAmount: money(ledger.alipay_amount),
      memberCardAmount: money(ledger.member_card_amount),
      refundAmount: money(ledger.refund_amount),
      roundingAmount: money(ledger.rounding_amount),
      note: ledger.note || (Array.isArray(ledger.notes) ? ledger.notes.join(" | ") : ""),
      expenseTotal: money(expenseTotal),
      purchaseTotal: money(purchaseTotal),
      grossProfit: profitMetrics.grossProfit,
      actualProfit: profitMetrics.actualProfit,
      profit: profitMetrics.actualProfit
    },
    sales: sales,
    expenses: expenses,
    purchases: purchases,
    inventorySummary: getInventorySummary(api, date, normalizedStoreName),
    productSummary: getProductSalesSummary(api, date, date, normalizedStoreName),
    topProducts: getTopProducts(api, date, date, 10, normalizedStoreName)
  };
}

function getDailySummary(api, date, storeName) {
  return getLedgerBundle(api, date, storeName).ledger;
}

function getRangeOverview(api, fromDate, toDate, storeName) {
  const normalizedStoreName = storeName ? normalizeStoreName(storeName) : null;
  const ledgerFilter = buildStoreFilter("store_name", normalizedStoreName);
  const ledgerRows = api.all(
    "SELECT ledger_date, ROUND(SUM(sales_total), 2) AS sales_total, ROUND(SUM(actual_received), 2) AS actual_received, ROUND(SUM(member_card_amount), 2) AS member_card_amount FROM daily_ledgers WHERE ledger_date BETWEEN ? AND ?" + ledgerFilter.clause + " GROUP BY ledger_date ORDER BY ledger_date ASC",
    [fromDate, toDate].concat(ledgerFilter.params)
  );
  const expenseFilter = buildStoreFilter("store_name", normalizedStoreName);
  const expenseRows = api.all(
    "SELECT expense_date, ROUND(SUM(amount), 2) AS total FROM expense_entries WHERE expense_date BETWEEN ? AND ?" + expenseFilter.clause + " GROUP BY expense_date",
    [fromDate, toDate].concat(expenseFilter.params)
  );
  const purchaseFilter = buildStoreFilter("store_name", normalizedStoreName);
  const purchaseRows = api.all(
    "SELECT purchase_date, ROUND(SUM(total_cost), 2) AS total FROM purchase_entries WHERE purchase_date BETWEEN ? AND ?" + purchaseFilter.clause + " GROUP BY purchase_date",
    [fromDate, toDate].concat(purchaseFilter.params)
  );
  const expenseMap = {};
  const purchaseMap = {};
  expenseRows.forEach(function buildExpenseMap(row) {
    expenseMap[row.expense_date] = money(row.total);
  });
  purchaseRows.forEach(function buildPurchaseMap(row) {
    purchaseMap[row.purchase_date] = money(row.total);
  });

  const days = ledgerRows.map(function mapDay(row) {
    const salesTotal = money(row.sales_total);
    const expenseTotal = money(expenseMap[row.ledger_date] || 0);
    const purchaseTotal = money(purchaseMap[row.ledger_date] || 0);
    const profitMetrics = buildProfitMetrics(salesTotal, purchaseTotal, expenseTotal);
    return {
      date: row.ledger_date,
      salesTotal: salesTotal,
      actualReceived: money(row.actual_received),
      memberCardAmount: money(row.member_card_amount),
      expenseTotal: expenseTotal,
      purchaseTotal: purchaseTotal,
      grossProfit: profitMetrics.grossProfit,
      actualProfit: profitMetrics.actualProfit,
      profit: profitMetrics.actualProfit
    };
  });

  const totals = days.reduce(
    function reduceTotals(acc, day) {
      acc.salesTotal += day.salesTotal;
      acc.actualReceived += day.actualReceived;
      acc.memberCardAmount += day.memberCardAmount;
      acc.expenseTotal += day.expenseTotal;
      acc.purchaseTotal += day.purchaseTotal;
      acc.grossProfit += day.grossProfit;
      acc.actualProfit += day.actualProfit;
      return acc;
    },
    { salesTotal: 0, actualReceived: 0, memberCardAmount: 0, expenseTotal: 0, purchaseTotal: 0, grossProfit: 0, actualProfit: 0 }
  );
  const salesDays = days.filter(function filterSalesDay(day) {
    return day.salesTotal > 0;
  }).length;

  return {
    fromDate: fromDate,
    toDate: toDate,
    salesDays: salesDays,
    totals: {
      salesTotal: money(totals.salesTotal),
      actualReceived: money(totals.actualReceived),
      memberCardAmount: money(totals.memberCardAmount),
      expenseTotal: money(totals.expenseTotal),
      purchaseTotal: money(totals.purchaseTotal),
      averageSales: salesDays ? money(totals.salesTotal / salesDays) : 0,
      grossProfit: money(totals.grossProfit),
      actualProfit: money(totals.actualProfit),
      profit: money(totals.actualProfit)
    },
    days: days
  };
}

function getOverviewMetrics(api, date, month, storeName) {
  const monthKey = /^\d{4}-\d{2}$/.test(String(month || "")) ? String(month) : String(date || todayText()).slice(0, 7);
  const yearKey = monthKey.slice(0, 4);
  return {
    day: getLedgerBundle(api, date, storeName).ledger,
    month: Object.assign({ key: monthKey }, getRangeOverview(api, monthKey + "-01", monthKey + "-31", storeName)),
    year: Object.assign({ key: yearKey }, getRangeOverview(api, yearKey + "-01-01", yearKey + "-12-31", storeName))
  };
}

function getMonthlySummary(api, month, storeName) {
  const fromDate = month + "-01";
  const toDate = month + "-31";
  const normalizedStoreName = storeName ? normalizeStoreName(storeName) : null;
  const ledgerFilter = buildStoreFilter("store_name", normalizedStoreName);
  const ledgerRows = api.all(
    "SELECT ledger_date, ROUND(SUM(sales_total), 2) AS sales_total, ROUND(SUM(actual_received), 2) AS actual_received, ROUND(SUM(member_card_amount), 2) AS member_card_amount FROM daily_ledgers WHERE ledger_date BETWEEN ? AND ?" + ledgerFilter.clause + " GROUP BY ledger_date ORDER BY ledger_date ASC",
    [fromDate, toDate].concat(ledgerFilter.params)
  );
  const expenseFilter = buildStoreFilter("store_name", normalizedStoreName);
  const expenseRows = api.all(
    "SELECT expense_date, ROUND(SUM(amount), 2) AS total FROM expense_entries WHERE expense_date BETWEEN ? AND ?" + expenseFilter.clause + " GROUP BY expense_date",
    [fromDate, toDate].concat(expenseFilter.params)
  );
  const purchaseFilter = buildStoreFilter("store_name", normalizedStoreName);
  const purchaseRows = api.all(
    "SELECT purchase_date, ROUND(SUM(total_cost), 2) AS total FROM purchase_entries WHERE purchase_date BETWEEN ? AND ?" + purchaseFilter.clause + " GROUP BY purchase_date",
    [fromDate, toDate].concat(purchaseFilter.params)
  );
  const expenseMap = {};
  const purchaseMap = {};
  expenseRows.forEach(function buildMap(row) {
    expenseMap[row.expense_date] = money(row.total);
  });
  purchaseRows.forEach(function buildPurchaseMap(row) {
    purchaseMap[row.purchase_date] = money(row.total);
  });

  const days = ledgerRows.map(function mapDay(row) {
    const expenseTotal = money(expenseMap[row.ledger_date] || 0);
    const purchaseTotal = money(purchaseMap[row.ledger_date] || 0);
    const salesTotal = money(row.sales_total);
    const profitMetrics = buildProfitMetrics(salesTotal, purchaseTotal, expenseTotal);
    return {
      date: row.ledger_date,
      storeName: normalizedStoreName || "All Stores",
      salesTotal: salesTotal,
      actualReceived: money(row.actual_received),
      memberCardAmount: money(row.member_card_amount),
      expenseTotal: expenseTotal,
      purchaseTotal: purchaseTotal,
      grossProfit: profitMetrics.grossProfit,
      actualProfit: profitMetrics.actualProfit,
      profit: profitMetrics.actualProfit
    };
  });

  const totals = days.reduce(
    function reduceTotal(acc, day) {
      acc.salesTotal += day.salesTotal;
      acc.actualReceived += day.actualReceived;
      acc.memberCardAmount += day.memberCardAmount;
      acc.expenseTotal += day.expenseTotal;
      acc.purchaseTotal += day.purchaseTotal;
      acc.grossProfit += day.grossProfit;
      acc.actualProfit += day.actualProfit;
      return acc;
    },
    { salesTotal: 0, actualReceived: 0, memberCardAmount: 0, expenseTotal: 0, purchaseTotal: 0, grossProfit: 0, actualProfit: 0 }
  );
  const monthlyPurchases = getMonthlyPurchaseEntries(api, month, normalizedStoreName);
  const purchaseSummary = getMonthlyPurchaseSummary(api, month, normalizedStoreName);
  const purchaseProductSummary = getMonthlyPurchaseProductSummary(api, month, normalizedStoreName);
  const purchaseDailySummary = getMonthlyPurchaseDailySummary(api, month, normalizedStoreName);

  return {
    month: month,
    totals: {
      salesTotal: money(totals.salesTotal),
      actualReceived: money(totals.actualReceived),
      memberCardAmount: money(totals.memberCardAmount),
      expenseTotal: money(totals.expenseTotal),
      purchaseTotal: money(totals.purchaseTotal),
      grossProfit: money(totals.grossProfit),
      actualProfit: money(totals.actualProfit),
      profit: money(totals.actualProfit)
    },
    days: days,
    purchases: monthlyPurchases,
    purchaseSummary: purchaseSummary,
    purchaseProductSummary: purchaseProductSummary,
    purchaseDailySummary: purchaseDailySummary,
    storeSalesSummary: normalizedStoreName ? [] : getMonthlyStoreSalesSummary(api, month),
    productSummary: getProductSalesSummary(api, fromDate, toDate, normalizedStoreName),
    topProducts: getTopProducts(api, fromDate, toDate, 10, normalizedStoreName)
  };
}

function getMonthlySaleEntries(api, month, storeName) {
  const fromDate = month + "-01";
  const toDate = month + "-31";
  const filter = buildStoreFilter("s.store_name", storeName ? normalizeStoreName(storeName) : null);
  const rows = api.all(
    "SELECT s.id, s.sale_date, s.store_name, p.name AS product_name, p.sale_mode, p.unit, p.price, s.quantity, s.amount, s.note, s.created_by, s.created_at, s.updated_at FROM sale_entries s JOIN products p ON p.id = s.product_id WHERE s.sale_date BETWEEN ? AND ?" + filter.clause + " ORDER BY s.sale_date ASC, s.id ASC",
    [fromDate, toDate].concat(filter.params)
  );
  return rows.map(function mapRow(row) {
    return {
      id: row.id,
      date: row.sale_date,
      storeName: normalizeStoreName(row.store_name),
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

function getMonthlyExpenseEntries(api, month, storeName) {
  const fromDate = month + "-01";
  const toDate = month + "-31";
  const filter = buildStoreFilter("store_name", storeName ? normalizeStoreName(storeName) : null);
  const rows = api.all(
    "SELECT * FROM expense_entries WHERE expense_date BETWEEN ? AND ?" + filter.clause + " ORDER BY expense_date ASC, id ASC",
    [fromDate, toDate].concat(filter.params)
  );
  return rows.map(function mapRow(row) {
    return {
      id: row.id,
      date: row.expense_date,
      storeName: normalizeStoreName(row.store_name),
      expenseType: normalizeExpenseType(row.expense_type),
      expenseLabel: expenseTypeLabel(row.expense_type),
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
  const storeName = options.storeName ? normalizeStoreName(options.storeName) : null;
  const dailyStart = shiftDateText(endDate, -(dailyRange - 1));
  const previousDailyStart = shiftDateText(dailyStart, -dailyRange);
  const previousDailyEnd = shiftDateText(dailyStart, -1);
  const ledgerFilter = buildStoreFilter("store_name", storeName);

  const dailyRows = api.all(
    "SELECT ledger_date, ROUND(SUM(" + metric + "), 2) AS total FROM daily_ledgers WHERE ledger_date BETWEEN ? AND ?" + ledgerFilter.clause + " GROUP BY ledger_date ORDER BY ledger_date ASC",
    [previousDailyStart, endDate].concat(ledgerFilter.params)
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
    "SELECT substr(ledger_date, 1, 7) AS month_key, ROUND(SUM(" + metric + "), 2) AS total FROM daily_ledgers WHERE ledger_date BETWEEN ? AND ?" + ledgerFilter.clause + " GROUP BY substr(ledger_date, 1, 7) ORDER BY month_key ASC",
    [monthStart + "-01", monthEnd + "-31"].concat(ledgerFilter.params)
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

function createApp(api) {
  const app = express();
  ensureDir(UPLOAD_DIR);
  ensureDir(TESSDATA_DIR);
  const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 10 * 1024 * 1024 }
  });
  app.use(express.json({ limit: "1mb" }));
  app.use("/tessdata", express.static(TESSDATA_DIR));
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
      return res.status(401).json({ error: "Incorrect username or password." });
    }
    const user = sanitizeUser(api.one("SELECT * FROM users WHERE id = ?", [userId]));
    if (!user || user.status !== "active") {
      return res.status(401).json({ error: "Account is unavailable." });
    }
    req.user = user;
    next();
  });

  app.post("/api/auth/login", function login(req, res) {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const user = api.one("SELECT * FROM users WHERE username = ?", [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Incorrect username or password." });
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
      return res.status(403).json({ error: "Only the owner can view the account list." });
    }
    const users = api.all("SELECT id, username, name, store_name, role, status, created_at FROM users ORDER BY role ASC, store_name ASC, id ASC");
    res.json({
      items: users.map(sanitizeUser),
      stores: getAvailableStores(api)
    });
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
    const storeName = normalizeStoreName(body.storeName);

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
          "UPDATE users SET name = ?, username = ?, password_hash = ?, store_name = ?, status = ? WHERE id = ?",
          [name, username, bcrypt.hashSync(password, 10), storeName, status, id]
        );
      } else {
        api.run(
          "UPDATE users SET name = ?, username = ?, store_name = ?, status = ? WHERE id = ?",
          [name, username, storeName, status, id]
        );
      }
      return res.json({ success: true });
    }

    if (!password) {
      return res.status(400).json({ error: "A password is required when creating staff." });
    }

    api.run(
      "INSERT INTO users (username, password_hash, name, store_name, role, status, created_at) VALUES (?, ?, ?, ?, 'staff', ?, ?)",
      [username, bcrypt.hashSync(password, 10), name, storeName, status, now]
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
          keywords: row.keywords || "",
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
      return res.status(403).json({ error: "åªæåºä¸»å¯ä»¥ç®¡çåå" });
    }
    const body = req.body || {};
    const now = new Date().toISOString();
    const id = body.id ? intValue(body.id, null) : null;
    const payload = {
      name: String(body.name || "").trim(),
      keywords: String(body.keywords || "").trim(),
      saleMode: body.saleMode === "weight" ? "weight" : "piece",
      unit: String(body.unit || "").trim() || "piece",
      price: money(body.price),
      isActive: body.isActive === false ? 0 : 1,
      sortOrder: intValue(body.sortOrder, 0)
    };

    if (!payload.name) {
      return res.status(400).json({ error: "åååç§°ä¸è½ä¸ºç©º" });
    }

    if (id) {
      api.run(
        "UPDATE products SET name = ?, keywords = ?, sale_mode = ?, unit = ?, price = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?",
        [payload.name, payload.keywords, payload.saleMode, payload.unit, payload.price, payload.isActive, payload.sortOrder, now, id]
      );
    } else {
      api.run(
        "INSERT INTO products (name, keywords, sale_mode, unit, price, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [payload.name, payload.keywords, payload.saleMode, payload.unit, payload.price, payload.isActive, payload.sortOrder, now, now]
      );
    }

    res.json({ success: true });
  });

  app.get("/api/purchase-products", function listPurchaseProducts(req, res) {
    const includeInactive = req.user.role === "owner" && req.query.includeInactive === "true";
    res.json({ items: getPurchaseProducts(api, includeInactive) });
  });

  app.post("/api/purchase-products", function createPurchaseProduct(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const payload = normalizePurchaseProductPayload(req.body);
    if (!payload.name) {
      return res.status(400).json({ error: "Purchase product name is required." });
    }
    const now = new Date().toISOString();
    const existing = api.one("SELECT id, created_at FROM purchase_products WHERE name = ?", [payload.name]);
    if (existing) {
      api.run(
        "UPDATE purchase_products SET keywords = ?, default_unit = ?, last_unit_cost = ?, last_supplier = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?",
        [payload.keywords, payload.defaultUnit, payload.lastUnitCost, payload.lastSupplier, payload.isActive, payload.sortOrder, now, existing.id]
      );
      return res.json({ success: true, id: existing.id, mode: "updated" });
    }
    api.run(
      "INSERT INTO purchase_products (name, keywords, default_unit, last_unit_cost, last_supplier, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [payload.name, payload.keywords, payload.defaultUnit, payload.lastUnitCost, payload.lastSupplier, payload.isActive, payload.sortOrder, now, now]
    );
    res.json({ success: true, mode: "created" });
  });

  app.put("/api/purchase-products/:id", function updatePurchaseProduct(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const purchaseProductId = intValue(req.params.id, 0);
    const existing = api.one("SELECT * FROM purchase_products WHERE id = ?", [purchaseProductId]);
    if (!existing) {
      return res.status(404).json({ error: "Purchase product not found." });
    }
    const payload = normalizePurchaseProductPayload(req.body);
    if (!payload.name) {
      return res.status(400).json({ error: "Purchase product name is required." });
    }
    const duplicated = api.one("SELECT id FROM purchase_products WHERE name = ? AND id <> ?", [payload.name, purchaseProductId]);
    if (duplicated) {
      return res.status(409).json({ error: "A purchase product with this name already exists." });
    }
    const now = new Date().toISOString();
    api.run(
      "UPDATE purchase_products SET name = ?, keywords = ?, default_unit = ?, last_unit_cost = ?, last_supplier = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?",
      [payload.name, payload.keywords, payload.defaultUnit, payload.lastUnitCost, payload.lastSupplier, payload.isActive, payload.sortOrder, now, purchaseProductId]
    );
    res.json({ success: true });
  });

  app.delete("/api/purchase-products/:id", function deletePurchaseProduct(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const purchaseProductId = intValue(req.params.id, 0);
    const existing = api.one("SELECT * FROM purchase_products WHERE id = ?", [purchaseProductId]);
    if (!existing) {
      return res.status(404).json({ error: "Purchase product not found." });
    }
    api.run("DELETE FROM purchase_products WHERE id = ?", [purchaseProductId]);
    res.json({ success: true });
  });

  app.get("/api/ledger/:date", function getLedger(req, res) {
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    const bundle = getLedgerBundle(api, req.params.date, storeName);
    if (req.user.role !== "owner") {
      bundle.ledger = ownerOnlyLedger(bundle.ledger, false);
      bundle.topProducts = [];
    } else {
      bundle.overviewMetrics = getOverviewMetrics(
        api,
        req.params.date,
        String(req.query.month || req.params.date.slice(0, 7)),
        storeName
      );
    }
    res.json(bundle);
  });

  app.put("/api/ledger/:date", function saveLedger(req, res) {
    const date = req.params.date;
    const storeName = resolveRequestedStoreName(req, req.body && req.body.storeName, false);
    const current = ensureLedger(api, date, req.user.id, storeName);
    const now = new Date().toISOString();
    const body = req.body || {};
    const refundAmount = money(body.refundAmount);
    const roundingAmount = money(body.roundingAmount);
    let salesTotal = money(body.salesTotal);
    let actualReceived = money(body.actualReceived);
    if (refundAmount === 0 && roundingAmount === 0) {
      if (!String(body.salesTotal || "").trim() && String(body.actualReceived || "").trim()) {
        salesTotal = actualReceived;
      } else if (!String(body.actualReceived || "").trim() && String(body.salesTotal || "").trim()) {
        actualReceived = salesTotal;
      }
    }
    api.run(
      "UPDATE daily_ledgers SET sales_total = ?, actual_received = ?, cash_amount = ?, wechat_amount = ?, alipay_amount = ?, member_card_amount = ?, refund_amount = ?, rounding_amount = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?",
      [
        salesTotal,
        actualReceived,
        money(body.cashAmount),
        money(body.wechatAmount),
        money(body.alipayAmount),
        money(body.memberCardAmount),
        refundAmount,
        roundingAmount,
        String(body.note || ""),
        req.user.id,
        now,
        current.id
      ]
    );
    const nextLedger = getLedgerBundle(api, date, storeName).ledger;
    res.json({ success: true, ledger: ownerOnlyLedger(nextLedger, req.user.role === "owner") });
  });

  app.post("/api/sales", function createSale(req, res) {
    const body = req.body || {};
    const productId = intValue(body.productId, 0);
    const product = api.one("SELECT * FROM products WHERE id = ?", [productId]);
    if (!product) {
      return res.status(400).json({ error: "Product not found." });
    }
    const now = new Date().toISOString();
    const quantity = money(body.quantity);
    const amount = money(body.amount || quantity * Number(product.price));
    const storeName = resolveRequestedStoreName(req, body.storeName, false);
    api.run(
      "INSERT INTO sale_entries (sale_date, store_name, product_id, quantity, amount, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [body.date, storeName, productId, quantity, amount, String(body.note || ""), req.user.id, now, now]
    );
    res.json({ success: true });
  });

  app.post("/api/receipt/scan", upload.single("receiptImage"), async function scanReceipt(req, res) {
    if (!req.file) {
      return res.status(400).json({ error: "Please upload a receipt image first." });
    }
    try {
      const receiptResult = await scanReceiptImage(api, req.file.path);
      res.json(receiptResult);
    } catch (error) {
      res.status(500).json({ error: "Receipt OCR failed. Please try a clearer image." });
    } finally {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    }
  });

  app.post("/api/receipt/import", function importReceipt(req, res) {
    const date = String((req.body || {}).date || "").trim();
    const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
    const storeName = resolveRequestedStoreName(req, req.body && req.body.storeName, false);
    if (!date) {
      return res.status(400).json({ error: "Please choose an import date first." });
    }
    if (!items.length) {
      return res.status(400).json({ error: "There are no recognized receipt items to import." });
    }

    const now = new Date().toISOString();
    let importedCount = 0;
    items.forEach(function importItem(item) {
      const productId = intValue(item.productId, 0);
      const product = api.one("SELECT * FROM products WHERE id = ?", [productId]);
      if (!product) {
        return;
      }
      const quantity = money(item.quantity);
      if (!quantity) {
        return;
      }
      const amount = item.amount === null || item.amount === undefined || item.amount === ""
        ? money(quantity * Number(product.price))
        : money(item.amount);
      const sourceLine = String(item.sourceLine || "").trim();
      const note = sourceLine ? "Receipt OCR: " + sourceLine : "Receipt OCR import";
      api.run(
        "INSERT INTO sale_entries (sale_date, store_name, product_id, quantity, amount, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [date, storeName, productId, quantity, amount, note, req.user.id, now, now]
      );
      importedCount += 1;
    });

    res.json({ success: true, importedCount: importedCount });
  });

  app.put("/api/sales/:id", function updateSale(req, res) {
    const body = req.body || {};
    const existing = ensureWritableRecord(req, res, api.one("SELECT * FROM sale_entries WHERE id = ?", [intValue(req.params.id, 0)]), "Sale record not found.");
    if (!existing) {
      return;
    }
    const now = new Date().toISOString();
    api.run(
      "UPDATE sale_entries SET quantity = ?, amount = ?, note = ?, updated_at = ? WHERE id = ?",
      [money(body.quantity), money(body.amount), String(body.note || ""), now, intValue(req.params.id, 0)]
    );
    res.json({ success: true });
  });

  app.delete("/api/sales/:id", function deleteSale(req, res) {
    const existing = ensureWritableRecord(req, res, api.one("SELECT * FROM sale_entries WHERE id = ?", [intValue(req.params.id, 0)]), "Sale record not found.");
    if (!existing) {
      return;
    }
    api.run("DELETE FROM sale_entries WHERE id = ?", [intValue(req.params.id, 0)]);
    res.json({ success: true });
  });

  app.get("/api/expenses/:date", function listExpenses(req, res) {
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    const filter = buildStoreFilter("store_name", storeName);
    const rows = api.all(
      "SELECT * FROM expense_entries WHERE expense_date = ?" + filter.clause + " ORDER BY id DESC",
      [req.params.date].concat(filter.params)
    );
    res.json({ items: rows.map(function mapExpense(row) {
      return {
        id: row.id,
        date: row.expense_date,
        storeName: normalizeStoreName(row.store_name),
        expenseType: normalizeExpenseType(row.expense_type),
        expenseLabel: expenseTypeLabel(row.expense_type),
        amount: money(row.amount),
        note: row.note,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    }) });
  });

  app.post("/api/expenses", function createExpense(req, res) {
    const body = req.body || {};
    const now = new Date().toISOString();
    const storeName = resolveRequestedStoreName(req, body.storeName, false);
    api.run(
      "INSERT INTO expense_entries (expense_date, store_name, expense_type, amount, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [body.date, storeName, normalizeExpenseType(body.expenseType), money(body.amount), String(body.note || ""), req.user.id, now, now]
    );
    res.json({ success: true });
  });

  app.put("/api/expenses/:id", function updateExpense(req, res) {
    const body = req.body || {};
    const existing = ensureWritableRecord(req, res, api.one("SELECT * FROM expense_entries WHERE id = ?", [intValue(req.params.id, 0)]), "Expense record not found.");
    if (!existing) {
      return;
    }
    const now = new Date().toISOString();
    api.run(
      "UPDATE expense_entries SET expense_type = ?, amount = ?, note = ?, updated_at = ? WHERE id = ?",
      [normalizeExpenseType(body.expenseType), money(body.amount), String(body.note || ""), now, intValue(req.params.id, 0)]
    );
    res.json({ success: true });
  });

  app.delete("/api/expenses/:id", function deleteExpense(req, res) {
    const existing = ensureWritableRecord(req, res, api.one("SELECT * FROM expense_entries WHERE id = ?", [intValue(req.params.id, 0)]), "Expense record not found.");
    if (!existing) {
      return;
    }
    api.run("DELETE FROM expense_entries WHERE id = ?", [intValue(req.params.id, 0)]);
    res.json({ success: true });
  });

  app.get("/api/purchases/:date", function listPurchases(req, res) {
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    res.json({ items: getPurchaseEntries(api, req.params.date, storeName) });
  });

  app.post("/api/purchases", function createPurchase(req, res) {
    const body = req.body || {};
    const date = String(body.date || "").trim();
    const items = Array.isArray(body.items) && body.items.length
      ? body.items.map(normalizePurchaseItemPayload).filter(function filterItem(item) {
          return item.productName && item.quantity > 0;
        })
      : [normalizePurchaseItemPayload(body)].filter(function filterItem(item) {
          return item.productName && item.quantity > 0;
        });
    if (!date || !items.length) {
      return res.status(400).json({ error: "Purchase date and at least one purchase item are required." });
    }
    const now = new Date().toISOString();
    const storeName = resolveRequestedStoreName(req, body.storeName, false);
    const purchaseOrderNo = String(body.purchaseOrderNo || "").trim() || createPurchaseOrderNo(date, storeName);
    items.forEach(function saveItem(item) {
      api.run(
        "INSERT INTO purchase_entries (purchase_date, store_name, purchase_order_no, product_name, quantity, unit, unit_cost, total_cost, supplier, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [date, storeName, purchaseOrderNo, item.productName, item.quantity, item.unit, item.unitCost, item.totalCost, String(body.supplier || ""), String(body.note || ""), req.user.id, now, now]
      );
      rebuildPurchaseProductByName(api, item.productName);
    });
    res.json({ success: true, purchaseOrderNo: purchaseOrderNo, createdCount: items.length });
  });

  app.put("/api/purchases/:id", function updatePurchase(req, res) {
    const body = req.body || {};
    const purchaseId = intValue(req.params.id, 0);
    const existing = ensureWritableRecord(req, res, api.one("SELECT * FROM purchase_entries WHERE id = ?", [purchaseId]), "Purchase record not found.");
    if (!existing) {
      return;
    }
    const item = normalizePurchaseItemPayload(body);
    if (!item.productName) {
      return res.status(400).json({ error: "Product name is required." });
    }
    const now = new Date().toISOString();
    api.run(
      "UPDATE purchase_entries SET purchase_order_no = ?, product_name = ?, quantity = ?, unit = ?, unit_cost = ?, total_cost = ?, supplier = ?, note = ?, updated_at = ? WHERE id = ?",
      [String(body.purchaseOrderNo || existing.purchase_order_no || "").trim(), item.productName, item.quantity, item.unit, item.unitCost, item.totalCost, String(body.supplier || ""), String(body.note || ""), now, purchaseId]
    );
    rebuildPurchaseProductByName(api, existing.product_name);
    rebuildPurchaseProductByName(api, item.productName);
    res.json({ success: true });
  });

  app.delete("/api/purchases/:id", function deletePurchase(req, res) {
    const purchaseId = intValue(req.params.id, 0);
    const existing = ensureWritableRecord(req, res, api.one("SELECT * FROM purchase_entries WHERE id = ?", [purchaseId]), "Purchase record not found.");
    if (!existing) {
      return;
    }
    api.run("DELETE FROM purchase_entries WHERE id = ?", [purchaseId]);
    rebuildPurchaseProductByName(api, existing.product_name);
    res.json({ success: true });
  });

  app.get("/api/reports/daily", function reportDaily(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const date = String(req.query.date || todayText());
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    res.json({
      date: date,
      storeName: storeName,
      summary: getDailySummary(api, date, storeName),
      topProducts: getTopProducts(api, date, date, 10, storeName)
    });
  });

  app.get("/api/reports/monthly", function reportMonthly(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const month = String(req.query.month || monthText());
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    res.json(getMonthlySummary(api, month, storeName));
  });

  app.get("/api/overview-range", function overviewRange(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const fromDate = String(req.query.fromDate || "").trim();
    const toDate = String(req.query.toDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      return res.status(400).json({ error: "Valid fromDate and toDate are required." });
    }
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    res.json(getRangeOverview(api, fromDate, toDate, storeName));
  });

  app.get("/api/analytics", function analytics(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    res.json(
      getAnalyticsOverview(api, {
        metric: String(req.query.metric || "salesTotal"),
        dailyRange: intValue(req.query.dailyRange, 30),
        endDate: String(req.query.endDate || todayText()),
        monthEnd: String(req.query.monthEnd || monthText()),
        storeName: storeName
      })
    );
  });

  app.get("/api/export/daily", function exportDaily(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const date = String(req.query.date || todayText());
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    const workbook = createWorkbookForDaily(api, date, storeName);
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent("\u65e5\u62a5-" + date + ".xlsx") + '"');
    res.send(Buffer.from(buffer));
  });

  app.get("/api/export/monthly", function exportMonthly(req, res) {
    if (!requireOwner(req, res)) {
      return;
    }
    const month = String(req.query.month || monthText());
    const storeName = resolveRequestedStoreName(req, req.query.storeName, true);
    const workbook = createWorkbookForMonthly(api, month, storeName);
    const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent("\u6708\u62a5-" + month + ".xlsx") + '"');
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

function createWorkbookForDaily(api, date, storeName) {
  const bundle = getLedgerBundle(api, date, storeName);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet([bundle.ledger], {
      date: "\u65e5\u671f",
      storeName: "\u95e8\u5e97",
      salesTotal: "\u9500\u552e\u603b\u989d",
      actualReceived: "\u5b9e\u9645\u6536\u6b3e",
      cashAmount: "\u73b0\u91d1",
      wechatAmount: "\u5fae\u4fe1",
      alipayAmount: "\u652f\u4ed8\u5b9d",
      memberCardAmount: "\u4f1a\u5458\u5361\u6536\u5165",
      refundAmount: "\u9000\u6b3e",
      roundingAmount: "\u62b9\u96f6",
      note: "\u5907\u6ce8",
      expenseTotal: "\u652f\u51fa\u5408\u8ba1",
      purchaseTotal: "\u8fdb\u8d27\u5408\u8ba1"
    }),
    "\u65e5\u62a5\u6c47\u603b"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(bundle.productSummary, {
      name: "\u5546\u54c1\u540d\u79f0",
      unit: "\u5355\u4f4d",
      saleMode: "\u9500\u552e\u65b9\u5f0f",
      totalQuantity: "\u7d2f\u8ba1\u9500\u91cf",
      totalAmount: "\u7d2f\u8ba1\u9500\u552e\u989d"
    }),
    "\u5546\u54c1\u6c47\u603b"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(bundle.sales, {
      date: "\u65e5\u671f",
      storeName: "\u95e8\u5e97",
      productName: "\u5546\u54c1\u540d\u79f0",
      saleMode: "\u9500\u552e\u65b9\u5f0f",
      unit: "\u5355\u4f4d",
      price: "\u9ed8\u8ba4\u5355\u4ef7",
      quantity: "\u6570\u91cf/\u91cd\u91cf",
      amount: "\u6210\u4ea4\u91d1\u989d",
      note: "\u5907\u6ce8",
      createdAt: "\u521b\u5efa\u65f6\u95f4",
      updatedAt: "\u66f4\u65b0\u65f6\u95f4"
    }),
    "\u9500\u552e\u660e\u7ec6"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(bundle.expenses, {
      date: "\u65e5\u671f",
      storeName: "\u95e8\u5e97",
      expenseType: "\u652f\u51fa\u7c7b\u578b",
      expenseLabel: "\u652f\u51fa\u7c7b\u522b",
      amount: "\u91d1\u989d",
      note: "\u5907\u6ce8",
      createdAt: "\u521b\u5efa\u65f6\u95f4",
      updatedAt: "\u66f4\u65b0\u65f6\u95f4"
    }),
    "\u652f\u51fa\u660e\u7ec6"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(bundle.purchases, {
      date: "\u65e5\u671f",
      storeName: "\u95e8\u5e97",
      purchaseOrderNo: "\u8fdb\u8d27\u5355\u53f7",
      productName: "\u8fdb\u8d27\u5546\u54c1",
      quantity: "\u6570\u91cf",
      unit: "\u5355\u4f4d",
      unitCost: "\u8fdb\u8d27\u5355\u4ef7",
      totalCost: "\u8fdb\u8d27\u603b\u989d",
      supplier: "\u4f9b\u5e94\u5546",
      note: "\u5907\u6ce8",
      createdAt: "\u521b\u5efa\u65f6\u95f4",
      updatedAt: "\u66f4\u65b0\u65f6\u95f4"
    }),
    "\u8fdb\u8d27\u660e\u7ec6"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(bundle.topProducts, {
      name: "\u5546\u54c1\u540d\u79f0",
      unit: "\u5355\u4f4d",
      saleMode: "\u9500\u552e\u65b9\u5f0f",
      totalQuantity: "\u7d2f\u8ba1\u9500\u91cf",
      totalAmount: "\u7d2f\u8ba1\u9500\u552e\u989d"
    }),
    "\u70ed\u9500\u6392\u884c"
  );
  return workbook;
}

function createWorkbookForMonthly(api, month, storeName) {
  const summary = getMonthlySummary(api, month, storeName);
  const sales = getMonthlySaleEntries(api, month, storeName);
  const expenses = getMonthlyExpenseEntries(api, month, storeName);
  const purchases = getMonthlyPurchaseEntries(api, month, storeName);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet([summary.totals], {
      salesTotal: "\u6708\u9500\u552e\u603b\u989d",
      actualReceived: "\u6708\u5b9e\u9645\u6536\u6b3e",
      memberCardAmount: "\u6708\u4f1a\u5458\u5361\u6536\u5165",
      expenseTotal: "\u6708\u652f\u51fa\u5408\u8ba1",
      purchaseTotal: "\u6708\u8fdb\u8d27\u5408\u8ba1",
      grossProfit: "\u6708\u6bdb\u5229\u6da6",
      actualProfit: "\u6708\u5b9e\u9645\u5229\u6da6"
    }),
    "\u6708\u5ea6\u6c47\u603b"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(summary.days, {
      date: "\u65e5\u671f",
      storeName: "\u95e8\u5e97",
      salesTotal: "\u9500\u552e\u603b\u989d",
      actualReceived: "\u5b9e\u9645\u6536\u6b3e",
      memberCardAmount: "\u4f1a\u5458\u5361\u6536\u5165",
      expenseTotal: "\u652f\u51fa\u5408\u8ba1",
      purchaseTotal: "\u8fdb\u8d27\u5408\u8ba1",
      grossProfit: "\u6bdb\u5229\u6da6",
      actualProfit: "\u5b9e\u9645\u5229\u6da6"
    }),
    "\u6bcf\u65e5\u9500\u552e\u989d"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(summary.productSummary, {
      name: "\u5546\u54c1\u540d\u79f0",
      unit: "\u5355\u4f4d",
      saleMode: "\u9500\u552e\u65b9\u5f0f",
      totalQuantity: "\u7d2f\u8ba1\u9500\u91cf",
      totalAmount: "\u7d2f\u8ba1\u9500\u552e\u989d"
    }),
    "\u5546\u54c1\u6c47\u603b"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(sales, {
      date: "\u65e5\u671f",
      storeName: "\u95e8\u5e97",
      productName: "\u5546\u54c1\u540d\u79f0",
      saleMode: "\u9500\u552e\u65b9\u5f0f",
      unit: "\u5355\u4f4d",
      price: "\u9ed8\u8ba4\u5355\u4ef7",
      quantity: "\u6570\u91cf/\u91cd\u91cf",
      amount: "\u6210\u4ea4\u91d1\u989d",
      note: "\u5907\u6ce8",
      createdAt: "\u521b\u5efa\u65f6\u95f4",
      updatedAt: "\u66f4\u65b0\u65f6\u95f4"
    }),
    "\u9500\u552e\u660e\u7ec6"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(expenses, {
      date: "\u65e5\u671f",
      storeName: "\u95e8\u5e97",
      expenseType: "\u652f\u51fa\u7c7b\u578b",
      expenseLabel: "\u652f\u51fa\u7c7b\u522b",
      amount: "\u91d1\u989d",
      note: "\u5907\u6ce8",
      createdAt: "\u521b\u5efa\u65f6\u95f4",
      updatedAt: "\u66f4\u65b0\u65f6\u95f4"
    }),
    "\u652f\u51fa\u660e\u7ec6"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(purchases, {
      date: "\u65e5\u671f",
      storeName: "\u95e8\u5e97",
      purchaseOrderNo: "\u8fdb\u8d27\u5355\u53f7",
      productName: "\u8fdb\u8d27\u5546\u54c1",
      quantity: "\u6570\u91cf",
      unit: "\u5355\u4f4d",
      unitCost: "\u8fdb\u8d27\u5355\u4ef7",
      totalCost: "\u8fdb\u8d27\u603b\u989d",
      supplier: "\u4f9b\u5e94\u5546",
      note: "\u5907\u6ce8",
      createdAt: "\u521b\u5efa\u65f6\u95f4",
      updatedAt: "\u66f4\u65b0\u65f6\u95f4"
    }),
    "\u8fdb\u8d27\u660e\u7ec6"
  );
  XLSX.utils.book_append_sheet(
      workbook,
      makeExportSheet([summary.purchaseSummary], {
        totalCost: "\u672c\u6708\u8fdb\u8d27\u603b\u989d",
        orderCount: "\u672c\u6708\u8fdb\u8d27\u5355\u6570",
        entryCount: "\u672c\u6708\u8fdb\u8d27\u7b14\u6570",
        productCount: "\u672c\u6708\u8fdb\u8d27\u5546\u54c1\u79cd\u6570"
      }),
    "\u8fdb\u8d27\u6c47\u603b"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(summary.purchaseProductSummary, {
      productName: "\u8fdb\u8d27\u5546\u54c1",
      totalQuantity: "\u6708\u7d2f\u8ba1\u6570\u91cf",
      unit: "\u5355\u4f4d",
      totalCost: "\u6708\u7d2f\u8ba1\u8fdb\u8d27\u989d",
      entryCount: "\u8fdb\u8d27\u7b14\u6570",
      averageCost: "\u5355\u7b14\u5e73\u5747\u989d",
      lastUnitCost: "\u6700\u8fd1\u8fdb\u4ef7",
      supplierSummary: "\u4f9b\u5e94\u5546",
      lastPurchaseDate: "\u6700\u8fd1\u8fdb\u8d27\u65e5\u671f",
      lastStoreName: "\u6700\u8fd1\u8fdb\u8d27\u95e8\u5e97"
    }),
    "\u8fdb\u8d27\u5546\u54c1\u6708\u6c47\u603b"
  );
  XLSX.utils.book_append_sheet(
    workbook,
      makeExportSheet(summary.purchaseDailySummary, {
        date: "\u65e5\u671f",
        storeName: "\u95e8\u5e97",
        orderCount: "\u8fdb\u8d27\u5355\u6570",
        productCount: "\u5546\u54c1\u79cd\u6570",
        entryCount: "\u8fdb\u8d27\u7b14\u6570",
        totalQuantity: "\u5f53\u65e5\u7d2f\u8ba1\u6570\u91cf",
      totalCost: "\u5f53\u65e5\u8fdb\u8d27\u603b\u989d"
    }),
    "\u6bcf\u65e5\u8fdb\u8d27\u60c5\u51b5"
  );
  if (summary.storeSalesSummary && summary.storeSalesSummary.length) {
    XLSX.utils.book_append_sheet(
      workbook,
      makeExportSheet(summary.storeSalesSummary, {
        storeName: "\u95e8\u5e97",
        salesTotal: "\u9500\u552e\u603b\u989d",
        actualReceived: "\u5b9e\u9645\u6536\u6b3e",
        memberCardAmount: "\u4f1a\u5458\u5361\u6536\u5165",
        purchaseTotal: "\u8fdb\u8d27\u603b\u989d",
        expenseTotal: "\u652f\u51fa\u603b\u989d",
        grossProfit: "\u6bdb\u5229\u6da6",
        actualProfit: "\u5b9e\u9645\u5229\u6da6"
      }),
      "\u95e8\u5e97\u7ecf\u8425\u6c47\u603b"
    );
  }
  XLSX.utils.book_append_sheet(
    workbook,
    makeExportSheet(summary.topProducts, {
      name: "\u5546\u54c1\u540d\u79f0",
      unit: "\u5355\u4f4d",
      saleMode: "\u9500\u552e\u65b9\u5f0f",
      totalQuantity: "\u7d2f\u8ba1\u9500\u91cf",
      totalAmount: "\u7d2f\u8ba1\u9500\u552e\u989d"
    }),
    "\u70ed\u9500\u6392\u884c"
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
    console.log(STORE_NAME + " 已启动: http://localhost:" + info.server.address().port);
    console.log("店主账号: owner / admin123");
    console.log("门店1账号: store1 / 123456");
    console.log("门店2账号: store2 / 123456");
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
