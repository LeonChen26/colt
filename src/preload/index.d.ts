import type { ColtApi } from "@shared/protocol";

declare global {
  interface Window {
    colt: ColtApi;
  }
}

export {};
