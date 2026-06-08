const state = {
  token: localStorage.getItem("ledger_token") || "",
  user: null,
  users: [],
  products: [],
  ledgerBundle: null,
  monthlySummary: null,
  analytics: {
    metric: "salesTotal",
    dailyRange: 30,
    data: null
  }
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
  if (!state.ledgerBundle || !isOwner()) {
    return;
  }
  const ledger = state.ledgerBundle.ledger;
  const cards = [
    { label: "今日销售总额", value: yuan(ledger.salesTotal), sub: "营业额与单品明细分开记录" },
    { label: "今日实际收款", value: yuan(ledger.actualReceived), sub: "现金、微信、支付宝" },
    { label: "今日支出", value: yuan(ledger.expenseTotal), sub: "进货与日常支出" },
    { label: "简版利润", value: yuan(ledger.profit), sub: "销售总额减去当日支出" }
  ];
  byId("overviewCards").innerHTML = cards.map(function (item) {
    return '<article class="metric-card"><div class="label">' + item.label + '</div><div class="value">' + item.value + '</div><div class="sub">' + item.sub + "</div></article>";
  }).join("");

  byId("topProductsTable").innerHTML = state.ledgerBundle.topProducts.length
    ? tableHtml(
        ["商品", "销量", "金额"],
        state.ledgerBundle.topProducts.map(function (item) {
          return [
            item.name + ' <span class="pill">' + (item.saleMode === "weight" ? "按重量" : "按份数") + "</span>",
            item.totalQuantity + item.unit,
            yuan(item.totalAmount)
          ];
        })
      )
    : '<div class="empty">当天还没有单品销售数据。</div>';

  const expenseTypeMap = { purchase: "进货支出", daily: "日常支出" };
  byId("expenseSnapshot").innerHTML = state.ledgerBundle.expenses.length
    ? '<div class="snapshot-list">' + state.ledgerBundle.expenses.map(function (item) {
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
      ? '<span class="pill">系统账号</span>'
      : '<button class="ghost small-btn" data-user-edit="' + item.id + '">编辑</button> ' +
        '<button class="ghost small-btn" data-user-reset="' + item.id + '">重置密码</button> ' +
        '<button class="ghost small-btn" data-user-delete="' + item.id + '">删除</button>';
    return [
      item.name,
      item.username,
      ownerAccount ? "店主" : "店员",
      item.status === "active" ? "启用" : "停用",
      String(item.created_at || item.createdAt || "").slice(0, 10),
      actions
    ];
  });
  byId("usersTable").innerHTML = rows.length
    ? tableHtml(["姓名", "账号", "角色", "状态", "创建时间", "操作"], rows)
    : '<div class="empty">暂无账号数据。</div>';
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
  const requests = [
    request("/api/products?includeInactive=" + (isOwner() ? "true" : "false")),
    request("/api/ledger/" + date)
  ];
  if (isOwner()) {
    requests.push(request("/api/reports/monthly?month=" + byId("activeMonth").value));
    requests.push(
      request(
        "/api/analytics?metric=" + state.analytics.metric +
        "&dailyRange=" + state.analytics.dailyRange +
        "&endDate=" + byId("activeDate").value +
        "&monthEnd=" + byId("activeMonth").value
      )
    );
  }
  const results = await Promise.all(requests);
  state.products = results[0].items;
  state.ledgerBundle = results[1];
  state.monthlySummary = isOwner() ? results[2] : null;
  state.analytics.data = isOwner() ? results[3] : null;
  updateSaleProductOptions();
  fillLedgerForm();
  renderSales();
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
  renderUsers(payload.items);
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
  updateOwnerVisibility();
  setSection(isOwner() ? "overviewSection" : "ledgerSection");
  await loadDashboardData();
  await loadUsersIfNeeded();
}

function logout() {
  state.token = "";
  state.user = null;
  state.users = [];
  state.products = [];
  state.ledgerBundle = null;
  state.monthlySummary = null;
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
      note: form.elements.note.value
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
      note: form.elements.note.value
    })
  });
  resetSaleForm();
  await loadDashboardData();
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
      note: form.elements.note.value
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
  form.elements.status.value = item.status;
  setSection("usersSection");
}

async function handleBodyClick(event) {
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
    await loadDashboardData();
    await loadUsersIfNeeded();
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
  byId("expenseForm").addEventListener("submit", submitExpenseForm);
  byId("productForm").addEventListener("submit", submitProductForm);
  byId("userForm").addEventListener("submit", submitUserForm);

  byId("resetProductBtn").addEventListener("click", resetProductForm);
  byId("resetSaleBtn").addEventListener("click", resetSaleForm);
  byId("resetExpenseBtn").addEventListener("click", resetExpenseForm);
  byId("resetUserBtn").addEventListener("click", resetUserForm);

  byId("activeDate").addEventListener("change", loadDashboardData);
  byId("activeMonth").addEventListener("change", function () {
    if (isOwner()) {
      loadDashboardData();
    }
  });

  byId("exportDailyBtn").addEventListener("click", function () {
    downloadFile("/api/export/daily?date=" + byId("activeDate").value, "日报-" + byId("activeDate").value + ".xlsx");
  });
  byId("exportMonthlyBtn").addEventListener("click", function () {
    downloadFile("/api/export/monthly?month=" + byId("activeMonth").value, "月报-" + byId("activeMonth").value + ".xlsx");
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
