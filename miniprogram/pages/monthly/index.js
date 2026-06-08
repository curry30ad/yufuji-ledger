const { request, download } = require("../../utils/request");
const { requireOwner } = require("../../utils/auth");
const { monthText } = require("../../utils/format");

Page({
  data: {
    month: monthText(),
    summary: null
  },

  onShow() {
    if (!requireOwner()) {
      return;
    }
    this.loadSummary();
  },

  onMonthChange(e) {
    this.setData({ month: e.detail.value });
    this.loadSummary();
  },

  async loadSummary() {
    try {
      const summary = await request({ url: "/api/reports/monthly?month=" + this.data.month });
      this.setData({ summary });
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  exportMonthly() {
    download("/api/export/monthly?month=" + this.data.month, "月报-" + this.data.month + ".xlsx").catch((error) => {
      wx.showToast({ title: error.message, icon: "none" });
    });
  }
});
