const state = {
  token: localStorage.getItem("ledger_token") || "",
  user: null,
  users: [],
  stores: [],
  selectedStore: "",
  products: [],
  overviewBundle: null,
  ledgerBundle: null,
  monthlySummary: null,
  analytics: {
    metric: "salesTotal",
    dailyRange: 30,
    data: null
  },
  receiptScan: null
};

function byId(id) {
  return document.getElementById(id);
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

function renderStoreFilter() {
  const select = byId("ownerStoreFilter");
  if (!select) {
    return;
  }
  const stores = state.stores.slice();
  if (!state.selectedStore || (state.selectedStore !== "all" && stores.indexOf(state.selectedStore) === -1)) {
    state.selectedStore = stores[0] || "all";
  }
  const options = ['<option value="all">All Stores</option>'].concat(stores.map(function (storeName) {
    return '<option value="' + storeName + '">' + storeName + "</option>";
  }));
  select.innerHTML = options.join("");
  select.value = state.selectedStore || "all";
}

function yuan(value) {
  return "¥" + Number(value || 0).toFixed(2);
}

function percentText(value) {
  return value === null || value === undefined ? "新增" : value.toFixed(2) + "%";
}

function showMessage(message) {
  if (message) {
    window.alert(message);
  }
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
    throw new Error(payload.error || "请求失败");
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
  const plainMatch = contentDisposition.match(/filename=\"?([^\"]+)\"?/i);
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
    throw new Error(payload.error || "上传失败");
  }
  return payload;
}

function tableHtml(headers, rows) {
  return "<table><thead><tr>" + headers.map(function (head) {
    return "<th>" + head + "</th>";
  }).join("") + "</tr></thead><tbody>" + rows.map(function (row) {
    return "<tr>" + row.map(function (cell) {
      return "<td>" + cell + "</td>";
    }).join("") + "</tr>";
  }).join("") + "</tbody></table>";
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
  if (!owner && (!activeButton || hiddenSection || ["overviewSection", "reportsSection", "analyticsSection", "productsSection", "usersSection"].includes(activeButton.dataset.section))) {
    setSection("ledgerSection");
  }
}

function renderOverview() {
  if (!state.overviewBundle || !isOwner()) {
    return;
  }
  const ledger = state.overviewBundle.ledger;
  const cards = [
    { label: "今日销售总额", value: yuan(ledger.salesTotal), sub: "营业额与单品明细分开记录" },
    { label: "今日实际收款", value: yuan(ledger.actualReceived), sub: "现金、微信、支付宝" },
    { label: "今日支出", value: yuan(ledger.expenseTotal), sub: "进货与日常支出" },
    { label: "简版利润", value: yuan(ledger.profit), sub: "销售总额减去当日支出" }
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

  const expenseTypeMap = { purchase: "进货支出", daily: "日常支出" };
  byId("expenseSnapshot").innerHTML = state.overviewBundle.expenses.length
    ? '<div class="snapshot-list">' + state.overviewBundle.expenses.map(function (item) {
        return '<div class="snapshot-item"><span>' + expenseTypeMap[item.expenseType] + (item.note ? " · " + item.note : "") + "</span><strong>" + yuan(item.amount) + "</strong></div>";
      }).join("") + "</div>"
    : '<div class="empty">当天还没有支出记录。</div>';
}

function fillLedgerForm() {
  if (!state.ledgerBundle) {
    return;
  }
  const ledger = state.ledgerBundle.ledger;
  const form = byId("ledgerForm");
  ["salesTotal", "actualReceived", "cashAmount", "wechatAmount", "alipayAmount", "refundAmount", "roundingAmount"].forEach(function (key) {
    form.elements[key].value = ledger[key];
  });
  form.elements.note.value = ledger.note || "";
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

function guessReceiptLineAmount(line) {
  var text = String(line || "");
  var decimalMatches = text.match(/\d+\.\d{1,2}/g) || [];
  if (decimalMatches.length) {
    return decimalMatches[decimalMatches.length - 1];
  }
  var compactMatch = text.match(/(?:¥|￥|#)\s*(\d{3,6})(?!\d)/);
  if (compactMatch) {
    var compactValue = Number(compactMatch[1]);
    return compactValue >= 100 ? (compactValue / 100).toFixed(2) : String(compactValue);
  }
  return "";
}

function guessReceiptLineQuantity(line) {
  var text = String(line || "");
  var unitMatch = text.match(/(\d+(?:\.\d+)?)\s*(斤|公斤|千克|kg|KG|克|g|两|个|只|份|袋|盒|包|瓶|桶|根|串|箱)/);
  if (unitMatch) {
    return unitMatch[1];
  }
  var numbers = text.match(/\d+(?:\.\d+)?/g) || [];
  if (!numbers.length) {
    return "";
  }
  var firstUseful = numbers.find(function (item) {
    return String(item).length <= 3 || String(item).includes(".");
  });
  return firstUseful || "";
}

function productOptionsHtml(selectedProductId) {
  var options = ['<option value="">请选择商品</option>'];
  state.products.forEach(function (product) {
    var selected = String(product.id) === String(selectedProductId || "") ? " selected" : "";
    options.push('<option value="' + product.id + '"' + selected + '>' + product.name + " / " + product.unit + "</option>");
  });
  return options.join("");
}

function buildReceiptReviewItems() {
  var matched = (state.receiptScan.recognizedItems || []).map(function (item) {
    return {
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      amount: item.amount === null ? "" : item.amount,
      unit: item.unit || "",
      confidence: item.confidence || "-",
      sourceLine: item.sourceLine || "",
      matchStatus: "自动匹配"
    };
  });
  var manual = (state.receiptScan.unmatchedLines || []).map(function (line) {
    return {
      productId: "",
      productName: "",
      quantity: guessReceiptLineQuantity(line),
      amount: guessReceiptLineAmount(line),
      unit: "",
      confidence: "-",
      sourceLine: line,
      matchStatus: "待手动匹配"
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

  var reviewItems = buildReceiptReviewItems();
  if (!reviewItems.length) {
    target.innerHTML = '<div class="empty">这张小票暂时没有识别出可导入的内容，请换更清晰的小票，或手动录入。</div>';
  } else {
    const rows = reviewItems.map(function (item, index) {
      return [
        '<select class="receipt-select" data-receipt-product="' + index + '">' + productOptionsHtml(item.productId) + "</select>",
        '<input class="receipt-input" data-receipt-quantity="' + index + '" type="number" step="0.01" value="' + item.quantity + '">',
        '<input class="receipt-input" data-receipt-amount="' + index + '" type="number" step="0.01" value="' + item.amount + '">',
        item.matchStatus,
        String(item.confidence || "-"),
        item.sourceLine || "-"
      ];
    });
    target.innerHTML =
      '<div class="status-box">自动匹配不到的行，你可以直接手动选择商品后导入。</div>' +
      tableHtml(["匹配商品", "数量/重量", "成交金额", "匹配状态", "匹配分数", "识别行"], rows) +
      '<div class="form-actions" style="margin-top:12px;"><button type="button" id="importReceiptBtn" class="primary">导入到当天单品销售</button></div>';
  }

  const unmatched = (state.receiptScan.unmatchedLines || []).length
    ? "<strong>未自动匹配内容：</strong>\n" + state.receiptScan.unmatchedLines.join("\n")
    : "";
  rawTarget.innerHTML = '<div class="status-box"><div><strong>OCR 原文：</strong></div><pre class="receipt-pre">' +
    ((state.receiptScan.rawText || "").trim() || "无") +
    "</pre>" + (unmatched ? '<pre class="receipt-pre unmatched-pre">' + unmatched + "</pre>" : "") + "</div>";
}

function renderExpenses() {
  if (!state.ledgerBundle) {
    return;
  }
  const typeMap = { purchase: "进货支出", daily: "日常支出" };
  const rows = state.ledgerBundle.expenses.map(function (item) {
    return [
      typeMap[item.expenseType],
      yuan(item.amount),
      item.note || "-",
      '<button class="ghost small-btn" data-expense-edit="' + item.id + '">编辑</button> ' +
      '<button class="ghost small-btn" data-expense-delete="' + item.id + '">删除</button>'
    ];
  });
  byId("expensesTable").innerHTML = rows.length
    ? tableHtml(["类型", "金额", "备注", "操作"], rows)
    : '<div class="empty">当天还没有支出记录。</div>';
}

function renderProducts() {
  const rows = state.products.map(function (item) {
    return [
      item.name,
      item.saleMode === "weight" ? "按重量" : "按份 / 个",
      item.unit,
      yuan(item.price),
      item.isActive ? "启用" : "停用",
      '<button class="ghost small-btn" data-product-edit="' + item.id + '">编辑</button>'
    ];
  });
  byId("productsTable").innerHTML = rows.length
    ? tableHtml(["名称", "售卖方式", "单位", "默认单价", "状态", "操作"], rows)
    : '<div class="empty">还没有商品。</div>';
}

function renderUsers(items) {
  state.users = items;
  const rows = items.map(function (item) {
    const ownerAccount = item.role === "owner";
    const actions = ownerAccount
      ? '<span class="pill">System</span>'
      : '<button class="ghost small-btn" data-user-edit="' + item.id + '">Edit</button> ' +
        '<button class="ghost small-btn" data-user-reset="' + item.id + '">Reset Password</button> ' +
        '<button class="ghost small-btn" data-user-delete="' + item.id + '">Delete</button>';
    return [
      item.name,
      item.username,
      item.storeName || "-",
      ownerAccount ? "Owner" : "Staff",
      item.status === "active" ? "Active" : "Inactive",
      String(item.created_at || item.createdAt || "").slice(0, 10),
      actions
    ];
  });
  byId("usersTable").innerHTML = rows.length
    ? tableHtml(["Name", "Username", "Store", "Role", "Status", "Created", "Actions"], rows)
    : '<div class="empty">No accounts yet.</div>';
}

function renderReports() {
  if (!state.monthlySummary || !isOwner()) {
    return;
  }
  const daily = state.ledgerBundle.ledger;
  byId("dailyReport").innerHTML = '<div class="report-list">' + [
    ["销售总额", yuan(daily.salesTotal)],
    ["实际收款", yuan(daily.actualReceived)],
    ["支出合计", yuan(daily.expenseTotal)],
    ["简版利润", yuan(daily.profit)],
    ["现金 / 微信 / 支付宝", yuan(daily.cashAmount) + " / " + yuan(daily.wechatAmount) + " / " + yuan(daily.alipayAmount)],
    ["退款 / 抹零", yuan(daily.refundAmount) + " / " + yuan(daily.roundingAmount)]
  ].map(function (item) {
    return '<div class="report-item"><span>' + item[0] + "</span><strong>" + item[1] + "</strong></div>";
  }).join("") + "</div>";

  const monthly = state.monthlySummary;
  const monthHtml = '<div class="report-list">' + [
    ["本月销售总额", yuan(monthly.totals.salesTotal)],
    ["本月实际收款", yuan(monthly.totals.actualReceived)],
    ["本月支出合计", yuan(monthly.totals.expenseTotal)],
    ["本月简版利润", yuan(monthly.totals.profit)],
    ["录入天数", String(monthly.days.length)]
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
  byId("monthlyReport").innerHTML = monthHtml + topHtml;
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
  const maxValue = Math.max.apply(null, series.map(function (item) { return item.value; }));
  byId(targetId).innerHTML = '<div class="chart-shell"><div class="chart-grid">' + series.map(function (item) {
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

function updateSaleProductOptions() {
  const select = byId("saleForm").elements.productId;
  const activeProducts = state.products.filter(function (item) {
    return item.isActive;
  });
  select.innerHTML = activeProducts.map(function (item) {
    return '<option value="' + item.id + '">' + item.name + " · " + yuan(item.price) + "/" + item.unit + "</option>";
  }).join("");
}

async function loadDashboardData() {
  const date = byId("activeDate").value;
  const storeQuery = getStoreQuery();
  const requests = [
    request("/api/products?includeInactive=" + (isOwner() ? "true" : "false")),
    request("/api/ledger/" + date + (storeQuery ? "?" + storeQuery : ""))
  ];
  if (isOwner()) {
    requests.push(request("/api/ledger/" + date + "?storeName=all"));
    requests.push(request("/api/reports/monthly?month=" + byId("activeMonth").value + (storeQuery ? "&" + storeQuery : "")));
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
  state.ledgerBundle = results[1];
  state.overviewBundle = isOwner() ? results[2] : results[1];
  state.monthlySummary = isOwner() ? results[3] : null;
  state.analytics.data = isOwner() ? results[4] : null;
  updateSaleProductOptions();
  fillLedgerForm();
  renderSales();
  renderReceiptRecognition();
  renderExpenses();
  if (isOwner()) {
    renderOverview();
    renderProducts();
    renderReports();
    renderAnalytics();
  }
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

function resetProductForm() {
  const form = byId("productForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.isActive.checked = true;
}

function resetSaleForm() {
  const form = byId("saleForm");
  form.reset();
  form.elements.id.value = "";
  updateSaleProductOptions();
}

function resetExpenseForm() {
  const form = byId("expenseForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.expenseType.value = "purchase";
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
  byId("welcomeText").textContent = state.user.name + ", welcome back";
  byId("activeDate").value = currentDate();
  byId("activeMonth").value = currentMonth();
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
  state.overviewBundle = null;
  state.ledgerBundle = null;
  state.monthlySummary = null;
  state.receiptScan = null;
  localStorage.removeItem("ledger_token");
  byId("dashboardView").classList.add("hidden");
  byId("loginView").classList.remove("hidden");
}

async function submitLedgerForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  await request("/api/ledger/" + byId("activeDate").value, {
    method: "PUT",
    body: JSON.stringify({
      salesTotal: form.elements.salesTotal.value,
      actualReceived: form.elements.actualReceived.value,
      cashAmount: form.elements.cashAmount.value,
      wechatAmount: form.elements.wechatAmount.value,
      alipayAmount: form.elements.alipayAmount.value,
      refundAmount: form.elements.refundAmount.value,
      roundingAmount: form.elements.roundingAmount.value,
      note: form.elements.note.value,
      storeName: getSelectedStore()
    })
  });
  await loadDashboardData();
}

async function submitSaleForm(event) {
  event.preventDefault();
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

async function submitReceiptScan(event) {
  event.preventDefault();
  const fileInput = byId("receiptImageInput");
  const file = fileInput && fileInput.files ? fileInput.files[0] : null;
  if (!file) {
    showMessage("请先选择一张小票图片。");
    return;
  }
  byId("receiptScanBtn").disabled = true;
  byId("receiptRecognitionResult").innerHTML = '<div class="empty">正在识别小票，请稍候……</div>';
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

async function submitExpenseForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const editingId = form.elements.id.value;
  await request(editingId ? "/api/expenses/" + editingId : "/api/expenses", {
    method: editingId ? "PUT" : "POST",
    body: JSON.stringify({
      date: byId("activeDate").value,
      expenseType: form.elements.expenseType.value,
      amount: form.elements.amount.value,
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
  form.elements.saleMode.value = item.saleMode;
  form.elements.unit.value = item.unit;
  form.elements.price.value = item.price;
  form.elements.sortOrder.value = item.sortOrder;
  form.elements.isActive.checked = item.isActive;
  setSection("productsSection");
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

async function handleBodyClick(event) {
  if (event.target.id === "importReceiptBtn") {
    await importReceiptItems();
    return;
  }
  const saleEditId = event.target.getAttribute("data-sale-edit");
  const saleDeleteId = event.target.getAttribute("data-sale-delete");
  const expenseEditId = event.target.getAttribute("data-expense-edit");
  const expenseDeleteId = event.target.getAttribute("data-expense-delete");
  const productEditId = event.target.getAttribute("data-product-edit");
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
    const confirmed = window.confirm("删除后该店员将无法再登录，是否继续？");
    if (!confirmed) {
      return;
    }
    await request("/api/users/" + userDeleteId, { method: "DELETE" });
    resetUserForm();
    await loadUsersIfNeeded();
    showMessage("店员账号已删除。");
  }
}

async function bootstrap() {
  byId("loginForm").addEventListener("submit", handleLogin);
  byId("logoutBtn").addEventListener("click", logout);
  byId("refreshBtn").addEventListener("click", async function () {
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

  byId("ledgerForm").addEventListener("submit", submitLedgerForm);
  byId("saleForm").addEventListener("submit", submitSaleForm);
  byId("receiptForm").addEventListener("submit", submitReceiptScan);
  byId("expenseForm").addEventListener("submit", submitExpenseForm);
  byId("productForm").addEventListener("submit", submitProductForm);
  byId("userForm").addEventListener("submit", submitUserForm);

  byId("resetProductBtn").addEventListener("click", resetProductForm);
  byId("resetSaleBtn").addEventListener("click", resetSaleForm);
  byId("resetExpenseBtn").addEventListener("click", resetExpenseForm);
  byId("resetUserBtn").addEventListener("click", resetUserForm);

  byId("activeDate").addEventListener("change", function () {
    state.receiptScan = null;
    renderReceiptRecognition();
    loadDashboardData();
  });
  byId("activeMonth").addEventListener("change", function () {
    if (isOwner()) {
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

  byId("exportDailyBtn").addEventListener("click", function () {
    downloadFile(appendStoreQuery("/api/export/daily?date=" + byId("activeDate").value), "日报-" + byId("activeDate").value + ".xlsx");
  });
  byId("exportMonthlyBtn").addEventListener("click", function () {
    downloadFile(appendStoreQuery("/api/export/monthly?month=" + byId("activeMonth").value), "月报-" + byId("activeMonth").value + ".xlsx");
  });

  document.body.addEventListener("click", function (event) {
    handleBodyClick(event).catch(function (error) {
      showMessage(error.message);
    });
  });

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

bootstrap();
