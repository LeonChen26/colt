// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// 等宽字体随包分发（只引 @font-face 与 woff2，按 unicode-range 分片）：
// 代码 / 路径 / diff / 终端是高频阅读面，不能赌用户机器上装了什么。
// 字体族名是 'JetBrains Mono Variable'，变量字体一个文件覆盖 100–800 全部字重。
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("未找到挂载节点 #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
