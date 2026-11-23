---
id: deer-settings
title: "flutter_deer: a theme setting, three levels deep and back, a confirmation dialog"
description: >
  Turns night mode on and off, goes to account management and the change-password form (obscured fields, a button
  that waits for both), back twice, then opens and cancels the sign-out dialog.
---
steps:
  - app.deeplink: "/setting"
  - app.press: "夜间模式"
  - app.press: "开启"
  - app.back
  - app.see: { text: "夜间模式 开启" }
  - app.press: "夜间模式"
  - app.press: "关闭"
  - app.back
  - app.see: { text: "夜间模式 关闭" }
  - app.press: "账号管理"
  - app.press: "修改密码"
  - app.see: { text: "重置登录密码" }
  - app.wait: { target: "确认", enabled: false }
  # Neither field has a key or a label, only a hint: they are reached by index, the new password first, since typing
  # into a field adds its clear button and moves the indexes after it.
  - app.type: { target: "6", text: "222222" }
  - app.type: { target: "3", text: "111111" }
  - app.wait: { target: "确认", enabled: true }
  - app.back
  - app.back
  - app.see: { text: "退出当前账号" }
  - app.press: "退出当前账号"
  - app.see: { text: "您确定要退出登录吗？" }
  - app.press: "取消"
  - app.wait: { target: "您确定要退出登录吗？", gone: true }
expected:
  - Night mode follows the choice; the password form needs both fields; the dialog closes on cancel.
