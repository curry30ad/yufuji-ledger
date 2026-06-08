const { request } = require("../../utils/request");

Page({
  data: {
    username: "owner",
    password: "admin123",
    loading: false
  },

  onShow() {
    const app = getApp();
    if (app.globalData.token) {
      wx.reLaunch({ url: "/pages/dashboard/index" });
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  async submit() {
    if (this.data.loading) {
      return;
    }
    this.setData({ loading: true });
    try {
      const result = await request({
        url: "/api/auth/login",
        method: "POST",
        data: {
          username: this.data.username,
          password: this.data.password
        }
      });
      getApp().setSession(result.token, result.user);
      wx.reLaunch({ url: "/pages/dashboard/index" });
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  }
});
