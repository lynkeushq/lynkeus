---
id: signup
title: "Sign up in {{matrix.locale}} with {{matrix.login}}"
matrix: { locale: [en, fr], login: [phone, email] }
---
steps:
  - app.press: "#{{matrix.login}}"
  - app.type: { target: "#{{matrix.login}}-input", text: "{{matrix.locale}}" }
  - app.see: { text: "{{matrix.locale}}" }
