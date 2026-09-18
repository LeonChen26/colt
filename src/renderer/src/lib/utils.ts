// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并 Tailwind 类名（shadcn/ui 约定） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
