// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

import type { ColtApi } from "@shared/protocol";

declare global {
  interface Window {
    colt: ColtApi;
  }
}

export {};
