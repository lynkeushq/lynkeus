---
id: deer-goods
title: "flutter_deer: a list with images, its item menu, a delete confirmed, the add menu"
description: >
  The goods list shows images and titles; an item's menu offers edit, unlist and delete; delete asks in a bottom
  sheet and removes the item; the add button opens a popup menu that leads to the edit form.
---
steps:
  - app.deeplink: "/goods"
  - app.see: { text: "在售 (3件)" }
  - app.press: "#goods_menu_item_0"
  - app.press: "#goods_delete_item_0"
  - app.see: { text: "是否确认删除，防止错误操作" }
  - app.press: "确认删除"
  - app.see: { text: "在售 (2件)" }
  - app.press: "#add"
  - app.press: "添加商品"
  - app.see: { text: "商品简介" }
  - app.back
  - app.see: { text: "全部商品" }
expected:
  - Deleting through the menu leaves two goods; the add menu opens the edit form.
