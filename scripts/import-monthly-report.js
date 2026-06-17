const fs = require("fs");
const XLSX = require("xlsx");
const initSqlJs = require("sql.js/dist/sql-asm.js");

const DEFAULT_STORE_NAME = "于福记熟食店";
const IMPORT_NOTE_PREFIX = "[月报导入]";

function fail(message) {
  throw new Error(message);
}

function money(value) {
  const text = String(value == null ? "" : value).replace(/,/g, "").trim();
  const num = Number(text || 0);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function normalizeDate(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) {
    return "";
  }
  const matched = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (matched) {
    return text;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString().slice(0, 10);
}

function loadDailyRows(workbook) {
  const sheetName = workbook.SheetNames.find(function findName(name) {
    return String(name || "").trim() === "每日销售额";
  }) || workbook.SheetNames[1];
  if (!sheetName || !workbook.Sheets[sheetName]) {
    fail("没有找到“每日销售额”工作表。");
  }

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: "",
    raw: false,
    dateNF: "yyyy-mm-dd"
  });

  if (!rows.length) {
    fail("“每日销售额”工作表是空的。");
  }

  const parsedRows = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const date = normalizeDate(row[0]);
    const storeName = String(row[1] || "").trim() || DEFAULT_STORE_NAME;
    if (!date) {
      continue;
    }
    parsedRows.push({
      date: date,
      month: date.slice(0, 7),
      storeName: storeName,
      salesTotal: money(row[2]),
      actualReceived: money(row[3]),
      expenseTotal: money(row[4])
    });
  }

  if (!parsedRows.length) {
    fail("月报里没有可导入的日期行。");
  }

  return parsedRows;
}

function collectImportScopes(rows) {
  const scopeMap = new Map();
  rows.forEach(function registerRow(row) {
    const key = row.month + "::" + row.storeName;
    if (!scopeMap.has(key)) {
      scopeMap.set(key, { month: row.month, storeName: row.storeName });
    }
  });
  return Array.from(scopeMap.values());
}

async function main() {
  const reportPath = process.argv[2];
  const dbPath = process.argv[3];
  if (!reportPath) {
    fail("缺少月报文件路径。");
  }
  if (!dbPath) {
    fail("缺少数据库路径。");
  }
  if (!fs.existsSync(reportPath)) {
    fail("找不到月报文件：" + reportPath);
  }
  if (!fs.existsSync(dbPath)) {
    fail("找不到数据库文件：" + dbPath);
  }

  const workbook = XLSX.readFile(reportPath, { cellDates: true });
  const rows = loadDailyRows(workbook);
  const scopes = collectImportScopes(rows);
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const ownerResult = db.exec("SELECT id FROM users WHERE username = 'owner' LIMIT 1");
  const ownerId = ownerResult.length ? ownerResult[0].values[0][0] : null;
  const now = new Date().toISOString();

  db.run("BEGIN TRANSACTION;");
  try {
    scopes.forEach(function clearScope(scope) {
      db.run(
        "DELETE FROM daily_ledgers WHERE substr(ledger_date, 1, 7) = ? AND store_name = ?",
        [scope.month, scope.storeName]
      );
      db.run(
        "DELETE FROM expense_entries WHERE substr(expense_date, 1, 7) = ? AND store_name = ? AND note LIKE ?",
        [scope.month, scope.storeName, IMPORT_NOTE_PREFIX + "%"]
      );
    });

    rows.forEach(function insertRow(row) {
      db.run(
        "INSERT INTO daily_ledgers (ledger_date, store_name, sales_total, actual_received, cash_amount, wechat_amount, alipay_amount, member_card_amount, refund_amount, rounding_amount, note, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?)",
        [
          row.date,
          row.storeName,
          row.salesTotal,
          row.actualReceived,
          IMPORT_NOTE_PREFIX,
          ownerId,
          ownerId,
          now,
          now
        ]
      );

      if (row.expenseTotal > 0) {
        db.run(
          "INSERT INTO expense_entries (expense_date, store_name, expense_type, amount, note, created_by, created_at, updated_at) VALUES (?, ?, 'daily', ?, ?, ?, ?, ?)",
          [
            row.date,
            row.storeName,
            row.expenseTotal,
            IMPORT_NOTE_PREFIX + " 日支出汇总",
            ownerId,
            now,
            now
          ]
        );
      }
    });

    db.run("COMMIT;");
  } catch (error) {
    db.run("ROLLBACK;");
    throw error;
  }

  fs.writeFileSync(dbPath, Buffer.from(db.export()));

  const totalSales = rows.reduce(function sum(current, row) {
    return current + row.salesTotal;
  }, 0);
  const totalActualReceived = rows.reduce(function sum(current, row) {
    return current + row.actualReceived;
  }, 0);
  const totalExpense = rows.reduce(function sum(current, row) {
    return current + row.expenseTotal;
  }, 0);

  process.stdout.write(JSON.stringify({
    importedRows: rows.length,
    months: Array.from(new Set(scopes.map(function mapScope(scope) {
      return scope.month;
    }))),
    stores: Array.from(new Set(scopes.map(function mapScope(scope) {
      return scope.storeName;
    }))),
    totalSales: Number(totalSales.toFixed(2)),
    totalActualReceived: Number(totalActualReceived.toFixed(2)),
    totalExpense: Number(totalExpense.toFixed(2))
  }));
}

main().catch(function onError(error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
