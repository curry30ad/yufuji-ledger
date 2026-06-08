const { request } = require("../../utils/request");
const { requireOwner } = require("../../utils/auth");

function emptyForm() {
  return {
    id: "",
    name: "",
    saleMode: "piece",
    unit: "份",
    price: "",
    sortOrder: "0",
    isActive: true
  };
}

Page({
  data: {
    items: [],
    form: emptyForm()
  },

  onShow() {
    if (!requireOwner()) {
      return;
    }
    this.loadItems();
  },

  async loadItems() {
    try {
      const result = await request({ url: "/api/products?includeInactive=true" });
      this.setData({ items: result.items || [] });
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ["form." + field]: e.detail.value });
  },

  onModeChange(e) {
    this.setData({ "form.saleMode": e.detail.value === "0" ? "piece" : "weight" });
  },

  onStatusChange(e) {
    this.setData({ "form.isActive": e.detail.value });
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
        saleMode: item.saleMode,
        unit: item.unit,
        price: String(item.price),
        sortOrder: String(item.sortOrder),
        isActive: item.isActive
      }
    });
  },

  resetForm() {
    this.setData({ form: emptyForm() });
  },

  async saveItem() {
    try {
      await request({
        url: "/api/products",
        method: "POST",
        data: this.data.form
      });
      wx.showToast({ title: "已保存", icon: "success" });
      this.resetForm();
      this.loadItems();
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  }
});
