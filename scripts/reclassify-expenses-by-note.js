const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js/dist/sql-asm.js");

const DB_PATH = path.join(process.cwd(), "data", "ledger.sqlite");

const EXACT_MAP = {
  "房租": "rent",
  "库房电费": "utilities",
  "接电": "utilities",
  "排风": "utilities",
  "运费": "delivery",
  "加油": "delivery",
  "汽": "delivery",
  "九路": "delivery",
  "充卡": "delivery",
  "塑料袋": "packaging",
  "保鲜膜": "packaging",
  "小白袋": "packaging",
  "方盒": "packaging",
  "口罩": "packaging",
  "帽子": "packaging",
  "料酒": "purchase",
  "味精盐": "purchase",
  "拌料": "purchase",
  "花椒油": "purchase",
  "香膏": "purchase",
  "盐度计": "other_daily",
  "吃": "labor",
  "车库": "rent"
};

const KEYWORD_RULES = [
  { keywords: ["房租", "库房", "车库"], type: "rent" },
  { keywords: ["电费", "水费", "燃气", "煤气", "接电", "排风"], type: "utilities" },
  { keywords: ["人工", "工资", "工费", "餐补", "吃饭", "吃"], type: "labor" },
  { keywords: ["塑料袋", "白袋", "方盒", "保鲜膜", "盒", "袋", "包装", "口罩", "帽子"], type: "packaging" },
  { keywords: ["平台", "抽成", "佣金"], type: "platform_fee" },
  { keywords: ["运费", "配送", "加油", "油", "汽", "充卡", "路费", "九路"], type: "delivery" },
  { keywords: ["料酒", "味精", "盐", "拌料", "花椒油", "香膏"], type: "purchase" }
];

function classifyExpense(note, currentType) {
  const text = String(note || "").trim();
  if (!text) {
    return currentType || "other_daily";
  }
  if (EXACT_MAP[text]) {
    return EXACT_MAP[text];
  }
  const matchedRule = KEYWORD_RULES.find(function findRule(rule) {
    return rule.keywords.some(function hasKeyword(keyword) {
      return text.includes(keyword);
    });
  });
  return matchedRule ? matchedRule.type : (currentType === "purchase" ? "purchase" : "other_daily");
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error("Database file not found: " + DB_PATH);
  }

  const backupPath = path.join(
    path.dirname(DB_PATH),
    "ledger.sqlite.bak-expense-type-" + new Date().toISOString().replace(/[:.]/g, "-")
  );
  fs.copyFileSync(DB_PATH, backupPath);

  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_PATH));
  const selectStmt = db.prepare("SELECT id, expense_type, note FROM expense_entries ORDER BY id ASC");
  const rows = [];
  while (selectStmt.step()) {
    rows.push(selectStmt.getAsObject());
  }
  selectStmt.free();

  const summary = {};
  let updatedCount = 0;

  rows.forEach(function updateRow(row) {
    const nextType = classifyExpense(row.note, row.expense_type);
    if (nextType !== row.expense_type) {
      db.run("UPDATE expense_entries SET expense_type = ? WHERE id = ?", [nextType, row.id]);
      updatedCount += 1;
    }
    summary[nextType] = (summary[nextType] || 0) + 1;
  });

  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  console.log(JSON.stringify({
    backupPath: backupPath,
    updatedCount: updatedCount,
    summary: summary
  }, null, 2));
}

main().catch(function onError(error) {
  console.error(error);
  process.exit(1);
});
