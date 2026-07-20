const state = {
  token: localStorage.getItem("ledger_token") || "",
  user: null,
  users: [],
  stores: [],
  selectedStore: "",
  products: [],
  purchaseProducts: [],
  overviewBundle: null,
  overviewRange: null,
  ledgerBundle: null,
  purchases: [],
  monthlySummary: null,
  monthlyExpenseSummary: null,
  purchaseAutocomplete: {
    items: [],
    highlightedIndex: -1,
    open: false
  },
  purchaseDraftItems: [],
  analytics: {
    metric: "salesTotal",
    dailyRange: 30,
    data: null
  },
  receiptScan: null
};

const EXPENSE_TYPE_TEXT = {
  purchase: "进货支出",
  rent: "房租",
  utilities: "水电",
  labor: "人工",
  packaging: "包装耗材",
  platform_fee: "平台抽成",
  delivery: "配送费",
  other_daily: "其他日常支出"
};

function byId(id) {
  return document.getElementById(id);
}

function bindById(id, eventName, handler) {
  var element = byId(id);
  if (!element) {
    console.warn("Missing element:", id);
    return null;
  }
  element.addEventListener(eventName, handler);
  return element;
}

function ensurePurchaseProductsUi() {
  if (!byId("purchaseProductsSection")) {
    var usersSection = byId("usersSection");
    if (usersSection && usersSection.parentNode) {
      var section = document.createElement("section");
      section.id = "purchaseProductsSection";
      section.className = "page-section hidden owner-only";
      section.innerHTML = [
        '<article class="panel">',
        '  <div class="panel-head"><h3>进货商品管理</h3></div>',
        '  <form id="purchaseProductForm" class="form-grid">',
        '    <input name="id" type="hidden">',
        '    <label><span>商品名称</span><input name="name" required></label>',
        '    <label><span>默认单位</span><input name="defaultUnit" placeholder="例如：箱 / 斤 / 1"></label>',
        '    <label class="full"><span>别名 / 关键词</span><input name="keywords" placeholder="多个关键词可用逗号分隔"></label>',
        '    <label><span>最近参考进价</span><input name="lastUnitCost" type="number" step="0.01" placeholder="可留空，默认按 0 处理"></label>',
        '    <label><span>默认供应商</span><input name="lastSupplier" placeholder="可留空"></label>',
        '    <label><span>排序</span><input name="sortOrder" type="number" step="1" value="0"></label>',
        '    <label class="checkbox-row"><input name="isActive" type="checkbox" checked><span>启用进货商品</span></label>',
        '    <div class="full form-actions">',
        '      <button type="submit" class="primary">保存进货商品</button>',
        '      <button type="button" id="resetPurchaseProductBtn" class="ghost">清空表单</button>',
        '    </div>',
        '  </form>',
        '</article>',
        '<article class="panel">',
        '  <div class="panel-head"><h3>进货商品列表</h3></div>',
        '  <div id="purchaseProductsTable"></div>',
        '</article>'
      ].join("");
      usersSection.parentNode.insertBefore(section, usersSection);
    }
  }

  if (!document.querySelector('.nav-btn[data-section="purchaseProductsSection"]')) {
    var usersButton = document.querySelector('.nav-btn[data-section="usersSection"]');
    if (usersButton && usersButton.parentNode) {
      var button = document.createElement("button");
      button.className = "nav-btn owner-only";
      button.dataset.section = "purchaseProductsSection";
      button.textContent = "进货商品管理";
      usersButton.parentNode.insertBefore(button, usersButton);
    }
  }
}

function isOwner() {
  return state.user && state.user.role === "owner";
}

function currentDate() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth() {
  return currentDate().slice(0, 7);
}

function isMonthEndDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    return false;
  }
  const current = new Date(date + "T00:00:00Z");
  const next = new Date(current.getTime() + 24 * 60 * 60 * 1000);
  return next.toISOString().slice(0, 7) !== String(date).slice(0, 7);
}

function inventoryAmountHintText(date) {
  return isMonthEndDate(date)
    ? "今天是月底盘库日，请填写本月底还压在店里的进货成本。"
    : "这个数改为只在月底盘库日填写，平时会沿用上一次月底库存。";
}

function yuan(value) {
  return "¥" + Number(value || 0).toFixed(2);
}

function money(value) {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) {
    return 0;
  }
  return Math.round(amount * 100) / 100;
}

function percentText(value) {
  return value === null || value === undefined ? "新增" : Number(value).toFixed(2) + "%";
}

function showMessage(message) {
  if (message) {
    window.alert(message);
  }
}

function normalizeLedgerMoneyInput(value) {
  return String(value || "").trim() ? String(value).trim() : "0";
}

function expenseTypeText(type, label) {
  return label || EXPENSE_TYPE_TEXT[type] || EXPENSE_TYPE_TEXT.other_daily;
}

function getSelectedStore() {
  if (!isOwner()) {
    return state.user && state.user.storeName ? state.user.storeName : "";
  }
  return state.selectedStore || "";
}

function getStoreQuery() {
  const storeName = getSelectedStore();
  if (!isOwner() || !storeName) {
    return "";
  }
  return "storeName=" + encodeURIComponent(storeName);
}

function appendStoreQuery(url) {
  const query = getStoreQuery();
  if (!query) {
    return url;
  }
  return url + (url.includes("?") ? "&" : "?") + query;
}

function ensureWritableStoreSelection() {
  if (!isOwner()) {
    return true;
  }
  if (state.selectedStore && state.selectedStore !== "all") {
    return true;
  }
  showMessage("请先选择一个具体门店，再录入数据。");
  return false;
}

async function request(url, options) {
  const init = options || {};
  const headers = Object.assign({ "Content-Type": "application/json" }, init.headers || {});
  if (state.token) {
    headers.Authorization = "Bearer " + state.token;
  }
  const response = await fetch(url, Object.assign({}, init, { headers }));
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error((payload && payload.error) || "请求失败");
  }
  return payload;
}

async function uploadFile(url, file, extraFields) {
  const formData = new FormData();
  formData.append("receiptImage", file);
  Object.keys(extraFields || {}).forEach(function appendField(key) {
    formData.append(key, extraFields[key]);
  });
  const response = await fetch(url, {
    method: "POST",
    headers: state.token ? { Authorization: "Bearer " + state.token } : {},
    body: formData
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error((payload && payload.error) || "上传失败");
  }
  return payload;
}

function parseDownloadFilename(contentDisposition, fallbackName) {
  if (!contentDisposition) {
    return fallbackName;
  }
  const utfMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch && utfMatch[1]) {
    return decodeURIComponent(utfMatch[1]);
  }
  const plainMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
  if (plainMatch && plainMatch[1]) {
    try {
      return decodeURIComponent(plainMatch[1]);
    } catch (error) {
      return plainMatch[1];
    }
  }
  return fallbackName;
}

async function downloadFile(url, filename) {
  const separator = url.includes("?") ? "&" : "?";
  const response = await fetch(url + separator + "_ts=" + Date.now(), {
    headers: state.token ? { Authorization: "Bearer " + state.token } : {}
  });
  if (!response.ok) {
    throw new Error("导出失败");
  }
  const blob = await response.blob();
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = parseDownloadFilename(response.headers.get("content-disposition"), filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(objectUrl);
}

function setSection(sectionId) {
  document.querySelectorAll(".page-section").forEach(function (item) {
    item.classList.toggle("hidden", item.id !== sectionId);
  });
  document.querySelectorAll(".nav-btn").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.section === sectionId);
  });
}

function updateOwnerVisibility() {
  const owner = isOwner();
  document.querySelectorAll(".owner-only").forEach(function (el) {
    el.classList.toggle("hidden", !owner);
  });
  const activeButton = document.querySelector(".nav-btn.active");
  const hiddenSection = activeButton && activeButton.classList.contains("hidden");
  if (!owner && (!activeButton || hiddenSection || ["overviewSection", "dailyReportSection", "monthlyReportSection", "analyticsSection", "productsSection", "purchaseProductsSection", "usersSection"].includes(activeButton.dataset.section))) {
    setSection("ledgerSection");
  }
}

function renderStoreFilter() {
  const select = byId("ownerStoreFilter");
  if (!select) {
    return;
  }
  const stores = state.stores.slice();
  if (!state.selectedStore || (state.selectedStore !== "all" && stores.indexOf(state.selectedStore) === -1)) {
    state.selectedStore = stores[0] || "all";
  }
  select.innerHTML = ['<option value="all">全部门店</option>'].concat(
    stores.map(function (storeName) {
      return '<option value="' + storeName + '">' + storeName + "</option>";
    })
  ).join("");
  select.value = state.selectedStore || "all";
}

function tableHtml(headers, rows) {
  return '<div class="table-scroll"><table><thead><tr>' + headers.map(function (head) {
    return "<th>" + head + "</th>";
  }).join("") + "</tr></thead><tbody>" + rows.map(function (row) {
    return "<tr>" + row.map(function (cell) {
      return "<td>" + cell + "</td>";
    }).join("") + "</tr>";
  }).join("") + "</tbody></table></div>";
}

function reportSectionHtml(title, content) {
  return '<section class="report-section"><div class="report-section-title">' + title + "</div>" + content + "</section>";
}

function splitProductKeywords(value) {
  return String(value || "")
    .split(/[\n,，;；]/)
    .map(function (item) {
      return String(item || "").trim();
    })
    .filter(Boolean);
}

function normalizeProductMatchText(value) {
  return String(value || "").trim().toLowerCase();
}

function getPurchaseProductMatches(query) {
  const normalizedQuery = normalizeProductMatchText(query);
  if (!normalizedQuery || normalizedQuery.length < 1) {
    return [];
  }
  return state.purchaseProducts.filter(function (item) {
    return item.isActive;
  }).map(function (item) {
    const normalizedName = normalizeProductMatchText(item.name);
    const matchedKeywords = splitProductKeywords(item.keywords).filter(function (keyword) {
      return normalizeProductMatchText(keyword).includes(normalizedQuery);
    });
    const nameMatched = normalizedName.includes(normalizedQuery);
    if (!nameMatched && !matchedKeywords.length) {
      return null;
    }
    return {
      id: item.id,
      name: item.name,
      unit: item.defaultUnit || "",
      defaultUnit: item.defaultUnit || "",
      lastUnitCost: item.lastUnitCost,
      matchedKeywords: matchedKeywords,
      matchPriority: nameMatched ? 0 : 1
    };
  }).filter(Boolean).sort(function (a, b) {
    if (a.matchPriority !== b.matchPriority) {
      return a.matchPriority - b.matchPriority;
    }
    return String(a.name).localeCompare(String(b.name), "zh-CN");
  }).slice(0, 8);
}

function renderPurchaseProductSuggestions() {
  const target = byId("purchaseProductSuggestions");
  if (!target) {
    return;
  }
  if (!state.purchaseAutocomplete.open) {
    target.classList.add("hidden");
    target.innerHTML = "";
    return;
  }
  if (!state.purchaseAutocomplete.items.length) {
    target.innerHTML = '<div class="purchase-suggestion-empty">无匹配商品</div>';
    target.classList.remove("hidden");
    return;
  }
  target.innerHTML = state.purchaseAutocomplete.items.map(function (item, index) {
    const detail = item.matchedKeywords.length
      ? "关键词：" + item.matchedKeywords.slice(0, 2).join("、")
      : "商品名称匹配";
    return '<button type="button" class="purchase-suggestion-btn' + (index === state.purchaseAutocomplete.highlightedIndex ? " active" : "") + '" data-purchase-suggestion="' + index + '">' +
      "<strong>" + item.name + '</strong><span>' + detail + (item.unit ? " · " + item.unit : "") + "</span></button>";
  }).join("");
  target.classList.remove("hidden");
}

function closePurchaseProductSuggestions() {
  state.purchaseAutocomplete.items = [];
  state.purchaseAutocomplete.highlightedIndex = -1;
  state.purchaseAutocomplete.open = false;
  renderPurchaseProductSuggestions();
}

function updatePurchaseProductSuggestions(query, preferredIndex) {
  const items = getPurchaseProductMatches(query);
  state.purchaseAutocomplete.items = items;
  state.purchaseAutocomplete.open = Boolean(query && normalizeProductMatchText(query).length >= 1);
  if (!state.purchaseAutocomplete.open) {
    state.purchaseAutocomplete.highlightedIndex = -1;
  } else if (!items.length) {
    state.purchaseAutocomplete.highlightedIndex = -1;
  } else if (typeof preferredIndex === "number" && preferredIndex >= 0 && preferredIndex < items.length) {
    state.purchaseAutocomplete.highlightedIndex = preferredIndex;
  } else {
    state.purchaseAutocomplete.highlightedIndex = 0;
  }
  renderPurchaseProductSuggestions();
}

function applyPurchaseProductSuggestion(index) {
  const item = state.purchaseAutocomplete.items[index];
  const input = byId("purchaseProductNameInput");
  if (!item || !input) {
    return;
  }
  const form = byId("purchaseForm");
  input.value = item.name;
  if (form && form.elements.unit) {
    form.elements.unit.value = item.defaultUnit || "1";
  }
  if (form && form.elements.unitCost) {
    form.elements.unitCost.value = item.lastUnitCost ? String(item.lastUnitCost) : "";
  }
  closePurchaseProductSuggestions();
}

function renderOverview() {
  if (!state.overviewBundle || !isOwner()) {
    return;
  }
  const ledger = state.overviewBundle.ledger;
  const cards = [
    { label: "今日销售总额", value: yuan(ledger.salesTotal), sub: "营业额与单品销售分开记录" },
    { label: "今日实际收款", value: yuan(ledger.actualReceived), sub: "现金、微信、支付宝、会员卡" },
    { label: "今日支出", value: yuan(ledger.expenseTotal), sub: "日常支出汇总" },
    { label: "今日毛利润", value: yuan(ledger.grossProfit), sub: "销售总额减去进货金额" },
    { label: "今日实际利润", value: yuan(ledger.actualProfit), sub: "毛利润再减去支出" }
  ];
  byId("overviewCards").innerHTML = cards.map(function (item) {
    return '<article class="metric-card"><div class="label">' + item.label + '</div><div class="value">' + item.value + '</div><div class="sub">' + item.sub + "</div></article>";
  }).join("");

  byId("topProductsTable").innerHTML = state.overviewBundle.topProducts.length
    ? tableHtml(
        ["商品", "销量", "金额"],
        state.overviewBundle.topProducts.map(function (item) {
          return [
            item.name + ' <span class="pill">' + (item.saleMode === "weight" ? "按重量" : "按份数") + "</span>",
            item.totalQuantity + item.unit,
            yuan(item.totalAmount)
          ];
        })
      )
    : '<div class="empty">当天还没有单品销售数据。</div>';

  byId("expenseSnapshot").innerHTML = state.overviewBundle.expenses.length
    ? '<div class="snapshot-list">' + state.overviewBundle.expenses.map(function (item) {
        return '<div class="snapshot-item"><span>' + expenseTypeText(item.expenseType, item.expenseLabel) + (item.note ? " · " + item.note : "") + "</span><strong>" + yuan(item.amount) + "</strong></div>";
      }).join("") + "</div>"
    : '<div class="empty">当天还没有支出记录。</div>';
}

function renderOverview() {
  if (!state.overviewBundle || !isOwner()) {
    return;
  }
  const ledger = state.overviewBundle.ledger;
  const overviewMetrics = state.overviewBundle.overviewMetrics || {};
  const rangeMetrics = state.overviewRange || null;
  const activeMonth = byId("activeMonth").value;
  const dayPurchaseTotal = (state.purchases || []).reduce(function sumPurchaseTotal(total, item) {
    return total + Number(item.totalCost || 0);
  }, 0);
  const monthMetrics = overviewMetrics.month && overviewMetrics.month.totals
    ? overviewMetrics.month
    : { key: activeMonth, salesDays: 0, totals: { averageSales: 0, purchaseTotal: 0, grossProfit: 0, actualProfit: 0 } };
  const yearMetrics = overviewMetrics.year && overviewMetrics.year.totals
    ? overviewMetrics.year
    : { key: String(activeMonth || "").slice(0, 4), salesDays: 0, totals: { averageSales: 0, purchaseTotal: 0, grossProfit: 0, actualProfit: 0 } };
  const dayCards = [
    { label: "\u4eca\u65e5\u9500\u552e\u603b\u989d", value: yuan(ledger.salesTotal), sub: "\u4ee5\u5f53\u5929\u5feb\u901f\u8bb0\u8d26\u4e3a\u51c6" },
    { label: "\u4eca\u65e5\u5b9e\u9645\u6536\u6b3e", value: yuan(ledger.actualReceived), sub: "\u73b0\u91d1\u3001\u5fae\u4fe1\u3001\u652f\u4ed8\u5b9d\u3001\u4f1a\u5458\u5361" },
    { label: "\u4eca\u65e5\u4f1a\u5458\u5361\u6536\u5165", value: yuan(ledger.memberCardAmount), sub: "\u5f53\u5929\u5df2\u8bb0\u5f55\u7684\u4f1a\u5458\u5361\u6536\u5165" },
    { label: "\u4eca\u65e5\u652f\u51fa", value: yuan(ledger.expenseTotal), sub: "\u5f53\u5929\u652f\u51fa\u5408\u8ba1" },
    { label: "\u5f53\u65e5\u8fdb\u8d27\u652f\u51fa", value: yuan(dayPurchaseTotal), sub: "\u6309\u5f53\u5929\u8fdb\u8d27\u8bb0\u5f55\u6c47\u603b" }
  ];
  const monthCards = [
    { label: "\u672c\u6708\u6709\u9500\u552e\u5929\u6570", value: String(monthMetrics.salesDays), sub: "\u53ea\u7edf\u8ba1\u9500\u552e\u603b\u989d\u5927\u4e8e0\u7684\u5929" },
    { label: "\u672c\u6708\u9500\u552e\u603b\u989d", value: yuan(monthMetrics.totals.salesTotal), sub: "\u6309" + monthMetrics.key + "\u9500\u552e\u603b\u989d\u6c47\u603b" },
    { label: "\u672c\u6708\u5e73\u5747\u9500\u552e\u989d", value: yuan(monthMetrics.totals.averageSales), sub: "\u6309" + monthMetrics.key + "\u7edf\u8ba1" },
    { label: "\u672c\u6708\u4f1a\u5458\u5361\u6536\u5165", value: yuan(monthMetrics.totals.memberCardAmount), sub: "\u6309" + monthMetrics.key + "\u4f1a\u5458\u5361\u53e3\u5f84\u6c47\u603b" },
    { label: "\u672c\u6708\u603b\u8fdb\u8d27\u82b1\u8d39", value: yuan(monthMetrics.totals.purchaseTotal), sub: "\u8fdb\u8d27\u8bb0\u5f55\u6c47\u603b" },
    { label: "\u672c\u6708\u6bdb\u5229\u6da6", value: yuan(monthMetrics.totals.grossProfit), sub: "\u9500\u552e - \u8fdb\u8d27" },
    { label: "\u672c\u6708\u5b9e\u9645\u5229\u6da6", value: yuan(monthMetrics.totals.actualProfit), sub: "\u6bdb\u5229\u6da6 - \u652f\u51fa" }
  ];
  const yearCards = [
    { label: "\u672c\u5e74\u6709\u9500\u552e\u5929\u6570", value: String(yearMetrics.salesDays), sub: "\u53ea\u7edf\u8ba1\u9500\u552e\u603b\u989d\u5927\u4e8e0\u7684\u5929" },
    { label: "\u672c\u5e74\u9500\u552e\u603b\u989d", value: yuan(yearMetrics.totals.salesTotal), sub: "\u6309" + yearMetrics.key + "\u5e74\u9500\u552e\u603b\u989d\u6c47\u603b" },
    { label: "\u672c\u5e74\u5e73\u5747\u9500\u552e\u989d", value: yuan(yearMetrics.totals.averageSales), sub: "\u6309" + yearMetrics.key + "\u5e74\u7edf\u8ba1" },
    { label: "\u672c\u5e74\u4f1a\u5458\u5361\u6536\u5165", value: yuan(yearMetrics.totals.memberCardAmount), sub: "\u6309" + yearMetrics.key + "\u5e74\u4f1a\u5458\u5361\u53e3\u5f84\u6c47\u603b" },
    { label: "\u672c\u5e74\u603b\u8fdb\u8d27\u82b1\u8d39", value: yuan(yearMetrics.totals.purchaseTotal), sub: "\u8fdb\u8d27\u8bb0\u5f55\u6c47\u603b" },
    { label: "\u672c\u5e74\u6bdb\u5229\u6da6", value: yuan(yearMetrics.totals.grossProfit), sub: "\u9500\u552e - \u8fdb\u8d27" },
    { label: "\u672c\u5e74\u5b9e\u9645\u5229\u6da6", value: yuan(yearMetrics.totals.actualProfit), sub: "\u6bdb\u5229\u6da6 - \u652f\u51fa" }
  ];
  function renderMetricCards(targetId, cards) {
    byId(targetId).innerHTML = cards.map(function (item) {
      return '<article class="metric-card"><div class="label">' + item.label + '</div><div class="value">' + item.value + '</div><div class="sub">' + item.sub + "</div></article>";
    }).join("");
  }
  renderMetricCards("overviewDayCards", dayCards);
  renderMetricCards("overviewMonthCards", monthCards);
  renderMetricCards("overviewYearCards", yearCards);
  const rangeCards = rangeMetrics
      ? [
        { label: "\u533a\u95f4\u9500\u552e\u603b\u989d", value: yuan(rangeMetrics.totals.salesTotal), sub: "\u4ece" + rangeMetrics.fromDate + "\u5230" + rangeMetrics.toDate },
        { label: "\u533a\u95f4\u4f1a\u5458\u5361\u6536\u5165", value: yuan(rangeMetrics.totals.memberCardAmount), sub: "\u533a\u95f4\u5185\u4f1a\u5458\u5361\u6536\u5165\u6c47\u603b" },
        { label: "\u533a\u95f4\u652f\u51fa\u603b\u989d", value: yuan(rangeMetrics.totals.expenseTotal), sub: "\u533a\u95f4\u5185\u652f\u51fa\u8bb0\u5f55\u6c47\u603b" },
        { label: "\u533a\u95f4\u8fdb\u8d27\u603b\u989d", value: yuan(rangeMetrics.totals.purchaseTotal), sub: "\u533a\u95f4\u5185\u8fdb\u8d27\u8bb0\u5f55\u6c47\u603b" },
        { label: "\u533a\u95f4\u5e73\u5747\u9500\u552e\u989d", value: yuan(rangeMetrics.totals.averageSales), sub: rangeMetrics.salesDays + "\u4e2a\u6709\u9500\u552e\u65e5" },
        { label: "\u533a\u95f4\u6bdb\u5229\u6da6", value: yuan(rangeMetrics.totals.grossProfit), sub: "\u9500\u552e - \u8fdb\u8d27" },
        { label: "\u533a\u95f4\u5b9e\u9645\u5229\u6da6", value: yuan(rangeMetrics.totals.actualProfit), sub: "\u6bdb\u5229\u6da6 - \u652f\u51fa" },
        { label: "\u533a\u95f4\u5b9e\u9645\u6536\u6b3e", value: yuan(rangeMetrics.totals.actualReceived), sub: "\u6309\u8bb0\u8d26\u5df2\u5f55\u5165\u7684\u5b9e\u6536\u53e3\u5f84" }
      ]
    : [];
  renderMetricCards("overviewRangeCards", rangeCards);
  byId("overviewRangeMeta").textContent = rangeMetrics
    ? ("查询区间：" + rangeMetrics.fromDate + " 至 " + rangeMetrics.toDate + "，有销售数据 " + rangeMetrics.salesDays + " 天。")
    : "";
  if (rangeMetrics) {
    byId("overviewRangeMeta").textContent = "\u67e5\u8be2\u533a\u95f4\uff1a" + rangeMetrics.fromDate + " \u81f3 " + rangeMetrics.toDate + "\uff0c\u6709\u9500\u552e\u6570\u636e " + rangeMetrics.salesDays + " \u5929\u3002";
  }
  byId("topProductsTable").innerHTML = state.overviewBundle.topProducts.length
    ? tableHtml(
        ["\u5546\u54c1", "\u9500\u91cf", "\u91d1\u989d"],
        state.overviewBundle.topProducts.map(function (item) {
          return [
            item.name + ' <span class="pill">' + (item.saleMode === "weight" ? "\u6309\u91cd\u91cf" : "\u6309\u4efd\u6570") + "</span>",
            item.totalQuantity + item.unit,
            yuan(item.totalAmount)
          ];
        })
      )
    : '<div class="empty">\u5f53\u5929\u8fd8\u6ca1\u6709\u5355\u54c1\u9500\u552e\u6570\u636e\u3002</div>';

  byId("expenseSnapshot").innerHTML = state.overviewBundle.expenses.length
    ? '<div class="snapshot-list">' + state.overviewBundle.expenses.map(function (item) {
        return '<div class="snapshot-item"><span>' + expenseTypeText(item.expenseType, item.expenseLabel) + (item.note ? " | " + item.note : "") + "</span><strong>" + yuan(item.amount) + "</strong></div>";
      }).join("") + "</div>"
    : '<div class="empty">\u5f53\u5929\u8fd8\u6ca1\u6709\u652f\u51fa\u8bb0\u5f55\u3002</div>';
}

function toNumber(value) {
  return Number(value || 0);
}

function hasValue(value) {
  return value !== null && value !== undefined;
}

function profitDisplayValue(primaryValue, fallbackValue) {
  if (hasValue(primaryValue)) {
    return yuan(primaryValue);
  }
  if (hasValue(fallbackValue)) {
    return "参考 " + yuan(fallbackValue);
  }
  return "待盘库";
}

function effectiveProfitNumber(primaryValue, fallbackValue) {
  return hasValue(primaryValue) ? toNumber(primaryValue) : toNumber(fallbackValue);
}

function ratioPercent(part, total) {
  if (!total) {
    return 0;
  }
  return (toNumber(part) / toNumber(total)) * 100;
}

function formatPercent(value) {
  if (!isFinite(value)) {
    return "--";
  }
  return Number(value).toFixed(1) + "%";
}

function aggregateExpensesByType(expenses) {
  const grouped = {};
  (expenses || []).forEach(function collect(item) {
    const type = item.expenseType || "other_daily";
    if (!grouped[type]) {
      grouped[type] = {
        type: type,
        label: expenseTypeText(type, item.expenseLabel),
        amount: 0
      };
    }
    grouped[type].amount += toNumber(item.amount);
  });
  return Object.keys(grouped).map(function mapItem(key) {
    return grouped[key];
  }).sort(function sortItem(a, b) {
    return b.amount - a.amount;
  });
}

function buildOverviewAlerts(ledger, monthMetrics, dayPurchaseTotal) {
  const alerts = [];
  const salesTotal = toNumber(ledger.salesTotal);
  const actualReceived = toNumber(ledger.actualReceived);
  const grossProfit = toNumber(ledger.grossProfit);
  const actualProfit = toNumber(ledger.actualProfit);
  const expenseTotal = toNumber(ledger.expenseTotal);
  const monthSalesTotal = toNumber(monthMetrics.totals.salesTotal);
  const monthGrossProfit = toNumber(monthMetrics.totals.grossProfit);
  const monthActualProfit = toNumber(monthMetrics.totals.actualProfit);
  const monthExpenseTotal = toNumber(monthMetrics.totals.expenseTotal);
  const monthSalesDays = toNumber(monthMetrics.salesDays);

  if (monthSalesDays >= 3 && monthActualProfit < 0) {
    alerts.push({
      tone: "danger",
      title: "本月累计实际利润仍为负",
      detail: "本月毛利 " + yuan(monthGrossProfit) + "，但支出累计 " + yuan(monthExpenseTotal) + "，当前实际利润为 " + yuan(monthActualProfit) + "。"
    });
  }
  if (monthSalesDays >= 3 && monthGrossProfit < 0) {
    alerts.push({
      tone: "danger",
      title: "本月毛利已经转负",
      detail: "本月销售额低于进货成本，建议先核对售价、折扣和进货是否集中在本月入账。"
    });
  }
  if (monthGrossProfit > 0 && monthExpenseTotal > monthGrossProfit * 0.55) {
    alerts.push({
      tone: "warn",
      title: "本月支出吃掉了大半毛利",
      detail: "本月支出相当于本月毛利的 " + formatPercent(ratioPercent(monthExpenseTotal, monthGrossProfit)) + "。"
    });
  }
  if (monthSalesTotal > 0 && monthSalesDays < 5) {
    alerts.push({
      tone: "info",
      title: "本月销售天数还偏少",
      detail: "当前只有 " + monthSalesDays + " 个有销售日期，本月利润判断还会继续波动。"
    });
  }
  if (salesTotal > 0 && Math.abs(salesTotal - actualReceived) > Math.max(50, salesTotal * 0.15)) {
    alerts.push({
      tone: "warn",
      title: "今日销售额和实收差距偏大",
      detail: "当前差额 " + yuan(actualReceived - salesTotal) + "，建议核对退款、抹零和会员卡口径。"
    });
  }
  if (actualProfit < 0) {
    alerts.push({
      tone: "warn",
      title: "今日实际利润为负",
      detail: "今天毛利 " + yuan(grossProfit) + "，支出 " + yuan(expenseTotal) + "，当天结果已经转负。"
    });
  }
  if (salesTotal > 0 && toNumber(dayPurchaseTotal) === 0) {
    alerts.push({
      tone: "info",
      title: "今天没有新增进货记录",
      detail: "如果今天实际有补货但未入账，毛利会被高估。"
    });
  }
  if (!alerts.length) {
    alerts.push({
      tone: "good",
      title: "本月和今天都没有明显异常",
      detail: "本月利润、支出结构和今天的收款口径看起来都比较正常。"
    });
  }
  return alerts.slice(0, 4);
}

function renderAlertGroup(title, items, bucketClass) {
  if (!items.length) {
    return "";
  }
  return [
    '<section class="alert-group ' + bucketClass + '">',
    '  <div class="alert-group-title">' + title + '</div>',
    '  <div class="alert-list">' + items.map(function mapAlert(item) {
      return [
        '<article class="alert-item alert-' + item.tone + '">',
        '  <strong>' + item.title + '</strong>',
        '  <p>' + item.detail + '</p>',
        '</article>'
      ].join("");
    }).join("") + '</div>',
    '</section>'
  ].join("");
}

function renderOverview() {
  if (!state.overviewBundle || !isOwner()) {
    return;
  }
  const ledger = state.overviewBundle.ledger;
  const overviewMetrics = state.overviewBundle.overviewMetrics || {};
  const rangeMetrics = state.overviewRange || null;
  const activeMonth = byId("activeMonth").value;
  const dayPurchaseTotal = (state.purchases || []).reduce(function sumPurchaseTotal(total, item) {
    return total + Number(item.totalCost || 0);
  }, 0);
  const monthMetrics = overviewMetrics.month && overviewMetrics.month.totals
    ? overviewMetrics.month
    : { key: activeMonth, salesDays: 0, profitFinalized: true, totals: { averageSales: 0, purchaseTotal: 0, grossProfit: 0, actualProfit: 0, referenceGrossProfit: 0, referenceActualProfit: 0 } };
  const yearMetrics = overviewMetrics.year && overviewMetrics.year.totals
    ? overviewMetrics.year
    : { key: String(activeMonth || "").slice(0, 4), salesDays: 0, finalizedMonths: [], pendingMonths: [], totals: { averageSales: 0, purchaseTotal: 0, grossProfit: 0, actualProfit: 0 } };
  const salesTotal = toNumber(ledger.salesTotal);
  const grossProfit = toNumber(ledger.grossProfit);
  const actualProfit = toNumber(ledger.actualProfit);
  const expenseTotal = toNumber(ledger.expenseTotal);
  const monthSalesTotal = toNumber(monthMetrics.totals.salesTotal);
  const monthGrossProfit = effectiveProfitNumber(monthMetrics.totals.finalGrossProfit, monthMetrics.totals.referenceGrossProfit);
  const monthActualProfit = effectiveProfitNumber(monthMetrics.totals.finalActualProfit, monthMetrics.totals.referenceActualProfit);
  const monthExpenseTotal = toNumber(monthMetrics.totals.expenseTotal);
  const yearSalesTotal = toNumber(yearMetrics.totals.salesTotal);
  const yearGrossProfit = toNumber(yearMetrics.totals.grossProfit);
  const yearActualProfit = toNumber(yearMetrics.totals.actualProfit);
  const alerts = buildOverviewAlerts(ledger, monthMetrics, dayPurchaseTotal);
  const grossMargin = formatPercent(ratioPercent(monthGrossProfit, monthSalesTotal));
  const actualMargin = formatPercent(ratioPercent(monthActualProfit, monthSalesTotal));
  const monthExpenseRatio = formatPercent(ratioPercent(monthExpenseTotal, monthSalesTotal));
  const yearGrossMargin = formatPercent(ratioPercent(yearGrossProfit, yearSalesTotal));
  const yearActualMargin = formatPercent(ratioPercent(yearActualProfit, yearSalesTotal));

  byId("overviewProfitFocus").innerHTML = [
    '<div class="profit-focus-main">',
    '  <div class="profit-main-kicker">' + (monthMetrics.profitFinalized ? '本月实际利润' : '本月参考利润') + '</div>',
    '  <div class="profit-main-value">' + profitDisplayValue(monthMetrics.totals.finalActualProfit, monthMetrics.totals.referenceActualProfit) + '</div>',
    '  <div class="profit-main-sub">' + (monthMetrics.profitFinalized
      ? ('本月毛利 ' + yuan(monthGrossProfit) + '，再减去本月支出 ' + yuan(monthExpenseTotal))
      : ('月底库存还未提交，当前先按销售 - 进货 - 支出显示参考利润。月底盘库日：' + (monthMetrics.monthEndDate || monthMetrics.key))) + '</div>',
    '</div>',
    '<div class="profit-focus-grid-inner">',
    '  <article class="profit-stat-card">',
    '    <span>本月毛利</span>',
    '    <strong>' + profitDisplayValue(monthMetrics.totals.finalGrossProfit, monthMetrics.totals.referenceGrossProfit) + '</strong>',
    '    <small>' + (monthMetrics.profitFinalized ? ('毛利率 ' + grossMargin) : '参考值，待月底盘库后定稿') + '</small>',
    '  </article>',
    '  <article class="profit-stat-card">',
    '    <span>' + (monthMetrics.profitFinalized ? '本月实际利润' : '本月参考利润') + '</span>',
    '    <strong>' + profitDisplayValue(monthMetrics.totals.finalActualProfit, monthMetrics.totals.referenceActualProfit) + '</strong>',
    '    <small>' + (monthMetrics.profitFinalized ? ('实际利润率 ' + actualMargin) : '月底提交库存后自动定稿') + '</small>',
    '  </article>',
    '  <article class="profit-stat-card">',
    '    <span>本月销售总额</span>',
    '    <strong>' + yuan(monthSalesTotal) + '</strong>',
    '    <small>有销售 ' + monthMetrics.salesDays + ' 天</small>',
    '  </article>',
    '  <article class="profit-stat-card">',
    '    <span>本月支出拖累</span>',
    '    <strong>' + yuan(monthExpenseTotal) + '</strong>',
    '    <small>占本月销售额 ' + monthExpenseRatio + '</small>',
    '  </article>',
    '  <article class="profit-stat-card">',
    '    <span>本年毛利</span>',
    '    <strong>' + yuan(yearGrossProfit) + '</strong>',
    '    <small>只汇总已定稿月份' + (yearMetrics.finalizedMonths && yearMetrics.finalizedMonths.length ? '（' + yearMetrics.finalizedMonths.length + '个月）' : '') + '</small>',
    '  </article>',
    '  <article class="profit-stat-card">',
    '    <span>本年实际利润</span>',
    '    <strong>' + yuan(yearActualProfit) + '</strong>',
    '    <small>' + ((yearMetrics.pendingMonths && yearMetrics.pendingMonths.length)
      ? ('还有 ' + yearMetrics.pendingMonths.length + ' 个月待月底盘库')
      : ('实际利润率 ' + yearActualMargin)) + '</small>',
    '  </article>',
    '</div>'
  ].join("");

  const riskAlerts = alerts.filter(function filterRisk(item) {
    return item.tone === "danger";
  });
  const checkAlerts = alerts.filter(function filterCheck(item) {
    return item.tone === "warn" || item.tone === "info";
  });
  const normalAlerts = alerts.filter(function filterNormal(item) {
    return item.tone === "good";
  });
  byId("overviewAlerts").innerHTML = [
    renderAlertGroup("风险提醒", riskAlerts, "alert-group-risk"),
    renderAlertGroup("需要核对", checkAlerts, "alert-group-check"),
    renderAlertGroup("正常", normalAlerts, "alert-group-normal")
  ].join("") || '<div class="empty">暂时没有可用提醒。</div>';

  const dayCards = [
    { label: "\u4eca\u65e5\u9500\u552e\u603b\u989d", value: yuan(ledger.salesTotal), sub: "\u4ee5\u5f53\u5929\u5feb\u901f\u8bb0\u8d26\u4e3a\u51c6" },
    { label: "\u4eca\u65e5\u5b9e\u9645\u6536\u6b3e", value: yuan(ledger.actualReceived), sub: "\u73b0\u91d1\u3001\u5fae\u4fe1\u3001\u652f\u4ed8\u5b9d\u3001\u4f1a\u5458\u5361" },
    { label: "\u4eca\u65e5\u652f\u51fa", value: yuan(ledger.expenseTotal), sub: "\u5f53\u5929\u652f\u51fa\u5408\u8ba1" },
    { label: "\u5f53\u65e5\u8fdb\u8d27\u652f\u51fa", value: yuan(dayPurchaseTotal), sub: "\u6309\u5f53\u5929\u8fdb\u8d27\u8bb0\u5f55\u6c47\u603b" },
    { label: "\u4eca\u65e5\u4f1a\u5458\u5361\u6536\u5165", value: yuan(ledger.memberCardAmount), sub: "\u5f53\u5929\u5df2\u8bb0\u5f55\u7684\u4f1a\u5458\u5361\u6536\u5165" }
  ];
  const monthCards = [
    { label: "\u672c\u6708\u6709\u9500\u552e\u5929\u6570", value: String(monthMetrics.salesDays), sub: "\u53ea\u7edf\u8ba1\u9500\u552e\u603b\u989d\u5927\u4e8e0\u7684\u5929" },
    { label: "\u672c\u6708\u9500\u552e\u603b\u989d", value: yuan(monthMetrics.totals.salesTotal), sub: "\u6309" + monthMetrics.key + "\u9500\u552e\u603b\u989d\u6c47\u603b" },
    { label: "\u672c\u6708\u5e73\u5747\u9500\u552e\u989d", value: yuan(monthMetrics.totals.averageSales), sub: "\u6309" + monthMetrics.key + "\u7edf\u8ba1" },
    { label: "\u672c\u6708\u4f1a\u5458\u5361\u6536\u5165", value: yuan(monthMetrics.totals.memberCardAmount), sub: "\u6309" + monthMetrics.key + "\u4f1a\u5458\u5361\u53e3\u5f84\u6c47\u603b" },
    { label: "\u672c\u6708\u603b\u8fdb\u8d27\u82b1\u8d39", value: yuan(monthMetrics.totals.purchaseTotal), sub: "\u8fdb\u8d27\u8bb0\u5f55\u6c47\u603b" },
    { label: monthMetrics.profitFinalized ? "\u672c\u6708\u6bdb\u5229\u6da6" : "\u672c\u6708\u53c2\u8003\u6bdb\u5229", value: profitDisplayValue(monthMetrics.totals.finalGrossProfit, monthMetrics.totals.referenceGrossProfit), sub: monthMetrics.profitFinalized ? "\u5df2\u6309\u6708\u5e95\u5e93\u5b58\u5b9a\u7a3f" : "\u53c2\u8003\u503c\uff0c\u5f85\u6708\u5e95\u76d8\u5e93\u540e\u5b9a\u7a3f" },
    { label: monthMetrics.profitFinalized ? "\u672c\u6708\u5b9e\u9645\u5229\u6da6" : "\u672c\u6708\u53c2\u8003\u5229\u6da6", value: profitDisplayValue(monthMetrics.totals.finalActualProfit, monthMetrics.totals.referenceActualProfit), sub: monthMetrics.profitFinalized ? "\u6bdb\u5229\u6da6 - \u652f\u51fa" : "\u5f53\u524d\u5148\u6309\u9500\u552e - \u8fdb\u8d27 - \u652f\u51fa\u663e\u793a" }
  ];
  const yearCards = [
    { label: "\u672c\u5e74\u6709\u9500\u552e\u5929\u6570", value: String(yearMetrics.salesDays), sub: "\u53ea\u7edf\u8ba1\u9500\u552e\u603b\u989d\u5927\u4e8e0\u7684\u5929" },
    { label: "\u672c\u5e74\u9500\u552e\u603b\u989d", value: yuan(yearMetrics.totals.salesTotal), sub: "\u53ea\u6c47\u603b\u5df2\u5b9a\u7a3f\u6708\u4efd" },
    { label: "\u672c\u5e74\u5e73\u5747\u9500\u552e\u989d", value: yuan(yearMetrics.totals.averageSales), sub: "\u6309" + yearMetrics.key + "\u5e74\u7edf\u8ba1" },
    { label: "\u672c\u5e74\u4f1a\u5458\u5361\u6536\u5165", value: yuan(yearMetrics.totals.memberCardAmount), sub: "\u6309" + yearMetrics.key + "\u5e74\u4f1a\u5458\u5361\u53e3\u5f84\u6c47\u603b" },
    { label: "\u672c\u5e74\u603b\u8fdb\u8d27\u82b1\u8d39", value: yuan(yearMetrics.totals.purchaseTotal), sub: "\u8fdb\u8d27\u8bb0\u5f55\u6c47\u603b" },
    { label: "\u672c\u5e74\u6bdb\u5229\u6da6", value: yuan(yearMetrics.totals.grossProfit), sub: (yearMetrics.finalizedMonths && yearMetrics.finalizedMonths.length ? "\u5df2\u5b9a\u7a3f " + yearMetrics.finalizedMonths.length + " \u4e2a\u6708" : "\u5f53\u524d\u8fd8\u6ca1\u6709\u5b9a\u7a3f\u6708\u4efd") },
    { label: "\u672c\u5e74\u5b9e\u9645\u5229\u6da6", value: yuan(yearMetrics.totals.actualProfit), sub: (yearMetrics.pendingMonths && yearMetrics.pendingMonths.length ? "\u5f85\u76d8\u5e93\u6708\u4efd\uff1a" + yearMetrics.pendingMonths.join("\u3001") : "\u6bdb\u5229\u6da6 - \u652f\u51fa") }
  ];
  function renderMetricCards(targetId, cards) {
    byId(targetId).innerHTML = cards.map(function (item) {
      return '<article class="metric-card"><div class="label">' + item.label + '</div><div class="value">' + item.value + '</div><div class="sub">' + item.sub + "</div></article>";
    }).join("");
  }
  renderMetricCards("overviewDayCards", dayCards);
  renderMetricCards("overviewMonthCards", monthCards);
  renderMetricCards("overviewYearCards", yearCards);
  const rangeCards = rangeMetrics
    ? [
        { label: "\u533a\u95f4\u9500\u552e\u603b\u989d", value: yuan(rangeMetrics.totals.salesTotal), sub: "\u4ece" + rangeMetrics.fromDate + "\u5230" + rangeMetrics.toDate },
        { label: "\u533a\u95f4\u4f1a\u5458\u5361\u6536\u5165", value: yuan(rangeMetrics.totals.memberCardAmount), sub: "\u533a\u95f4\u5185\u4f1a\u5458\u5361\u6536\u5165\u6c47\u603b" },
        { label: "\u533a\u95f4\u652f\u51fa\u603b\u989d", value: yuan(rangeMetrics.totals.expenseTotal), sub: "\u533a\u95f4\u5185\u652f\u51fa\u8bb0\u5f55\u6c47\u603b" },
        { label: "\u533a\u95f4\u8fdb\u8d27\u603b\u989d", value: yuan(rangeMetrics.totals.purchaseTotal), sub: "\u533a\u95f4\u5185\u8fdb\u8d27\u8bb0\u5f55\u6c47\u603b" },
        { label: "\u533a\u95f4\u5e73\u5747\u9500\u552e\u989d", value: yuan(rangeMetrics.totals.averageSales), sub: rangeMetrics.salesDays + "\u4e2a\u6709\u9500\u552e\u65e5" },
        { label: "\u533a\u95f4\u6bdb\u5229\u6da6", value: yuan(rangeMetrics.totals.grossProfit), sub: "\u9500\u552e - \u8fdb\u8d27" },
        { label: "\u533a\u95f4\u5b9e\u9645\u5229\u6da6", value: yuan(rangeMetrics.totals.actualProfit), sub: "\u6bdb\u5229\u6da6 - \u652f\u51fa" },
        { label: "\u533a\u95f4\u5b9e\u9645\u6536\u6b3e", value: yuan(rangeMetrics.totals.actualReceived), sub: "\u6309\u8bb0\u8d26\u5df2\u5f55\u5165\u7684\u5b9e\u6536\u53e3\u5f84" }
      ]
    : [];
  renderMetricCards("overviewRangeCards", rangeCards);
  byId("overviewRangeMeta").textContent = rangeMetrics
    ? "\u67e5\u8be2\u533a\u95f4\uff1a" + rangeMetrics.fromDate + " \u81f3 " + rangeMetrics.toDate + "\uff0c\u6709\u9500\u552e\u6570\u636e " + rangeMetrics.salesDays + " \u5929\u3002"
    : "";
  byId("topProductsTable").innerHTML = state.overviewBundle.topProducts.length
    ? tableHtml(
        ["\u5546\u54c1", "\u9500\u91cf", "\u91d1\u989d"],
        state.overviewBundle.topProducts.map(function (item) {
          return [
            item.name + ' <span class="pill">' + (item.saleMode === "weight" ? "\u6309\u91cd\u91cf" : "\u6309\u4efd\u6570") + "</span>",
            item.totalQuantity + item.unit,
            yuan(item.totalAmount)
          ];
        })
      )
    : '<div class="empty">\u5f53\u5929\u8fd8\u6ca1\u6709\u5355\u54c1\u9500\u552e\u6570\u636e\u3002</div>';

  byId("expenseSnapshot").innerHTML = (state.overviewBundle.expenses || []).length
    ? '<div class="snapshot-list">' + (state.overviewBundle.expenses || []).map(function (item) {
        return '<div class="snapshot-item"><span>' + expenseTypeText(item.expenseType, item.expenseLabel) + (item.note ? " | " + item.note : "") + "</span><strong>" + yuan(item.amount) + "</strong></div>";
      }).join("") + "</div>"
    : '<div class="empty">\u5f53\u5929\u8fd8\u6ca1\u6709\u652f\u51fa\u8bb0\u5f55\u3002</div>';
}

function fillLedgerForm() {
  if (!state.ledgerBundle) {
    return;
  }
  const ledger = state.ledgerBundle.ledger;
  const form = byId("ledgerForm");
  ["salesTotal", "actualReceived", "cashAmount", "wechatAmount", "alipayAmount", "memberCardAmount", "refundAmount", "roundingAmount", "inventoryAmount"].forEach(function (key) {
    form.elements[key].value = ledger[key];
  });
  form.elements.note.value = ledger.note || "";
  updateInventoryAmountFieldState();
}

function updateInventoryAmountFieldState() {
  const form = byId("ledgerForm");
  if (!form) {
    return;
  }
  const activeDate = byId("activeDate");
  const date = activeDate ? activeDate.value : "";
  const inventoryInput = form.elements.inventoryAmount;
  const hint = byId("inventoryAmountHint");
  const editable = isMonthEndDate(date);
  inventoryInput.disabled = !editable;
  if (!editable && state.ledgerBundle && state.ledgerBundle.ledger) {
    inventoryInput.value = state.ledgerBundle.ledger.inventoryAmount;
  }
  if (hint) {
    hint.textContent = inventoryAmountHintText(date);
  }
}

function updateSaleProductOptions() {
  const select = byId("saleForm").elements.productId;
  const activeProducts = state.products.filter(function (item) {
    return item.isActive;
  });
  select.innerHTML = activeProducts.map(function (item) {
    return '<option value="' + item.id + '">' + item.name + " · " + yuan(item.price) + "/" + item.unit + "</option>";
  }).join("");
}

function renderSales() {
  if (!state.ledgerBundle) {
    return;
  }
  const rows = state.ledgerBundle.sales.map(function (item) {
    return [
      item.productName,
      item.quantity + item.unit,
      yuan(item.amount),
      item.note || "-",
      '<button class="ghost small-btn" data-sale-edit="' + item.id + '">编辑</button> ' +
      '<button class="ghost small-btn" data-sale-delete="' + item.id + '">删除</button>'
    ];
  });
  byId("salesTable").innerHTML = rows.length
    ? tableHtml(["商品", "数量", "金额", "备注", "操作"], rows)
    : '<div class="empty">当天还没有单品销售记录。</div>';
}

function renderExpenses() {
  if (!state.ledgerBundle) {
    return;
  }
  const rows = state.ledgerBundle.expenses.map(function (item) {
    return [
      expenseTypeText(item.expenseType, item.expenseLabel),
      item.excludeFromAccounting ? "个人记录" : "计入账目",
      yuan(item.amount),
      item.note || "-",
      '<button class="ghost small-btn" data-expense-edit="' + item.id + '">编辑</button> ' +
      '<button class="ghost small-btn" data-expense-delete="' + item.id + '">删除</button>'
    ];
  });
  byId("expensesTable").innerHTML = rows.length
    ? tableHtml(["类型", "口径", "金额", "备注", "操作"], rows)
    : '<div class="empty">当天还没有支出记录。</div>';
}

function renderMonthlyExpenseSummary() {
  const monthlyTarget = byId("monthlyExpenseSummary");
  if (!monthlyTarget) {
    return;
  }
  const monthly = state.monthlyExpenseSummary;
  if (!monthly) {
    monthlyTarget.innerHTML = '<div class="empty">暂时还没有月度支出统计。</div>';
    return;
  }

  const overviewHtml = '<div class="report-list">' + [
    ["本月账目内支出", yuan((monthly.totals && monthly.totals.accountingAmount) || 0)],
    ["本月个人记录支出", yuan((monthly.totals && monthly.totals.personalAmount) || 0)],
    ["本月全部支出", yuan((monthly.totals && monthly.totals.totalAmount) || 0)],
    ["本月支出笔数", String((monthly.totals && monthly.totals.entryCount) || 0)],
    ["单笔平均支出", yuan((monthly.totals && monthly.totals.averageAmount) || 0)]
  ].map(function (item) {
    return '<div class="report-item"><span>' + item[0] + '</span><strong>' + item[1] + '</strong></div>';
  }).join("") + "</div>";

  const typeHtml = monthly.typeSummary && monthly.typeSummary.length
    ? reportSectionHtml("按类型汇总", tableHtml(
        ["支出类型", "账目内", "个人记录", "全部金额", "本月笔数"],
        monthly.typeSummary.map(function (item) {
          return [expenseTypeText(item.expenseType, item.expenseLabel), yuan(item.accountingAmount || 0), yuan(item.personalAmount || 0), yuan(item.amount), String(item.entryCount)];
        })
      ))
    : reportSectionHtml("按类型汇总", '<div class="empty">本月还没有支出分类汇总。</div>');

  const dailyHtml = monthly.dailySummary && monthly.dailySummary.length
    ? reportSectionHtml("按日期汇总", tableHtml(
        ["日期", "账目内", "个人记录", "当日支出", "当日笔数"],
        monthly.dailySummary.map(function (item) {
          return [item.date, yuan(item.accountingAmount || 0), yuan(item.personalAmount || 0), yuan(item.amount), String(item.entryCount)];
        })
      ))
    : reportSectionHtml("按日期汇总", '<div class="empty">本月还没有每日支出统计。</div>');

  const detailHtml = monthly.entries && monthly.entries.length
    ? reportSectionHtml("支出明细", tableHtml(
        ["日期", "类型", "口径", "金额", "备注"],
        monthly.entries.map(function (item) {
          return [item.date, expenseTypeText(item.expenseType, item.expenseLabel), item.excludeFromAccounting ? "个人记录" : "计入账目", yuan(item.amount), item.note || "-"];
        })
      ))
    : reportSectionHtml("支出明细", '<div class="empty">本月还没有支出明细。</div>');

  monthlyTarget.innerHTML = overviewHtml + typeHtml + dailyHtml + detailHtml;
}

function renderPurchases() {
  const rows = state.purchases.map(function (item) {
    return [
      item.purchaseOrderNo || "-",
      item.productName,
      item.quantity + (item.unit ? "（" + item.unit + "）" : ""),
      yuan(item.unitCost),
      yuan(item.totalCost),
      item.supplier || "-",
      item.note || "-",
      '<button class="ghost small-btn" data-purchase-edit="' + item.id + '">编辑</button> ' +
      '<button class="ghost small-btn" data-purchase-delete="' + item.id + '">删除</button>'
    ];
  });
  byId("purchasesTable").innerHTML = rows.length
    ? tableHtml(["进货单号", "进货商品", "数量", "进货单价", "进货总额", "供应商", "备注", "操作"], rows)
    : '<div class="empty">当天还没有进货记录。</div>';
}

function renderProducts() {
  const rows = state.products.map(function (item) {
    return [
      item.name,
      item.keywords || "-",
      item.saleMode === "weight" ? "按重量" : "按份 / 个",
      item.unit,
      yuan(item.price),
      item.isActive ? "启用" : "停用",
      '<button class="ghost small-btn" data-product-edit="' + item.id + '">编辑</button>'
    ];
  });
  byId("productsTable").innerHTML = rows.length
    ? tableHtml(["名称", "别名/关键词", "销售方式", "单位", "默认单价", "状态", "操作"], rows)
    : '<div class="empty">还没有商品。</div>';
}

function renderPurchaseProducts() {
  const rows = state.purchaseProducts.map(function (item) {
    return [
      item.name,
      item.keywords || "-",
      item.defaultUnit || "-",
      yuan(item.lastUnitCost),
      item.lastSupplier || "-",
      item.isActive ? "启用" : "停用",
      String(item.sortOrder || 0),
      '<button class="ghost small-btn" data-purchase-product-edit="' + item.id + '">编辑</button>'
    ];
  });
  byId("purchaseProductsTable").innerHTML = rows.length
    ? tableHtml(["名称", "别名/关键词", "默认单位", "最近进价", "默认供应商", "状态", "排序", "操作"], rows)
    : '<div class="empty">还没有进货商品。</div>';
}

function renderPurchaseProducts() {
  const rows = state.purchaseProducts.map(function (item) {
    return [
      item.name,
      item.keywords || "-",
      item.defaultUnit || "-",
      yuan(item.lastUnitCost),
      item.lastSupplier || "-",
      item.isActive ? "启用" : "停用",
      String(item.sortOrder || 0),
      '<button class="ghost small-btn" data-purchase-product-edit="' + item.id + '">编辑</button> ' +
      '<button class="ghost small-btn" data-purchase-product-delete="' + item.id + '">删除</button>'
    ];
  });
  byId("purchaseProductsTable").innerHTML = rows.length
    ? tableHtml(["名称", "别名/关键词", "默认单位", "最近进价", "默认供应商", "状态", "排序", "操作"], rows)
    : '<div class="empty">还没有进货商品。</div>';
}

function renderUsers(items) {
  state.users = items;
  const rows = items.map(function (item) {
    const ownerAccount = item.role === "owner";
    const actions = ownerAccount
      ? '<span class="pill">系统</span>'
      : '<button class="ghost small-btn" data-user-edit="' + item.id + '">编辑</button> ' +
        '<button class="ghost small-btn" data-user-reset="' + item.id + '">重置密码</button> ' +
        '<button class="ghost small-btn" data-user-delete="' + item.id + '">删除</button>';
    return [
      item.name,
      item.username,
      item.storeName || "-",
      ownerAccount ? "管理员" : "店员",
      item.status === "active" ? "启用" : "停用",
      String(item.created_at || item.createdAt || "").slice(0, 10),
      actions
    ];
  });
  byId("usersTable").innerHTML = rows.length
    ? tableHtml(["姓名", "账号", "门店", "角色", "状态", "创建时间", "操作"], rows)
    : '<div class="empty">还没有账号。</div>';
}

function renderReports() {
  if (!state.monthlySummary || !isOwner()) {
    return;
  }
  const daily = state.ledgerBundle.ledger;
  byId("dailyReport").innerHTML = '<div class="report-list">' + [
    ["销售总额", yuan(daily.salesTotal)],
    ["实际收款", yuan(daily.actualReceived)],
    ["会员卡收入", yuan(daily.memberCardAmount)],
    ["支出合计", yuan(daily.expenseTotal)],
    ["进货合计", yuan(daily.purchaseTotal)],
    ["现金 / 微信 / 支付宝 / 会员卡", yuan(daily.cashAmount) + " / " + yuan(daily.wechatAmount) + " / " + yuan(daily.alipayAmount) + " / " + yuan(daily.memberCardAmount)],
    ["退款 / 抹零", yuan(daily.refundAmount) + " / " + yuan(daily.roundingAmount)]
  ].map(function (item) {
    return '<div class="report-item"><span>' + item[0] + "</span><strong>" + item[1] + "</strong></div>";
  }).join("") + "</div>";

  const monthly = state.monthlySummary;
  const monthHtml = '<div class="report-list">' + [
    ["本月销售总额", yuan(monthly.totals.salesTotal)],
    ["本月实际收款", yuan(monthly.totals.actualReceived)],
    ["本月会员卡收入", yuan(monthly.totals.memberCardAmount)],
    ["本月支出合计", yuan(monthly.totals.expenseTotal)],
    ["本月毛利润", yuan(monthly.totals.grossProfit)],
    ["本月实际利润", yuan(monthly.totals.actualProfit)],
    ["录入天数", String(monthly.days.length)],
    ["本月进货总额", yuan((monthly.purchaseSummary && monthly.purchaseSummary.totalCost) || 0)],
    ["本月进货笔数", String((monthly.purchaseSummary && monthly.purchaseSummary.entryCount) || 0)]
  ].map(function (item) {
    return '<div class="report-item"><span>' + item[0] + "</span><strong>" + item[1] + "</strong></div>";
  }).join("") + "</div>";

  const topHtml = monthly.topProducts.length
    ? reportSectionHtml("热销商品汇总", tableHtml(
        ["热销商品", "累计销量", "累计金额"],
        monthly.topProducts.map(function (item) {
          return [item.name, item.totalQuantity + item.unit, yuan(item.totalAmount)];
        })
      ))
    : reportSectionHtml("热销商品汇总", '<div class="empty">本月还没有单品排行数据。</div>');

  const purchaseHtml = monthly.purchases && monthly.purchases.length
    ? tableHtml(
        ["日期", "门店", "进货商品", "数量", "进货总额", "供应商"],
        monthly.purchases.slice(0, 12).map(function (item) {
          return [item.date, item.storeName, item.productName, item.quantity + (item.unit ? "（" + item.unit + "）" : ""), yuan(item.totalCost), item.supplier || "-"];
        })
      )
    : '<div class="empty">本月还没有进货明细。</div>';

  byId("monthlyReport").innerHTML = monthHtml + topHtml + purchaseHtml;

  const storeTarget = byId("storeSalesSummary");
  if (storeTarget) {
    storeTarget.innerHTML = monthly.storeSalesSummary && monthly.storeSalesSummary.length
      ? tableHtml(
          ["门店", "销售总额", "实际收款", "进货总额", "毛利润"],
          monthly.storeSalesSummary.map(function (item) {
            return [item.storeName, yuan(item.salesTotal), yuan(item.actualReceived), yuan(item.purchaseTotal), yuan(item.grossProfit)];
          })
        )
      : '<div class="empty">当前是单门店视图，或暂时没有门店经营汇总数据。</div>';
  }
}

function renderReports() {
  if (!state.monthlySummary || !isOwner()) {
    return;
  }
  const daily = state.ledgerBundle.ledger;
  byId("dailyReport").innerHTML = '<div class="report-list">' + [
    ["销售总额", yuan(daily.salesTotal)],
    ["实际收款", yuan(daily.actualReceived)],
    ["会员卡收入", yuan(daily.memberCardAmount)],
    ["支出合计", yuan(daily.expenseTotal)],
    ["进货合计", yuan(daily.purchaseTotal)],
    ["现金 / 微信 / 支付宝 / 会员卡", yuan(daily.cashAmount) + " / " + yuan(daily.wechatAmount) + " / " + yuan(daily.alipayAmount) + " / " + yuan(daily.memberCardAmount)],
    ["退款 / 抹零", yuan(daily.refundAmount) + " / " + yuan(daily.roundingAmount)]
  ].map(function (item) {
    return '<div class="report-item"><span>' + item[0] + "</span><strong>" + item[1] + "</strong></div>";
  }).join("") + "</div>";

  const monthly = state.monthlySummary;
  const monthHtml = '<div class="report-list">' + [
    ["本月销售总额", yuan(monthly.totals.salesTotal)],
    ["本月实际收款", yuan(monthly.totals.actualReceived)],
    ["本月会员卡收入", yuan(monthly.totals.memberCardAmount)],
    ["本月支出合计", yuan(monthly.totals.expenseTotal)],
    ["本月进货合计", yuan(monthly.totals.purchaseTotal)],
    ["本月毛利润", yuan(monthly.totals.grossProfit)],
    ["本月实际利润", yuan(monthly.totals.actualProfit)],
    ["录入天数", String(monthly.days.length)],
    ["本月进货总额", yuan((monthly.purchaseSummary && monthly.purchaseSummary.totalCost) || 0)],
    ["本月进货单数", String((monthly.purchaseSummary && monthly.purchaseSummary.orderCount) || 0)],
    ["本月进货笔数", String((monthly.purchaseSummary && monthly.purchaseSummary.entryCount) || 0)],
    ["本月进货商品种数", String((monthly.purchaseSummary && monthly.purchaseSummary.productCount) || 0)]
  ].map(function (item) {
    return '<div class="report-item"><span>' + item[0] + "</span><strong>" + item[1] + "</strong></div>";
  }).join("") + "</div>";

  const topHtml = monthly.topProducts.length
    ? tableHtml(
        ["热销商品", "累计销量", "累计金额"],
        monthly.topProducts.map(function (item) {
          return [item.name, item.totalQuantity + item.unit, yuan(item.totalAmount)];
        })
      )
    : '<div class="empty">本月还没有单品排行数据。</div>';

  const purchaseProductSummaryHtml = monthly.purchaseProductSummary && monthly.purchaseProductSummary.length
    ? reportSectionHtml("进货商品汇总", tableHtml(
        ["进货商品", "月累计数量", "单位", "月累计进货额", "进货笔数", "最近进价", "供应商"],
        monthly.purchaseProductSummary.map(function (item) {
          return [
            item.productName,
            String(item.totalQuantity),
            item.unit || "-",
            yuan(item.totalCost),
            String(item.entryCount),
            yuan(item.lastUnitCost),
            item.supplierSummary || "-"
          ];
        })
      ))
    : reportSectionHtml("进货商品汇总", '<div class="empty">本月还没有进货商品汇总。</div>');

  const purchaseDailySummaryHtml = monthly.purchaseDailySummary && monthly.purchaseDailySummary.length
    ? reportSectionHtml("每日进货汇总", tableHtml(
        ["日期", "门店", "进货单数", "商品种数", "进货笔数", "当日累计数量", "当日进货总额"],
        monthly.purchaseDailySummary.map(function (item) {
          return [
            item.date,
            item.storeName || "-",
            String(item.orderCount || 0),
            String(item.productCount),
            String(item.entryCount),
            String(item.totalQuantity),
            yuan(item.totalCost)
          ];
        })
      ))
    : reportSectionHtml("每日进货汇总", '<div class="empty">本月还没有每日进货情况。</div>');

  const purchaseHtml = monthly.purchases && monthly.purchases.length
    ? reportSectionHtml("进货明细", tableHtml(
        ["日期", "门店", "进货单号", "进货商品", "数量", "进货总额", "供应商"],
        monthly.purchases.map(function (item) {
          return [item.date, item.storeName, item.purchaseOrderNo || "-", item.productName, item.quantity + (item.unit ? "（" + item.unit + "）" : ""), yuan(item.totalCost), item.supplier || "-"];
        })
      ))
    : reportSectionHtml("进货明细", '<div class="empty">本月还没有进货明细。</div>');

  byId("monthlyReport").innerHTML = monthHtml + topHtml + purchaseProductSummaryHtml + purchaseDailySummaryHtml + purchaseHtml;

  const storeTarget = byId("storeSalesSummary");
  if (storeTarget) {
    storeTarget.innerHTML = monthly.storeSalesSummary && monthly.storeSalesSummary.length
      ? tableHtml(
          ["门店", "销售总额", "实际收款", "进货总额", "支出总额", "经营利润"],
          monthly.storeSalesSummary.map(function (item) {
            return [item.storeName, yuan(item.salesTotal), yuan(item.actualReceived), yuan(item.purchaseTotal), yuan(item.expenseTotal || 0), yuan(item.actualProfit)];
          })
        )
      : '<div class="empty">当前是单门店视图，或暂时没有门店经营汇总数据。</div>';
  }
}

function renderOverviewV2() {
  if (!state.overviewBundle || !isOwner()) {
    return;
  }
  const ledger = state.overviewBundle.ledger;
  const overviewMetrics = state.overviewBundle.overviewMetrics || {};
  const rangeMetrics = state.overviewRange || null;
  const activeMonth = byId("activeMonth").value;
  const dayPurchaseTotal = (state.purchases || []).reduce(function sumPurchaseTotal(total, item) {
    return total + Number(item.totalCost || 0);
  }, 0);
  const monthMetrics = overviewMetrics.month && overviewMetrics.month.totals
    ? overviewMetrics.month
    : { key: activeMonth, salesDays: 0, profitFinalized: true, totals: { averageSales: 0, purchaseTotal: 0, grossProfit: 0, actualProfit: 0, referenceGrossProfit: 0, referenceActualProfit: 0 } };
  const yearMetrics = overviewMetrics.year && overviewMetrics.year.totals
    ? overviewMetrics.year
    : { key: String(activeMonth || "").slice(0, 4), salesDays: 0, finalizedMonths: [], pendingMonths: [], totals: { averageSales: 0, purchaseTotal: 0, grossProfit: 0, actualProfit: 0 } };
  const salesTotal = toNumber(ledger.salesTotal);
  const grossProfit = toNumber(ledger.grossProfit);
  const actualProfit = toNumber(ledger.actualProfit);
  const expenseTotal = toNumber(ledger.expenseTotal);
  const monthSalesTotal = toNumber(monthMetrics.totals.salesTotal);
  const monthGrossProfit = effectiveProfitNumber(monthMetrics.totals.finalGrossProfit, monthMetrics.totals.referenceGrossProfit);
  const monthActualProfit = effectiveProfitNumber(monthMetrics.totals.finalActualProfit, monthMetrics.totals.referenceActualProfit);
  const monthExpenseTotal = toNumber(monthMetrics.totals.expenseTotal);
  const yearSalesTotal = toNumber(yearMetrics.totals.salesTotal);
  const yearGrossProfit = toNumber(yearMetrics.totals.grossProfit);
  const yearActualProfit = toNumber(yearMetrics.totals.actualProfit);
  const alerts = buildOverviewAlerts(ledger, {
    salesDays: monthMetrics.salesDays,
    totals: {
      salesTotal: monthMetrics.totals.salesTotal,
      grossProfit: monthGrossProfit,
      actualProfit: monthActualProfit,
      expenseTotal: monthMetrics.totals.expenseTotal
    }
  }, dayPurchaseTotal);
  const grossMargin = formatPercent(ratioPercent(monthGrossProfit, monthSalesTotal));
  const actualMargin = formatPercent(ratioPercent(monthActualProfit, monthSalesTotal));
  const monthExpenseRatio = formatPercent(ratioPercent(monthExpenseTotal, monthSalesTotal));
  const yearActualMargin = formatPercent(ratioPercent(yearActualProfit, yearSalesTotal));

  byId("overviewProfitFocus").innerHTML = [
    '<div class="profit-focus-main">',
    '  <div class="profit-main-kicker">' + (monthMetrics.profitFinalized ? '本月实际利润' : '本月参考利润') + '</div>',
    '  <div class="profit-main-value">' + profitDisplayValue(monthMetrics.totals.finalActualProfit, monthMetrics.totals.referenceActualProfit) + '</div>',
    '  <div class="profit-main-sub">' + (monthMetrics.profitFinalized
      ? ('本月毛利 ' + yuan(monthGrossProfit) + '，再减去本月支出 ' + yuan(monthExpenseTotal))
      : ('月底库存还未提交，当前先按销售 - 进货 - 支出显示参考利润。月底盘库日：' + (monthMetrics.monthEndDate || monthMetrics.key))) + '</div>',
    '</div>',
    '<div class="profit-focus-grid-inner">',
    '  <article class="profit-stat-card">',
    '    <span>本月毛利</span>',
    '    <strong>' + profitDisplayValue(monthMetrics.totals.finalGrossProfit, monthMetrics.totals.referenceGrossProfit) + '</strong>',
    '    <small>' + (monthMetrics.profitFinalized ? ('毛利率 ' + grossMargin) : '参考值，待月底盘库后定稿') + '</small>',
    '  </article>',
    '  <article class="profit-stat-card">',
    '    <span>' + (monthMetrics.profitFinalized ? '本月实际利润' : '本月参考利润') + '</span>',
    '    <strong>' + profitDisplayValue(monthMetrics.totals.finalActualProfit, monthMetrics.totals.referenceActualProfit) + '</strong>',
    '    <small>' + (monthMetrics.profitFinalized ? ('实际利润率 ' + actualMargin) : '月底提交库存后自动定稿') + '</small>',
    '  </article>',
    '  <article class="profit-stat-card">',
    '    <span>本月销售总额</span>',
    '    <strong>' + yuan(monthSalesTotal) + '</strong>',
    '    <small>有销售 ' + monthMetrics.salesDays + ' 天</small>',
    '  </article>',
    '  <article class="profit-stat-card">',
    '    <span>本月支出拖累</span>',
    '    <strong>' + yuan(monthExpenseTotal) + '</strong>',
    '    <small>占本月销售额 ' + monthExpenseRatio + '</small>',
    '  </article>',
    '  <article class="profit-stat-card">',
    '    <span>本年毛利</span>',
    '    <strong>' + yuan(yearGrossProfit) + '</strong>',
    '    <small>只汇总已定稿月份' + (yearMetrics.finalizedMonths && yearMetrics.finalizedMonths.length ? '（' + yearMetrics.finalizedMonths.length + '个月）' : '') + '</small>',
    '  </article>',
    '  <article class="profit-stat-card">',
    '    <span>本年实际利润</span>',
    '    <strong>' + yuan(yearActualProfit) + '</strong>',
    '    <small>' + ((yearMetrics.pendingMonths && yearMetrics.pendingMonths.length) ? ('还有 ' + yearMetrics.pendingMonths.length + ' 个月待月底盘库') : ('实际利润率 ' + yearActualMargin)) + '</small>',
    '  </article>',
    '</div>'
  ].join("");

  const riskAlerts = alerts.filter(function filterRisk(item) {
    return item.tone === "danger";
  });
  const checkAlerts = alerts.filter(function filterCheck(item) {
    return item.tone === "warn" || item.tone === "info";
  });
  const normalAlerts = alerts.filter(function filterNormal(item) {
    return item.tone === "good";
  });
  byId("overviewAlerts").innerHTML = [
    renderAlertGroup("风险提醒", riskAlerts, "alert-group-risk"),
    renderAlertGroup("需要核对", checkAlerts, "alert-group-check"),
    renderAlertGroup("正常", normalAlerts, "alert-group-normal")
  ].join("") || '<div class="empty">暂时没有可用提醒。</div>';

  const dayCards = [
    { label: "今日销售总额", value: yuan(ledger.salesTotal), sub: "以当天快速记账为准" },
    { label: "今日实际收款", value: yuan(ledger.actualReceived), sub: "现金、微信、支付宝、会员卡" },
    { label: "今日支出", value: yuan(ledger.expenseTotal), sub: "当天支出合计" },
    { label: "当日进货支出", value: yuan(dayPurchaseTotal), sub: "按当天进货记录汇总" },
    { label: "今日会员卡收入", value: yuan(ledger.memberCardAmount), sub: "当天已记录的会员卡收入" }
  ];
  const monthCards = [
    { label: "本月有销售天数", value: String(monthMetrics.salesDays), sub: "只统计销售总额大于 0 的天" },
    { label: "本月销售总额", value: yuan(monthMetrics.totals.salesTotal), sub: "按 " + monthMetrics.key + " 销售总额汇总" },
    { label: "本月平均销售额", value: yuan(monthMetrics.totals.averageSales), sub: "按 " + monthMetrics.key + " 统计" },
    { label: "本月会员卡收入", value: yuan(monthMetrics.totals.memberCardAmount), sub: "按 " + monthMetrics.key + " 会员卡口径汇总" },
    { label: "本月总进货花费", value: yuan(monthMetrics.totals.purchaseTotal), sub: "进货记录汇总" },
    { label: monthMetrics.profitFinalized ? "本月毛利润" : "本月参考毛利", value: profitDisplayValue(monthMetrics.totals.finalGrossProfit, monthMetrics.totals.referenceGrossProfit), sub: monthMetrics.profitFinalized ? "已按月底库存定稿" : "参考值，待月底盘库后定稿" },
    { label: monthMetrics.profitFinalized ? "本月实际利润" : "本月参考利润", value: profitDisplayValue(monthMetrics.totals.finalActualProfit, monthMetrics.totals.referenceActualProfit), sub: monthMetrics.profitFinalized ? "毛利润 - 支出" : "当前先按销售 - 进货 - 支出显示" }
  ];
  const yearCards = [
    { label: "本年有销售天数", value: String(yearMetrics.salesDays), sub: "只统计已定稿月份里的销售天" },
    { label: "本年销售总额", value: yuan(yearMetrics.totals.salesTotal), sub: "只汇总已定稿月份" },
    { label: "本年平均销售额", value: yuan(yearMetrics.totals.averageSales), sub: "按 " + yearMetrics.key + " 年统计" },
    { label: "本年会员卡收入", value: yuan(yearMetrics.totals.memberCardAmount), sub: "按 " + yearMetrics.key + " 年会员卡口径汇总" },
    { label: "本年总进货花费", value: yuan(yearMetrics.totals.purchaseTotal), sub: "只汇总已定稿月份" },
    { label: "本年毛利润", value: yuan(yearMetrics.totals.grossProfit), sub: yearMetrics.finalizedMonths && yearMetrics.finalizedMonths.length ? ("已定稿 " + yearMetrics.finalizedMonths.length + " 个月") : "当前还没有定稿月份" },
    { label: "本年实际利润", value: yuan(yearMetrics.totals.actualProfit), sub: yearMetrics.pendingMonths && yearMetrics.pendingMonths.length ? ("待盘库月份：" + yearMetrics.pendingMonths.join("、")) : "毛利润 - 支出" }
  ];
  function renderMetricCards(targetId, cards) {
    byId(targetId).innerHTML = cards.map(function (item) {
      return '<article class="metric-card"><div class="label">' + item.label + '</div><div class="value">' + item.value + '</div><div class="sub">' + item.sub + "</div></article>";
    }).join("");
  }
  renderMetricCards("overviewDayCards", dayCards);
  renderMetricCards("overviewMonthCards", monthCards);
  renderMetricCards("overviewYearCards", yearCards);
  const rangeCards = rangeMetrics
    ? [
        { label: "区间销售总额", value: yuan(rangeMetrics.totals.salesTotal), sub: "从 " + rangeMetrics.fromDate + " 到 " + rangeMetrics.toDate },
        { label: "区间会员卡收入", value: yuan(rangeMetrics.totals.memberCardAmount), sub: "区间内会员卡收入汇总" },
        { label: "区间支出总额", value: yuan(rangeMetrics.totals.expenseTotal), sub: "区间内支出记录汇总" },
        { label: "区间进货总额", value: yuan(rangeMetrics.totals.purchaseTotal), sub: "区间内进货记录汇总" },
        { label: "区间平均销售额", value: yuan(rangeMetrics.totals.averageSales), sub: rangeMetrics.salesDays + " 个有销售日" },
        { label: "区间毛利润", value: yuan(rangeMetrics.totals.grossProfit), sub: "销售 - 进货" },
        { label: "区间实际利润", value: yuan(rangeMetrics.totals.actualProfit), sub: "毛利润 - 支出" },
        { label: "区间实际收款", value: yuan(rangeMetrics.totals.actualReceived), sub: "按记账已录入的实收口径" }
      ]
    : [];
  renderMetricCards("overviewRangeCards", rangeCards);
  byId("overviewRangeMeta").textContent = rangeMetrics
    ? ("查询区间：" + rangeMetrics.fromDate + " 至 " + rangeMetrics.toDate + "，有销售数据 " + rangeMetrics.salesDays + " 天。")
    : "";
  byId("topProductsTable").innerHTML = state.overviewBundle.topProducts.length
    ? tableHtml(
        ["商品", "销量", "金额"],
        state.overviewBundle.topProducts.map(function (item) {
          return [
            item.name + ' <span class="pill">' + (item.saleMode === "weight" ? "按重量" : "按份数") + "</span>",
            item.totalQuantity + item.unit,
            yuan(item.totalAmount)
          ];
        })
      )
    : '<div class="empty">当天还没有单品销售数据。</div>';

  byId("expenseSnapshot").innerHTML = state.overviewBundle.expenses.length
    ? '<div class="snapshot-list">' + state.overviewBundle.expenses.map(function (item) {
        return '<div class="snapshot-item"><span>' + expenseTypeText(item.expenseType, item.expenseLabel) + (item.note ? " | " + item.note : "") + "</span><strong>" + yuan(item.amount) + "</strong></div>";
      }).join("") + "</div>"
    : '<div class="empty">当天还没有支出记录。</div>';
}

function renderReportsV2() {
  if (!state.monthlySummary || !isOwner()) {
    return;
  }
  const daily = state.ledgerBundle.ledger;
  byId("dailyReport").innerHTML = '<div class="report-list">' + [
    ["销售总额", yuan(daily.salesTotal)],
    ["实际收款", yuan(daily.actualReceived)],
    ["会员卡收入", yuan(daily.memberCardAmount)],
    ["支出合计", yuan(daily.expenseTotal)],
    ["进货合计", yuan(daily.purchaseTotal)],
    ["现金 / 微信 / 支付宝 / 会员卡", yuan(daily.cashAmount) + " / " + yuan(daily.wechatAmount) + " / " + yuan(daily.alipayAmount) + " / " + yuan(daily.memberCardAmount)],
    ["退款 / 抹零", yuan(daily.refundAmount) + " / " + yuan(daily.roundingAmount)]
  ].map(function (item) {
    return '<div class="report-item"><span>' + item[0] + "</span><strong>" + item[1] + "</strong></div>";
  }).join("") + "</div>";

  const monthly = state.monthlySummary;
  const monthHtml = '<div class="report-list">' + [
    ["本月销售总额", yuan(monthly.totals.salesTotal)],
    ["本月实际收款", yuan(monthly.totals.actualReceived)],
    ["本月会员卡收入", yuan(monthly.totals.memberCardAmount)],
    ["本月支出合计", yuan(monthly.totals.expenseTotal)],
    ["本月进货合计", yuan(monthly.totals.purchaseTotal)],
    ["利润状态", monthly.profitFinalized ? "已定稿" : "参考值（待月底盘库）"],
    [monthly.profitFinalized ? "本月毛利润" : "本月参考毛利", profitDisplayValue(monthly.totals.finalGrossProfit, monthly.totals.referenceGrossProfit)],
    [monthly.profitFinalized ? "本月实际利润" : "本月参考利润", profitDisplayValue(monthly.totals.finalActualProfit, monthly.totals.referenceActualProfit)],
    ["录入天数", String(monthly.days.length)],
    ["本月进货总额", yuan((monthly.purchaseSummary && monthly.purchaseSummary.totalCost) || 0)],
    ["本月进货单数", String((monthly.purchaseSummary && monthly.purchaseSummary.orderCount) || 0)],
    ["本月进货笔数", String((monthly.purchaseSummary && monthly.purchaseSummary.entryCount) || 0)],
    ["本月进货商品种数", String((monthly.purchaseSummary && monthly.purchaseSummary.productCount) || 0)]
  ].map(function (item) {
    return '<div class="report-item"><span>' + item[0] + "</span><strong>" + item[1] + "</strong></div>";
  }).join("") + "</div>";

  const topHtml = monthly.topProducts.length
    ? tableHtml(
        ["热销商品", "累计销量", "累计金额"],
        monthly.topProducts.map(function (item) {
          return [item.name, item.totalQuantity + item.unit, yuan(item.totalAmount)];
        })
      )
    : '<div class="empty">本月还没有单品排行数据。</div>';

  const purchaseProductSummaryHtml = monthly.purchaseProductSummary && monthly.purchaseProductSummary.length
    ? reportSectionHtml("进货商品汇总", tableHtml(
        ["进货商品", "月累计数量", "单位", "月累计进货额", "进货笔数", "最近进价", "供应商"],
        monthly.purchaseProductSummary.map(function (item) {
          return [
            item.productName,
            String(item.totalQuantity),
            item.unit || "-",
            yuan(item.totalCost),
            String(item.entryCount),
            yuan(item.lastUnitCost),
            item.supplierSummary || "-"
          ];
        })
      ))
    : reportSectionHtml("进货商品汇总", '<div class="empty">本月还没有进货商品汇总。</div>');

  const purchaseDailySummaryHtml = monthly.purchaseDailySummary && monthly.purchaseDailySummary.length
    ? reportSectionHtml("每日进货汇总", tableHtml(
        ["日期", "门店", "进货单数", "商品种数", "进货笔数", "当日累计数量", "当日进货总额"],
        monthly.purchaseDailySummary.map(function (item) {
          return [
            item.date,
            item.storeName || "-",
            String(item.orderCount || 0),
            String(item.productCount),
            String(item.entryCount),
            String(item.totalQuantity),
            yuan(item.totalCost)
          ];
        })
      ))
    : reportSectionHtml("每日进货汇总", '<div class="empty">本月还没有每日进货情况。</div>');

  const purchaseHtml = monthly.purchases && monthly.purchases.length
    ? reportSectionHtml("进货明细", tableHtml(
        ["日期", "门店", "进货单号", "进货商品", "数量", "进货总额", "供应商"],
        monthly.purchases.map(function (item) {
          return [item.date, item.storeName, item.purchaseOrderNo || "-", item.productName, item.quantity + (item.unit ? "（" + item.unit + "）" : ""), yuan(item.totalCost), item.supplier || "-"];
        })
      ))
    : reportSectionHtml("进货明细", '<div class="empty">本月还没有进货明细。</div>');

  byId("monthlyReport").innerHTML = monthHtml + topHtml + purchaseProductSummaryHtml + purchaseDailySummaryHtml + purchaseHtml;

  const storeTarget = byId("storeSalesSummary");
  if (storeTarget) {
    storeTarget.innerHTML = monthly.storeSalesSummary && monthly.storeSalesSummary.length
      ? tableHtml(
          ["门店", "利润状态", "销售总额", "实际收款", "进货总额", "支出总额", "经营利润"],
          monthly.storeSalesSummary.map(function (item) {
            return [
              item.storeName,
              item.profitFinalized ? "已定稿" : "参考值",
              yuan(item.salesTotal),
              yuan(item.actualReceived),
              yuan(item.purchaseTotal),
              yuan(item.expenseTotal || 0),
              profitDisplayValue(item.finalActualProfit, item.referenceActualProfit)
            ];
          })
        )
      : '<div class="empty">当前是单门店视图，或暂时没有门店经营汇总数据。</div>';
  }
}

function renderSummaryCards(targetId, summary) {
  const cards = [
    { label: "当前周期", value: yuan(summary.currentTotal) },
    { label: "上一周期", value: yuan(summary.previousTotal) },
    { label: "增减金额", value: yuan(summary.delta) },
    { label: "环比变化", value: percentText(summary.deltaPercent) }
  ];
  byId(targetId).innerHTML = cards.map(function (item) {
    return '<article class="metric-card"><div class="label">' + item.label + '</div><div class="value">' + item.value + "</div></article>";
  }).join("");
}

function renderBarChart(targetId, series) {
  if (!series || !series.length) {
    byId(targetId).innerHTML = '<div class="empty">当前没有足够的数据可展示。</div>';
    return;
  }
  const maxValue = Math.max.apply(null, series.map(function (item) {
    return item.value;
  }));
  const chartMinWidth = Math.max(series.length * 70, 1000);
  byId(targetId).innerHTML = '<div class="chart-shell"><div class="chart-grid" style="min-width:' + chartMinWidth + 'px">' + series.map(function (item) {
    const height = maxValue === 0 ? 6 : Math.max(6, Math.round((item.value / maxValue) * 220));
    return '<div class="chart-bar-wrap"><div class="chart-value">' + yuan(item.value) + '</div><div class="chart-bar" style="height:' + height + 'px"></div><div class="chart-label">' + item.label + '</div></div>';
  }).join("") + "</div></div>";
}

function syncAnalyticsControls() {
  document.querySelectorAll(".analytics-toggle").forEach(function (button) {
    button.classList.toggle("active", button.dataset.analyticsMetric === state.analytics.metric);
  });
  document.querySelectorAll(".analytics-range").forEach(function (button) {
    button.classList.toggle("active", Number(button.dataset.analyticsRange) === state.analytics.dailyRange);
  });
}

function renderAnalytics() {
  if (!isOwner() || !state.analytics.data) {
    return;
  }
  syncAnalyticsControls();
  renderSummaryCards("analyticsDailyCards", state.analytics.data.daily.summary);
  renderSummaryCards("analyticsMonthlyCards", state.analytics.data.monthly.summary);
  renderBarChart("analyticsDailyChart", state.analytics.data.daily.series);
  renderBarChart("analyticsMonthlyChart", state.analytics.data.monthly.series);
}

function guessReceiptLineAmount(line) {
  const text = String(line || "");
  const decimalMatches = text.match(/\d+\.\d{1,2}/g) || [];
  if (decimalMatches.length) {
    return decimalMatches[decimalMatches.length - 1];
  }
  const compactMatch = text.match(/(?:¥|#)\s*(\d{3,6})(?!\d)/);
  if (compactMatch) {
    const compactValue = Number(compactMatch[1]);
    return compactValue >= 100 ? (compactValue / 100).toFixed(2) : String(compactValue);
  }
  return "";
}

function guessReceiptLineQuantity(line) {
  const text = String(line || "");
  const unitMatch = text.match(/(\d+(?:\.\d+)?)\s*(斤|公斤|kg|KG|个|只|包|盒|袋|桶|瓶|箱|条|份)/);
  if (unitMatch) {
    return unitMatch[1];
  }
  const numbers = text.match(/\d+(?:\.\d+)?/g) || [];
  if (!numbers.length) {
    return "";
  }
  const firstUseful = numbers.find(function (item) {
    return String(item).length <= 3 || String(item).includes(".");
  });
  return firstUseful || "";
}

function productOptionsHtml(selectedProductId) {
  const options = ['<option value="">请选择商品</option>'];
  state.products.forEach(function (product) {
    const selected = String(product.id) === String(selectedProductId || "") ? " selected" : "";
    options.push('<option value="' + product.id + '"' + selected + '>' + product.name + " / " + product.unit + "</option>");
  });
  return options.join("");
}

function recommendationButtonsHtml(items, rowIndex) {
  if (!items || !items.length) {
    return '<span class="subtle-inline">无推荐</span>';
  }
  return items.map(function (item) {
    return '<button type="button" class="ghost small-btn receipt-recommend-btn" data-receipt-recommend-row="' + rowIndex + '" data-receipt-recommend-product="' + item.productId + '">' +
      item.productName + " (" + item.score + ")</button>";
  }).join(" ");
}

function buildReceiptReviewItems() {
  const matched = (state.receiptScan.recognizedItems || []).map(function (item) {
    return {
      productId: item.productId,
      quantity: item.quantity,
      amount: item.amount === null ? "" : item.amount,
      unit: item.unit || "",
      confidence: item.confidence || "-",
      sourceLine: item.sourceLine || "",
      matchStatus: "自动匹配",
      recommendedProducts: []
    };
  });
  const sourceUnmatchedItems = Array.isArray(state.receiptScan.unmatchedItems)
    ? state.receiptScan.unmatchedItems
    : (state.receiptScan.unmatchedLines || []).map(function (line) {
        return {
          sourceLine: line,
          guessedQuantity: guessReceiptLineQuantity(line),
          guessedAmount: guessReceiptLineAmount(line),
          recommendedProducts: []
        };
      });
  const manual = sourceUnmatchedItems.map(function (item) {
    return {
      productId: "",
      quantity: item.guessedQuantity || guessReceiptLineQuantity(item.sourceLine),
      amount: item.guessedAmount === null || item.guessedAmount === undefined ? guessReceiptLineAmount(item.sourceLine) : item.guessedAmount,
      unit: "",
      confidence: "-",
      sourceLine: item.sourceLine,
      matchStatus: "待手动匹配",
      recommendedProducts: item.recommendedProducts || []
    };
  });
  return matched.concat(manual);
}

function renderReceiptRecognition() {
  const target = byId("receiptRecognitionResult");
  const rawTarget = byId("receiptRawText");
  if (!target || !rawTarget) {
    return;
  }
  if (!state.receiptScan) {
    target.innerHTML = '<div class="empty">上传小票后，这里会显示识别出的单品和数量。</div>';
    rawTarget.innerHTML = "";
    return;
  }

  const reviewItems = buildReceiptReviewItems();
  if (!reviewItems.length) {
    target.innerHTML = '<div class="empty">这张小票暂时没有识别出可导入的内容，请换更清晰的小票，或手动录入。</div>';
  } else {
    const rows = reviewItems.map(function (item, index) {
      const statusHtml = item.matchStatus === "待手动匹配"
        ? '<span data-receipt-status="' + index + '">待手动匹配</span>'
        : item.matchStatus;
      return [
        '<select class="receipt-select" data-receipt-product="' + index + '">' + productOptionsHtml(item.productId) + "</select>",
        '<input class="receipt-input" data-receipt-quantity="' + index + '" type="number" step="0.01" value="' + item.quantity + '">',
        '<input class="receipt-input" data-receipt-amount="' + index + '" type="number" step="0.01" value="' + item.amount + '">',
        statusHtml,
        item.matchStatus === "待手动匹配" ? recommendationButtonsHtml(item.recommendedProducts, index) : "-",
        String(item.confidence || "-"),
        item.sourceLine || "-"
      ];
    });
    target.innerHTML =
      '<div class="status-box">自动匹配不到的行，你可以直接点推荐商品，或从下拉框手动选择后再导入。</div>' +
      tableHtml(["匹配商品", "数量/重量", "成交金额", "匹配状态", "推荐商品", "匹配分数", "识别行"], rows) +
      '<div class="form-actions" style="margin-top:12px;"><button type="button" id="importReceiptBtn" class="primary">导入到当天单品销售</button></div>';
  }

  const unmatchedLines = Array.isArray(state.receiptScan.unmatchedItems)
    ? state.receiptScan.unmatchedItems.map(function (item) { return item.sourceLine; })
    : (state.receiptScan.unmatchedLines || []);
  const unmatched = unmatchedLines.length
    ? "<strong>未自动匹配内容：</strong>\n" + unmatchedLines.join("\n")
    : "";
  rawTarget.innerHTML = '<div class="status-box"><div><strong>OCR 原文：</strong></div><pre class="receipt-pre">' +
    ((state.receiptScan.rawText || "").trim() || "无") +
    "</pre>" + (unmatched ? '<pre class="receipt-pre unmatched-pre">' + unmatched + "</pre>" : "") + "</div>";
}

function syncReceiptRowStatus(rowIndex, text) {
  const statusNode = document.querySelector('[data-receipt-status="' + rowIndex + '"]');
  if (statusNode) {
    statusNode.textContent = text || "已手动匹配";
  }
}

function collectReceiptImportItems() {
  if (!state.receiptScan) {
    return [];
  }
  return buildReceiptReviewItems().map(function (item, index) {
    const productInput = document.querySelector('[data-receipt-product="' + index + '"]');
    const quantityInput = document.querySelector('[data-receipt-quantity="' + index + '"]');
    const amountInput = document.querySelector('[data-receipt-amount="' + index + '"]');
    return {
      productId: productInput ? productInput.value : item.productId,
      quantity: quantityInput ? quantityInput.value : item.quantity,
      amount: amountInput ? amountInput.value : item.amount,
      sourceLine: item.sourceLine
    };
  }).filter(function (item) {
    return item.productId && Number(item.quantity) > 0;
  });
}

function resetProductForm() {
  const form = byId("productForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.isActive.checked = true;
}

function resetPurchaseProductForm() {
  const form = byId("purchaseProductForm");
  if (!form) {
    return;
  }
  form.reset();
  form.elements.id.value = "";
  form.elements.isActive.checked = true;
  form.elements.sortOrder.value = "0";
}

function resetSaleForm() {
  const form = byId("saleForm");
  form.reset();
  form.elements.id.value = "";
  updateSaleProductOptions();
}

function readPurchaseLineFromForm(form) {
  const productName = String(form.elements.productName.value || "").trim();
  const quantity = Number(form.elements.quantity.value || 0);
  const unitCost = Number(form.elements.unitCost.value || 0);
  if (!productName || quantity <= 0) {
    return null;
  }
  return {
    productName: productName,
    quantity: quantity,
    unit: String(form.elements.unit.value || "").trim(),
    unitCost: unitCost,
    totalCost: form.elements.totalCost.value === ""
      ? Number((quantity * unitCost).toFixed(2))
      : Number(form.elements.totalCost.value || 0)
  };
}

function clearPurchaseLineFields(form) {
  form.elements.productName.value = "";
  form.elements.quantity.value = "";
  form.elements.unit.value = "";
  form.elements.unitCost.value = "";
  form.elements.totalCost.value = "";
  closePurchaseProductSuggestions();
}

function renderPurchaseDraft() {
  const target = byId("purchaseDraftTable");
  if (!target) {
    return;
  }
  if (!state.purchaseDraftItems.length) {
    target.innerHTML = '<div class="empty">当前还没有加入本单的商品，直接保存时会按当前表单内容记一条进货。</div>';
    return;
  }
  const rows = state.purchaseDraftItems.map(function (item, index) {
    return [
      item.productName,
      item.quantity + (item.unit ? "（" + item.unit + "）" : ""),
      yuan(item.unitCost),
      yuan(item.totalCost),
      '<button type="button" class="ghost small-btn" data-purchase-draft-remove="' + index + '">移除</button>'
    ];
  });
  target.innerHTML = tableHtml(["商品", "数量", "进货单价", "进货总额", "操作"], rows);
}

function addPurchaseDraftItem() {
  const form = byId("purchaseForm");
  const item = readPurchaseLineFromForm(form);
  if (!item) {
    showMessage("请先填写完整的商品、数量和进价，再加入本单。");
    return;
  }
  state.purchaseDraftItems.push(item);
  clearPurchaseLineFields(form);
  renderPurchaseDraft();
}

function resetPurchaseForm() {
  const form = byId("purchaseForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.purchaseOrderNo.value = "";
  state.purchaseDraftItems = [];
  renderPurchaseDraft();
  closePurchaseProductSuggestions();
}

function resetExpenseForm() {
  const form = byId("expenseForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.expenseType.value = "other_daily";
  form.elements.excludeFromAccounting.checked = false;
}

function resetUserForm() {
  const form = byId("userForm");
  if (!form) {
    return;
  }
  form.reset();
  form.elements.id.value = "";
  form.elements.status.value = "active";
  if (form.elements.storeName) {
    form.elements.storeName.value = state.selectedStore && state.selectedStore !== "all" ? state.selectedStore : "";
  }
}

function fillProductForm(productId) {
  const item = state.products.find(function (product) {
    return String(product.id) === String(productId);
  });
  if (!item) {
    return;
  }
  const form = byId("productForm");
  form.elements.id.value = item.id;
  form.elements.name.value = item.name;
  form.elements.keywords.value = item.keywords || "";
  form.elements.saleMode.value = item.saleMode;
  form.elements.unit.value = item.unit;
  form.elements.price.value = item.price;
  form.elements.sortOrder.value = item.sortOrder;
  form.elements.isActive.checked = item.isActive;
  setSection("productsSection");
}

function fillPurchaseProductForm(purchaseProductId) {
  const item = state.purchaseProducts.find(function (product) {
    return String(product.id) === String(purchaseProductId);
  });
  if (!item) {
    return;
  }
  const form = byId("purchaseProductForm");
  if (!form) {
    showMessage("进货商品表单未加载，请刷新页面后重试。");
    return;
  }
  form.elements.id.value = item.id;
  form.elements.name.value = item.name;
  form.elements.keywords.value = item.keywords || "";
  form.elements.defaultUnit.value = item.defaultUnit || "";
  form.elements.lastUnitCost.value = item.lastUnitCost;
  form.elements.lastSupplier.value = item.lastSupplier || "";
  form.elements.sortOrder.value = item.sortOrder || 0;
  form.elements.isActive.checked = item.isActive;
  setSection("purchaseProductsSection");
}

function fillSaleForm(saleId) {
  const item = state.ledgerBundle.sales.find(function (sale) {
    return String(sale.id) === String(saleId);
  });
  if (!item) {
    return;
  }
  const form = byId("saleForm");
  form.elements.id.value = item.id;
  form.elements.productId.value = item.productId;
  form.elements.quantity.value = item.quantity;
  form.elements.amount.value = item.amount;
  form.elements.note.value = item.note || "";
  setSection("salesSection");
}

function fillPurchaseForm(purchaseId) {
  const item = state.purchases.find(function (entry) {
    return String(entry.id) === String(purchaseId);
  });
  if (!item) {
    return;
  }
  const form = byId("purchaseForm");
  form.elements.id.value = item.id;
  form.elements.purchaseOrderNo.value = item.purchaseOrderNo || "";
  form.elements.productName.value = item.productName;
  form.elements.quantity.value = item.quantity;
  form.elements.unit.value = item.unit || "";
  form.elements.unitCost.value = item.unitCost;
  form.elements.totalCost.value = item.totalCost;
  form.elements.supplier.value = item.supplier || "";
  form.elements.note.value = item.note || "";
  state.purchaseDraftItems = [];
  renderPurchaseDraft();
  closePurchaseProductSuggestions();
  setSection("purchasesSection");
}

function fillExpenseForm(expenseId) {
  const item = state.ledgerBundle.expenses.find(function (expense) {
    return String(expense.id) === String(expenseId);
  });
  if (!item) {
    return;
  }
  const form = byId("expenseForm");
  form.elements.id.value = item.id;
  form.elements.expenseType.value = item.expenseType;
  form.elements.amount.value = item.amount;
  form.elements.excludeFromAccounting.checked = !!item.excludeFromAccounting;
  form.elements.note.value = item.note || "";
  setSection("expensesSection");
}

function fillUserForm(userId) {
  const item = state.users.find(function (user) {
    return String(user.id) === String(userId);
  });
  if (!item || item.role === "owner") {
    return;
  }
  const form = byId("userForm");
  form.elements.id.value = item.id;
  form.elements.name.value = item.name;
  form.elements.username.value = item.username;
  form.elements.password.value = "";
  form.elements.storeName.value = item.storeName || "";
  form.elements.status.value = item.status;
  setSection("usersSection");
}

async function loadUsersIfNeeded() {
  if (!isOwner()) {
    return;
  }
  const payload = await request("/api/users");
  state.stores = Array.isArray(payload.stores) ? payload.stores : [];
  renderUsers(payload.items);
  renderStoreFilter();
}

function getOverviewRangeQuery() {
  const start = byId("overviewRangeStart");
  const end = byId("overviewRangeEnd");
  if (!start || !end) {
    return "fromDate=" + encodeURIComponent(currentMonth() + "-01") + "&toDate=" + encodeURIComponent(currentDate());
  }
  const fromDate = start.value || currentMonth() + "-01";
  const toDate = end.value || currentDate();
  return "fromDate=" + encodeURIComponent(fromDate) + "&toDate=" + encodeURIComponent(toDate);
}

async function loadDashboardData() {
  const date = byId("activeDate").value;
  const storeQuery = getStoreQuery();
  const requests = [
    request("/api/products?includeInactive=" + (isOwner() ? "true" : "false")),
    request("/api/purchase-products?includeInactive=" + (isOwner() ? "true" : "false")),
    request("/api/ledger/" + date + (storeQuery ? "?" + storeQuery : "")),
    request("/api/purchases/" + date + (storeQuery ? "?" + storeQuery : "")),
    request("/api/expenses-monthly?month=" + encodeURIComponent(byId("activeMonth").value) + (storeQuery ? "&" + storeQuery : ""))
  ];
  if (isOwner()) {
    requests.push(request("/api/ledger/" + date + "?storeName=all&month=" + encodeURIComponent(byId("activeMonth").value)));
    requests.push(request("/api/reports/monthly?month=" + byId("activeMonth").value + (storeQuery ? "&" + storeQuery : "")));
    requests.push(request("/api/overview-range?" + getOverviewRangeQuery() + (storeQuery ? "&" + storeQuery : "")));
    requests.push(
      request(
        "/api/analytics?metric=" + state.analytics.metric +
        "&dailyRange=" + state.analytics.dailyRange +
        "&endDate=" + byId("activeDate").value +
        "&monthEnd=" + byId("activeMonth").value +
        (storeQuery ? "&" + storeQuery : "")
      )
    );
  }
  const results = await Promise.all(requests);
  state.products = results[0].items;
  state.purchaseProducts = results[1].items || [];
  state.ledgerBundle = results[2];
  state.purchases = results[3].items || [];
  state.monthlyExpenseSummary = results[4] || null;
  var purchaseProductInput = byId("purchaseProductNameInput");
  if (purchaseProductInput && normalizeProductMatchText(purchaseProductInput.value)) {
    updatePurchaseProductSuggestions(purchaseProductInput.value, state.purchaseAutocomplete.highlightedIndex);
  } else {
    closePurchaseProductSuggestions();
  }
  state.overviewBundle = isOwner() ? results[5] : results[2];
  state.monthlySummary = isOwner() ? results[6] : null;
  state.overviewRange = isOwner() ? results[7] : null;
  state.analytics.data = isOwner() ? results[8] : null;
  updateSaleProductOptions();
  fillLedgerForm();
  renderSales();
  renderPurchases();
  renderPurchaseDraft();
  renderReceiptRecognition();
  renderExpenses();
  renderMonthlyExpenseSummary();
  if (isOwner()) {
    renderOverviewV2();
    renderProducts();
    renderPurchaseProducts();
    renderReportsV2();
    renderAnalytics();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  byId("loginError").textContent = "";
  try {
    const form = event.currentTarget;
    const payload = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: form.elements.username.value.trim(),
        password: form.elements.password.value
      })
    });
    state.token = payload.token;
    state.user = payload.user;
    localStorage.setItem("ledger_token", state.token);
    await afterLogin();
  } catch (error) {
    byId("loginError").textContent = error.message;
  }
}

async function afterLogin() {
  byId("loginView").classList.add("hidden");
  byId("dashboardView").classList.remove("hidden");
  byId("welcomeText").textContent = state.user.name + "，欢迎回来";
  byId("activeDate").value = currentDate();
  byId("activeMonth").value = currentMonth();
  if (isOwner()) {
    byId("overviewRangeStart").value = currentMonth() + "-01";
    byId("overviewRangeEnd").value = currentDate();
  }
  if (isOwner()) {
    await loadUsersIfNeeded();
  }
  updateOwnerVisibility();
  setSection(isOwner() ? "overviewSection" : "ledgerSection");
  await loadDashboardData();
  if (isOwner()) {
    resetUserForm();
  }
}

function logout() {
  state.token = "";
  state.user = null;
  state.users = [];
  state.stores = [];
  state.selectedStore = "";
  state.products = [];
  state.purchaseProducts = [];
  state.overviewBundle = null;
  state.overviewRange = null;
  state.ledgerBundle = null;
  state.purchases = [];
  state.monthlySummary = null;
  state.monthlyExpenseSummary = null;
  state.purchaseAutocomplete.items = [];
  state.purchaseAutocomplete.highlightedIndex = -1;
  state.purchaseAutocomplete.open = false;
  state.analytics.data = null;
  state.receiptScan = null;
  localStorage.removeItem("ledger_token");
  byId("dashboardView").classList.add("hidden");
  byId("loginView").classList.remove("hidden");
}

async function submitLedgerForm(event) {
  event.preventDefault();
  if (!ensureWritableStoreSelection()) {
    return;
  }
  const form = event.currentTarget;
  form.elements.refundAmount.value = normalizeLedgerMoneyInput(form.elements.refundAmount.value);
  form.elements.roundingAmount.value = normalizeLedgerMoneyInput(form.elements.roundingAmount.value);
  form.elements.cashAmount.value = normalizeLedgerMoneyInput(form.elements.cashAmount.value);
  form.elements.wechatAmount.value = normalizeLedgerMoneyInput(form.elements.wechatAmount.value);
  form.elements.alipayAmount.value = normalizeLedgerMoneyInput(form.elements.alipayAmount.value);
  form.elements.memberCardAmount.value = normalizeLedgerMoneyInput(form.elements.memberCardAmount.value);
  if (isMonthEndDate(byId("activeDate").value)) {
    form.elements.inventoryAmount.value = normalizeLedgerMoneyInput(form.elements.inventoryAmount.value);
  }

  syncLedgerSalesAndReceived(form);
  form.elements.salesTotal.value = normalizeLedgerMoneyInput(form.elements.salesTotal.value);
  form.elements.actualReceived.value = normalizeLedgerMoneyInput(form.elements.actualReceived.value);
  const refundAmount = form.elements.refundAmount.value;
  const roundingAmount = form.elements.roundingAmount.value;

  try {
    await request("/api/ledger/" + byId("activeDate").value, {
      method: "PUT",
      body: JSON.stringify({
        salesTotal: form.elements.salesTotal.value,
        actualReceived: form.elements.actualReceived.value,
        cashAmount: form.elements.cashAmount.value,
        wechatAmount: form.elements.wechatAmount.value,
        alipayAmount: form.elements.alipayAmount.value,
        memberCardAmount: form.elements.memberCardAmount.value,
        refundAmount: refundAmount,
        roundingAmount: roundingAmount,
        inventoryAmount: form.elements.inventoryAmount.value,
        note: form.elements.note.value,
        storeName: getSelectedStore()
      })
    });
    await loadDashboardData();
    showMessage("经营数据已保存。");
  } catch (error) {
    showMessage(error.message || "保存失败，请重试。");
  }
}

function syncLedgerSalesAndReceived(form) {
  const ledgerForm = form || byId("ledgerForm");
  if (!ledgerForm) {
    return;
  }
  ledgerForm.elements.salesTotal.value = String(ledgerForm.elements.salesTotal.value || "").trim();
  ledgerForm.elements.actualReceived.value = String(ledgerForm.elements.actualReceived.value || "").trim();
  const refundAmount = ledgerForm.elements.refundAmount.value;
  const roundingAmount = ledgerForm.elements.roundingAmount.value;
  if (money(refundAmount) !== 0 || money(roundingAmount) !== 0) {
    return;
  }
  const salesTotal = String(ledgerForm.elements.salesTotal.value || "").trim();
  const actualReceived = String(ledgerForm.elements.actualReceived.value || "").trim();
  const salesBlank = !salesTotal || money(salesTotal) === 0;
  const actualBlank = !actualReceived || money(actualReceived) === 0;
  if (salesBlank && !actualBlank) {
    ledgerForm.elements.salesTotal.value = actualReceived;
  } else if (actualBlank && !salesBlank) {
    ledgerForm.elements.actualReceived.value = salesTotal;
  }
}

function mirrorLedgerSalesAndReceived(event) {
  const form = event && event.currentTarget && event.currentTarget.form ? event.currentTarget.form : byId("ledgerForm");
  if (!form) {
    return;
  }
  if (money(form.elements.refundAmount.value) !== 0 || money(form.elements.roundingAmount.value) !== 0) {
    return;
  }
  const fieldName = event && event.currentTarget ? event.currentTarget.name : "";
  if (fieldName === "salesTotal") {
    form.elements.actualReceived.value = String(form.elements.salesTotal.value || "").trim();
  } else if (fieldName === "actualReceived") {
    form.elements.salesTotal.value = String(form.elements.actualReceived.value || "").trim();
  }
}

function syncLedgerSalesAndReceivedOnInput(event) {
  const form = event && event.currentTarget && event.currentTarget.form ? event.currentTarget.form : byId("ledgerForm");
  if (!form) {
    return;
  }
  const fieldName = event && event.currentTarget ? event.currentTarget.name : "";
  if (fieldName === "salesTotal" || fieldName === "actualReceived") {
    mirrorLedgerSalesAndReceived(event);
    return;
  }
  syncLedgerSalesAndReceived(form);
}

async function submitSaleForm(event) {
  event.preventDefault();
  if (!ensureWritableStoreSelection()) {
    return;
  }
  const form = event.currentTarget;
  const editingId = form.elements.id.value;
  await request(editingId ? "/api/sales/" + editingId : "/api/sales", {
    method: editingId ? "PUT" : "POST",
    body: JSON.stringify({
      date: byId("activeDate").value,
      productId: form.elements.productId.value,
      quantity: form.elements.quantity.value,
      amount: form.elements.amount.value,
      note: form.elements.note.value,
      storeName: getSelectedStore()
    })
  });
  resetSaleForm();
  await loadDashboardData();
}

async function submitPurchaseForm(event) {
  event.preventDefault();
  if (!ensureWritableStoreSelection()) {
    return;
  }
  const form = event.currentTarget;
  const editingId = form.elements.id.value;
  const currentItem = readPurchaseLineFromForm(form);
  const items = editingId
    ? []
    : state.purchaseDraftItems.concat(currentItem ? [currentItem] : []);
  if (!editingId && !items.length) {
    showMessage("请至少填写一条进货商品，或先加入本单后再保存。");
    return;
  }
  const response = await request(editingId ? "/api/purchases/" + editingId : "/api/purchases", {
    method: editingId ? "PUT" : "POST",
    body: JSON.stringify({
      date: byId("activeDate").value,
      purchaseOrderNo: form.elements.purchaseOrderNo.value,
      productName: currentItem ? currentItem.productName : form.elements.productName.value,
      quantity: currentItem ? currentItem.quantity : form.elements.quantity.value,
      unit: currentItem ? currentItem.unit : String(form.elements.unit.value || "").trim(),
      unitCost: currentItem ? currentItem.unitCost : form.elements.unitCost.value,
      totalCost: currentItem ? currentItem.totalCost : form.elements.totalCost.value,
      items: editingId ? undefined : items,
      supplier: form.elements.supplier.value,
      note: form.elements.note.value,
      storeName: getSelectedStore()
    })
  });
  resetPurchaseForm();
  await loadDashboardData();
  if (response && response.createdCount > 1) {
    showMessage("已按进货单 " + response.purchaseOrderNo + " 保存 " + response.createdCount + " 个商品。");
  }
}

async function submitExpenseForm(event) {
  event.preventDefault();
  if (!ensureWritableStoreSelection()) {
    return;
  }
  const form = event.currentTarget;
  const editingId = form.elements.id.value;
  await request(editingId ? "/api/expenses/" + editingId : "/api/expenses", {
    method: editingId ? "PUT" : "POST",
    body: JSON.stringify({
      date: byId("activeDate").value,
      expenseType: form.elements.expenseType.value,
      amount: form.elements.amount.value,
      excludeFromAccounting: !!form.elements.excludeFromAccounting.checked,
      note: form.elements.note.value,
      storeName: getSelectedStore()
    })
  });
  resetExpenseForm();
  await loadDashboardData();
}

async function submitProductForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  await request("/api/products", {
    method: "POST",
    body: JSON.stringify({
      id: form.elements.id.value || undefined,
      name: form.elements.name.value,
      keywords: form.elements.keywords.value,
      saleMode: form.elements.saleMode.value,
      unit: form.elements.unit.value,
      price: form.elements.price.value,
      sortOrder: form.elements.sortOrder.value,
      isActive: form.elements.isActive.checked
    })
  });
  resetProductForm();
  await loadDashboardData();
}

async function submitPurchaseProductForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const editingId = form.elements.id.value;
  const name = String(form.elements.name.value || "").trim();
  if (!name) {
    showMessage("请先填写进货商品名称。");
    return;
  }
  try {
    const existing = !editingId
      ? state.purchaseProducts.find(function (item) {
          return String(item.name || "").trim() === name;
        })
      : null;
    const targetId = editingId || (existing ? existing.id : "");
    const response = await request(targetId ? "/api/purchase-products/" + targetId : "/api/purchase-products", {
      method: targetId ? "PUT" : "POST",
      body: JSON.stringify({
        name: name,
        keywords: form.elements.keywords.value,
        defaultUnit: form.elements.defaultUnit.value,
        lastUnitCost: form.elements.lastUnitCost.value || 0,
        lastSupplier: form.elements.lastSupplier.value,
        sortOrder: form.elements.sortOrder.value,
        isActive: form.elements.isActive.checked
      })
    });
    resetPurchaseProductForm();
    await loadDashboardData();
    if (response && response.mode === "updated" && !editingId) {
      showMessage("已存在同名进货商品，系统已直接更新原记录。");
    }
  } catch (error) {
    showMessage(error.message);
  }
}

async function submitUserForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  await request("/api/users", {
    method: "POST",
    body: JSON.stringify({
      id: form.elements.id.value || undefined,
      name: form.elements.name.value,
      username: form.elements.username.value,
      password: form.elements.password.value,
      storeName: form.elements.storeName.value,
      status: form.elements.status.value
    })
  });
  resetUserForm();
  await loadUsersIfNeeded();
  showMessage("店员账号已保存。");
}

async function submitOverviewRangeForm(event) {
  event.preventDefault();
  if (!isOwner()) {
    return;
  }
  const start = byId("overviewRangeStart").value;
  const end = byId("overviewRangeEnd").value;
  if (!start || !end) {
    showMessage("\u8bf7\u5148\u9009\u62e9\u5f00\u59cb\u65e5\u671f\u548c\u7ed3\u675f\u65e5\u671f\u3002");
    return;
  }
  if (start > end) {
    showMessage("\u5f00\u59cb\u65e5\u671f\u4e0d\u80fd\u665a\u4e8e\u7ed3\u675f\u65e5\u671f\u3002");
    return;
  }
  await loadDashboardData();
}

async function submitReceiptScan(event) {
  event.preventDefault();
  if (!ensureWritableStoreSelection()) {
    return;
  }
  const fileInput = byId("receiptImageInput");
  const file = fileInput && fileInput.files ? fileInput.files[0] : null;
  if (!file) {
    showMessage("请先选择一张小票图片。");
    return;
  }
  byId("receiptScanBtn").disabled = true;
  byId("receiptRecognitionResult").innerHTML = '<div class="empty">正在识别小票，请稍候…</div>';
  try {
    state.receiptScan = await uploadFile("/api/receipt/scan", file, {
      date: byId("activeDate").value,
      storeName: getSelectedStore()
    });
    renderReceiptRecognition();
  } catch (error) {
    state.receiptScan = null;
    renderReceiptRecognition();
    showMessage(error.message);
  } finally {
    byId("receiptScanBtn").disabled = false;
  }
}

async function importReceiptItems() {
  if (!ensureWritableStoreSelection()) {
    return;
  }
  const items = collectReceiptImportItems();
  if (!items.length) {
    showMessage("没有可导入的识别结果。");
    return;
  }
  await request("/api/receipt/import", {
    method: "POST",
    body: JSON.stringify({
      date: byId("activeDate").value,
      items: items,
      storeName: getSelectedStore()
    })
  });
  state.receiptScan = null;
  byId("receiptForm").reset();
  renderReceiptRecognition();
  await loadDashboardData();
  showMessage("小票识别结果已经导入到当天单品销售。");
}

function handlePurchaseProductInput(event) {
  updatePurchaseProductSuggestions(event.target.value);
}

function handlePurchaseProductFocus(event) {
  if (normalizeProductMatchText(event.target.value)) {
    updatePurchaseProductSuggestions(event.target.value);
  }
}

function handlePurchaseProductKeydown(event) {
  if (!state.purchaseAutocomplete.open) {
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!state.purchaseAutocomplete.items.length) {
      return;
    }
    var nextIndex = state.purchaseAutocomplete.highlightedIndex + 1;
    if (nextIndex >= state.purchaseAutocomplete.items.length) {
      nextIndex = 0;
    }
    updatePurchaseProductSuggestions(event.currentTarget.value, nextIndex);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!state.purchaseAutocomplete.items.length) {
      return;
    }
    var previousIndex = state.purchaseAutocomplete.highlightedIndex - 1;
    if (previousIndex < 0) {
      previousIndex = state.purchaseAutocomplete.items.length - 1;
    }
    updatePurchaseProductSuggestions(event.currentTarget.value, previousIndex);
    return;
  }
  if (event.key === "Enter" && state.purchaseAutocomplete.highlightedIndex >= 0) {
    event.preventDefault();
    applyPurchaseProductSuggestion(state.purchaseAutocomplete.highlightedIndex);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closePurchaseProductSuggestions();
  }
}

async function handleBodyClick(event) {
  const purchaseSuggestionIndex = event.target.getAttribute("data-purchase-suggestion");
  if (purchaseSuggestionIndex !== null) {
    applyPurchaseProductSuggestion(Number(purchaseSuggestionIndex));
    return;
  }
  if (!event.target.closest(".purchase-autocomplete")) {
    closePurchaseProductSuggestions();
  }
  const receiptRecommendRow = event.target.getAttribute("data-receipt-recommend-row");
  const receiptRecommendProduct = event.target.getAttribute("data-receipt-recommend-product");
  if (receiptRecommendRow && receiptRecommendProduct) {
    const select = document.querySelector('[data-receipt-product="' + receiptRecommendRow + '"]');
    if (select) {
      select.value = receiptRecommendProduct;
      syncReceiptRowStatus(receiptRecommendRow, "已手动匹配");
    }
    return;
  }
  if (event.target.id === "importReceiptBtn") {
    await importReceiptItems();
    return;
  }
  const purchaseDraftRemoveIndex = event.target.getAttribute("data-purchase-draft-remove");
  if (purchaseDraftRemoveIndex !== null) {
    state.purchaseDraftItems.splice(Number(purchaseDraftRemoveIndex), 1);
    renderPurchaseDraft();
    return;
  }

  const saleEditId = event.target.getAttribute("data-sale-edit");
  const saleDeleteId = event.target.getAttribute("data-sale-delete");
  const purchaseEditId = event.target.getAttribute("data-purchase-edit");
  const purchaseDeleteId = event.target.getAttribute("data-purchase-delete");
  const expenseEditId = event.target.getAttribute("data-expense-edit");
  const expenseDeleteId = event.target.getAttribute("data-expense-delete");
  const productEditId = event.target.getAttribute("data-product-edit");
  const purchaseProductEditId = event.target.getAttribute("data-purchase-product-edit");
  const purchaseProductDeleteId = event.target.getAttribute("data-purchase-product-delete");
  const userEditId = event.target.getAttribute("data-user-edit");
  const userResetId = event.target.getAttribute("data-user-reset");
  const userDeleteId = event.target.getAttribute("data-user-delete");
  const analyticsMetric = event.target.getAttribute("data-analytics-metric");
  const analyticsRange = event.target.getAttribute("data-analytics-range");

  if (analyticsMetric) {
    state.analytics.metric = analyticsMetric;
    await loadDashboardData();
    return;
  }

  if (analyticsRange) {
    state.analytics.dailyRange = Number(analyticsRange);
    await loadDashboardData();
    return;
  }

  if (saleEditId) {
    fillSaleForm(saleEditId);
    return;
  }
  if (saleDeleteId) {
    await request("/api/sales/" + saleDeleteId, { method: "DELETE" });
    await loadDashboardData();
    return;
  }
  if (purchaseEditId) {
    fillPurchaseForm(purchaseEditId);
    return;
  }
  if (purchaseDeleteId) {
    await request("/api/purchases/" + purchaseDeleteId, { method: "DELETE" });
    await loadDashboardData();
    return;
  }
  if (expenseEditId) {
    fillExpenseForm(expenseEditId);
    return;
  }
  if (expenseDeleteId) {
    await request("/api/expenses/" + expenseDeleteId, { method: "DELETE" });
    await loadDashboardData();
    return;
  }
  if (productEditId) {
    fillProductForm(productEditId);
    return;
  }
  if (purchaseProductEditId) {
    fillPurchaseProductForm(purchaseProductEditId);
    return;
  }
  if (purchaseProductDeleteId) {
    const confirmed = window.confirm("删除后，这条进货商品将从进货商品库中移除，但不会删除历史进货记录。是否继续？");
    if (!confirmed) {
      return;
    }
    await request("/api/purchase-products/" + purchaseProductDeleteId, { method: "DELETE" });
    resetPurchaseProductForm();
    await loadDashboardData();
    return;
  }
  if (userEditId) {
    fillUserForm(userEditId);
    return;
  }
  if (userResetId) {
    const nextPassword = window.prompt("请输入新的店员密码");
    if (!nextPassword) {
      return;
    }
    await request("/api/users/" + userResetId + "/reset-password", {
      method: "POST",
      body: JSON.stringify({ password: nextPassword })
    });
    showMessage("店员密码已重置。");
    return;
  }
  if (userDeleteId) {
    const confirmed = window.confirm("删除后该店员将无法再次登录，是否继续？");
    if (!confirmed) {
      return;
    }
    await request("/api/users/" + userDeleteId, { method: "DELETE" });
    resetUserForm();
    await loadUsersIfNeeded();
    showMessage("店员账号已删除。");
  }
}

function handleBodyChange(event) {
  const receiptProductRow = event.target.getAttribute("data-receipt-product");
  if (receiptProductRow !== null) {
    syncReceiptRowStatus(receiptProductRow, event.target.value ? "已手动匹配" : "待手动匹配");
  }
}

async function bootstrap() {
  ensurePurchaseProductsUi();
  bindById("loginForm", "submit", handleLogin);
  bindById("logoutBtn", "click", logout);
  bindById("refreshBtn", "click", async function () {
    if (isOwner()) {
      await loadUsersIfNeeded();
    }
    await loadDashboardData();
  });

  document.querySelectorAll(".nav-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (!btn.classList.contains("hidden")) {
        setSection(btn.dataset.section);
      }
    });
  });

  var ledgerForm = bindById("ledgerForm", "submit", submitLedgerForm);
  if (ledgerForm) {
    ledgerForm.elements.salesTotal.addEventListener("input", syncLedgerSalesAndReceivedOnInput);
    ledgerForm.elements.actualReceived.addEventListener("input", syncLedgerSalesAndReceivedOnInput);
    ledgerForm.elements.refundAmount.addEventListener("input", syncLedgerSalesAndReceivedOnInput);
    ledgerForm.elements.roundingAmount.addEventListener("input", syncLedgerSalesAndReceivedOnInput);
    ledgerForm.elements.salesTotal.addEventListener("blur", mirrorLedgerSalesAndReceived);
    ledgerForm.elements.actualReceived.addEventListener("blur", mirrorLedgerSalesAndReceived);
    ledgerForm.elements.refundAmount.addEventListener("blur", syncLedgerSalesAndReceived);
    ledgerForm.elements.roundingAmount.addEventListener("blur", syncLedgerSalesAndReceived);
  }
  bindById("saleForm", "submit", submitSaleForm);
  bindById("purchaseForm", "submit", submitPurchaseForm);
  bindById("addPurchaseDraftBtn", "click", addPurchaseDraftItem);
  bindById("purchaseProductNameInput", "input", handlePurchaseProductInput);
  bindById("purchaseProductNameInput", "focus", handlePurchaseProductFocus);
  bindById("purchaseProductNameInput", "keydown", handlePurchaseProductKeydown);
  bindById("receiptForm", "submit", submitReceiptScan);
  bindById("expenseForm", "submit", submitExpenseForm);
  bindById("productForm", "submit", submitProductForm);
  bindById("purchaseProductForm", "submit", submitPurchaseProductForm);
  bindById("userForm", "submit", submitUserForm);
  bindById("overviewRangeForm", "submit", submitOverviewRangeForm);

  bindById("resetProductBtn", "click", resetProductForm);
  bindById("resetPurchaseProductBtn", "click", resetPurchaseProductForm);
  bindById("resetSaleBtn", "click", resetSaleForm);
  bindById("resetPurchaseBtn", "click", resetPurchaseForm);
  bindById("resetExpenseBtn", "click", resetExpenseForm);
  bindById("resetUserBtn", "click", resetUserForm);
  resetPurchaseForm();
  resetPurchaseProductForm();
  resetExpenseForm();

  bindById("activeDate", "change", function () {
    state.receiptScan = null;
    renderReceiptRecognition();
    updateInventoryAmountFieldState();
    loadDashboardData();
  });
  bindById("activeMonth", "change", function () {
    if (isOwner()) {
      byId("overviewRangeStart").value = byId("activeMonth").value + "-01";
      loadDashboardData();
    }
  });
  if (byId("ownerStoreFilter")) {
    byId("ownerStoreFilter").addEventListener("change", function (event) {
      state.selectedStore = event.target.value;
      state.receiptScan = null;
      renderReceiptRecognition();
      loadDashboardData();
      resetUserForm();
    });
  }

  bindById("exportDailyBtn", "click", function () {
    downloadFile(appendStoreQuery("/api/export/daily?date=" + byId("activeDate").value), "日报-" + byId("activeDate").value + ".xlsx");
  });
  bindById("exportMonthlyBtn", "click", function () {
    downloadFile(appendStoreQuery("/api/export/monthly?month=" + byId("activeMonth").value), "月报-" + byId("activeMonth").value + ".xlsx");
  });
  bindById("importMonthlyBtn", "click", function () {
    byId("monthlyImportFile").click();
  });
  bindById("monthlyImportFile", "change", async function (event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }
    try {
      const formData = new FormData();
      formData.append("reportFile", file);
      const response = await fetch("/api/import/monthly", {
        method: "POST",
        headers: state.token ? { Authorization: "Bearer " + state.token } : {},
        body: formData
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Monthly report import failed.");
      }
      byId("activeMonth").value = payload.months[0] || byId("activeMonth").value;
      await loadDashboardData();
      showMessage("月报已导入，共 " + payload.importedRows + " 天记录。");
    } catch (error) {
      showMessage(error.message);
    } finally {
      event.target.value = "";
    }
  });

  document.body.addEventListener("click", function (event) {
    handleBodyClick(event).catch(function (error) {
      showMessage(error.message);
    });
  });
  document.body.addEventListener("change", handleBodyChange);

  if (state.token) {
    try {
      const payload = await request("/api/auth/me");
      state.user = payload.user;
      await afterLogin();
    } catch (error) {
      logout();
    }
  }
}

bootstrap().catch(function (error) {
  console.error(error);
  showMessage(error && error.message ? error.message : "页面初始化失败，请刷新页面后重试。");
});
