---
id: deer-store-audit
title: "flutter_deer: a form with a bottom-sheet picker, submitted"
description: >
  Fills the store name, picks the business scope from a bottom sheet, submits the audit form and enters the shop.
---
steps:
  - app.deeplink: "/store/audit"
  - app.see: { text: "店铺资料" }
  - app.type: { target: "填写店铺名称", text: "Deer Shop" }
  - app.press: "主营范围"
  - app.see: { layer: true }
  - app.press: "家用电器"
  - app.see: { text: "主营范围 家用电器" }
  - app.press: "提交"
  - app.see: { text: "恭喜，店铺资料审核成功" }
  - app.press: "进入"
  # The shop's order list loads about 2 s after the page opens; without this wait a device, whose capture takes real
  # time, shows the list while a faster run still shows the spinner.
  - app.wait: { target: "#order_item_1", timeoutMs: 10000 }
  - app.see: { text: "新订单" }
expected:
  - The picked scope shows on the form, and submitting it leads into the shop.
