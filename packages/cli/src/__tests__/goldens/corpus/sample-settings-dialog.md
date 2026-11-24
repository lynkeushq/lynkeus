---
id: sample-settings-dialog
title: "A theme setting, three levels deep and back, a confirmation dialog"
description: >
  Turns night mode on and off, goes to account management and the change-password form (obscured fields, a button
  that waits for both), back twice, then opens and cancels the sign-out dialog.
---
steps:
  - app.deeplink: "/settings"
  - app.press: "深色模式"
  - app.press: "开启"
  - app.back
  - app.see: { text: "深色模式 开启" }
  - app.press: "深色模式"
  - app.press: "关闭"
  - app.back
  - app.see: { text: "深色模式 关闭" }
  - app.press: "账户"
  - app.press: "更改密码"
  - app.see: { text: "设置新密码" }
  - app.wait: { target: "保存", enabled: false }
  # Neither field has a key or a label, only a hint: they are reached by index, the new password first, since typing
  # into a field adds its clear button and moves the indexes after it.
  - app.type: { target: "6", text: "222222" }
  - app.type: { target: "3", text: "111111" }
  - app.wait: { target: "保存", enabled: true }
  - app.back
  - app.back
  - app.see: { text: "退出登录" }
  - app.press: "退出登录"
  - app.see: { text: "确定要退出吗？" }
  - app.press: "取消"
  - app.wait: { target: "确定要退出吗？", gone: true }
expected:
  - Night mode follows the choice; the password form needs both fields; the dialog closes on cancel.
