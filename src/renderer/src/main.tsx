// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("未找到挂载节点 #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
