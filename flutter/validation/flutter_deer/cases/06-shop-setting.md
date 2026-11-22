---
id: deer-shop-setting
title: "flutter_deer: a switch, a bottom-sheet choice and a text page"
description: >
  Opens the shop, toggles it open with its switch, picks a payment method from a bottom sheet, and edits the shop
  description on a page of its own.
---
steps:
  - app.deeplink: "/shop/shopSetting"
  - app.see: { text: "暂停营业" }
  - app.press: "店铺营业开关"
  - app.see: { text: "正在营业" }
  - app.press: "店铺营业开关"
  - app.see: { text: "暂停营业" }
  - app.press: "支付方式 在线支付"
  - app.see: { layer: true }
  - app.press: "对公转账"
  - app.press: "确定"
  - app.see: { text: "对公转账" }
  - app.press: "店铺简介 零食铺子坚果饮料美酒佳肴…"
  - app.type: { text: "Deer", clear: true }
  - app.press: "#actionName"
  - app.see: { text: "店铺简介 Deer" }
expected:
  - The switch, the payment choice and the description all show what was set.
