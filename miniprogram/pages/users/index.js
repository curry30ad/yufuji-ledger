const { request } = require("../../utils/request");
const { requireOwner } = require("../../utils/auth");

function emptyForm() {
  return {
    id: "",
    name: "",
    username: "",
    password: "",
    status: "active"
  };
}

Page({
  data: {
    items: [],
    form: emptyForm(),
    resetPassword: ""
  },

  onShow() {
    if (!requireOwner()) {
      return;
    }
    this.loadItems();
  },

  async loadItems() {
    try {
      const result = await request({ url: "/api/users" });
      this.setData({ items: (result.items || []).filter((item) => item.role === "staff") });
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ["form." + field]: e.detail.value });
  },

  onStatusPick(e) {
    this.setData({ "form.status": e.detail.value === "0" ? "active" : "inactive" });
  },

  editItem(e) {
    const item = this.data.items.find((row) => row.id === e.currentTarget.dataset.id);
    if (!item) {
      return;
    }
    this.setData({
      form: {
        id: item.id,
        name: item.name,
        username: item.username,
        password: "",
        status: item.status
      }
    });
  },

  resetForm() {
    this.setData({ form: emptyForm() });
  },

  async saveItem() {
    try {
      await request({
        url: "/api/users",
        method: "POST",
        data: this.data.form
      });
      wx.showToast({ title: "已保存", icon: "success" });
      this.resetForm();
      this.loadItems();
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  async resetPassword(e) {
    const id = e.currentTarget.dataset.id;
    const result = await wx.showModal({
      title: "重置密码",
      editable: true,
      placeholderText: "输入新密码"
    });
    if (!result.confirm || !result.content) {
      return;
    }
    try {
      await request({
        url: "/api/users/" + id + "/reset-password",
        method: "POST",
        data: { password: result.content }
      });
      wx.showToast({ title: "密码已重置", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  async deleteItem(e) {
    const id = e.currentTarget.dataset.id;
    const result = await wx.showModal({
      title: "删除店员",
      content: "确定删除这个店员账号吗？"
    });
    if (!result.confirm) {
      return;
    }
    try {
      await request({
        url: "/api/users/" + id,
        method: "DELETE"
      });
      this.loadItems();
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  }
});
