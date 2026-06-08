const { request } = require("../../utils/request");
const { requireLogin } = require("../../utils/auth");
const { todayText, monthText, money } = require("../../utils/format");

Page({
  data: {
    user: null,
    today: todayText(),
    month: monthText(),
    ledger: null,
    analytics: null
  },

  onShow() {
    if (!requireLogin()) {
      return;
    }
    const user = getApp().globalData.user;
    this.setData({ user });
    this.loadData();
  },

  async loadData() {
    const tasks = [
      request({ url: "/api/ledger/" + this.data.today })
    ];
    if (this.data.user && this.data.user.role === "owner") {
      tasks.push(request({ url: "/api/analytics?metric=salesTotal&dailyRange=30&endDate=" + this.data.today + "&monthEnd=" + this.data.month }));
    }
    try {
      const results = await Promise.all(tasks);
      this.setData({
        ledger: results[0].ledger,
        analytics: results[1] || null
      });
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  goPage(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },

  logout() {
    getApp().clearSession();
    wx.reLaunch({ url: "/pages/login/index" });
  },

  moneyText(value) {
    return money(value);
  }
});
