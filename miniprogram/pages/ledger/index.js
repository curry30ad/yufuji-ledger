const { request, download } = require("../../utils/request");
const { requireLogin } = require("../../utils/auth");
const { todayText } = require("../../utils/format");

function emptyLedger(date) {
  return {
    date,
    salesTotal: "",
    actualReceived: "",
    cashAmount: "",
    wechatAmount: "",
    alipayAmount: "",
    refundAmount: "",
    roundingAmount: "",
    note: ""
  };
}

Page({
  data: {
    user: null,
    date: todayText(),
    ledger: emptyLedger(todayText()),
    sales: [],
    expenses: [],
    topProducts: [],
    products: [],
    saleForm: {
      productId: "",
      quantity: "",
      amount: "",
      note: ""
    },
    expenseForm: {
      expenseType: "purchase",
      amount: "",
      note: ""
    }
  },

  onShow() {
    if (!requireLogin()) {
      return;
    }
    this.setData({ user: getApp().globalData.user });
    this.loadProducts();
    this.loadBundle();
  },

  onDateChange(e) {
    this.setData({ date: e.detail.value });
    this.loadBundle();
  },

  onLedgerInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ["ledger." + field]: e.detail.value });
  },

  onSaleInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ["saleForm." + field]: e.detail.value });
  },

  onExpenseInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ["expenseForm." + field]: e.detail.value });
  },

  onProductPick(e) {
    const index = Number(e.detail.value);
    const product = this.data.products[index];
    this.setData({
      "saleForm.productId": product ? String(product.id) : ""
    });
  },

  onExpenseTypePick(e) {
    this.setData({
      "expenseForm.expenseType": e.detail.value === "0" ? "purchase" : "daily"
    });
  },

  async loadProducts() {
    try {
      const result = await request({ url: "/api/products" });
      this.setData({ products: result.items || [] });
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  async loadBundle() {
    try {
      const result = await request({ url: "/api/ledger/" + this.data.date });
      this.setData({
        ledger: Object.assign(emptyLedger(this.data.date), result.ledger || {}),
        sales: result.sales || [],
        expenses: result.expenses || [],
        topProducts: result.topProducts || []
      });
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  async saveLedger() {
    try {
      await request({
        url: "/api/ledger/" + this.data.date,
        method: "PUT",
        data: this.data.ledger
      });
      wx.showToast({ title: "已保存", icon: "success" });
      this.loadBundle();
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  async addSale() {
    try {
      await request({
        url: "/api/sales",
        method: "POST",
        data: Object.assign({}, this.data.saleForm, { date: this.data.date })
      });
      this.setData({
        saleForm: { productId: "", quantity: "", amount: "", note: "" }
      });
      wx.showToast({ title: "已添加", icon: "success" });
      this.loadBundle();
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  async deleteSale(e) {
    try {
      await request({
        url: "/api/sales/" + e.currentTarget.dataset.id,
        method: "DELETE"
      });
      this.loadBundle();
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  async addExpense() {
    try {
      await request({
        url: "/api/expenses",
        method: "POST",
        data: Object.assign({}, this.data.expenseForm, { date: this.data.date })
      });
      this.setData({
        expenseForm: { expenseType: "purchase", amount: "", note: "" }
      });
      wx.showToast({ title: "已添加", icon: "success" });
      this.loadBundle();
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  async deleteExpense(e) {
    try {
      await request({
        url: "/api/expenses/" + e.currentTarget.dataset.id,
        method: "DELETE"
      });
      this.loadBundle();
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  exportDaily() {
    if (this.data.user.role !== "owner") {
      return;
    }
    download("/api/export/daily?date=" + this.data.date, "日报-" + this.data.date + ".xlsx").catch((error) => {
      wx.showToast({ title: error.message, icon: "none" });
    });
  }
});
