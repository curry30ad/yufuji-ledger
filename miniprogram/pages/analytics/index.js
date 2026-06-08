const { request } = require("../../utils/request");
const { requireOwner } = require("../../utils/auth");
const { todayText, monthText } = require("../../utils/format");

Page({
  data: {
    metric: "salesTotal",
    dailyRange: 30,
    endDate: todayText(),
    monthEnd: monthText(),
    analytics: null,
    maxDaily: 1,
    maxMonthly: 1
  },

  onShow() {
    if (!requireOwner()) {
      return;
    }
    this.loadAnalytics();
  },

  async loadAnalytics() {
    try {
      const analytics = await request({
        url: "/api/analytics?metric=" + this.data.metric + "&dailyRange=" + this.data.dailyRange + "&endDate=" + this.data.endDate + "&monthEnd=" + this.data.monthEnd
      });
      const dailyValues = (analytics.daily.series || []).map((item) => Number(item.value || 0));
      const monthlyValues = (analytics.monthly.series || []).map((item) => Number(item.value || 0));
      this.setData({
        analytics,
        maxDaily: Math.max(...dailyValues, 1),
        maxMonthly: Math.max(...monthlyValues, 1)
      });
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  switchMetric(e) {
    this.setData({ metric: e.currentTarget.dataset.metric });
    this.loadAnalytics();
  },

  switchRange(e) {
    this.setData({ dailyRange: Number(e.currentTarget.dataset.range) });
    this.loadAnalytics();
  }
});
