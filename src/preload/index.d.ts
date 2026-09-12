import type { BanyanApi } from "@shared/protocol";

declare global {
  interface Window {
    banyan: BanyanApi;
  }
}

export {};
