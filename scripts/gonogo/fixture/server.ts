import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The planted behaviors of shop.html (its header comment says what each one does). */
export const VARIANTS = [
  "correct",
  "stale-total",
  "off-by-cent",
  "wrong-percent",
  "missing-error",
  "quiet-confirm",
  "slow-total",
] as const;
export type Variant = (typeof VARIANTS)[number];

export interface ShopServer {
  /** Origin, e.g. http://127.0.0.1:53211 (no trailing slash). */
  origin: string;
  close(): Promise<void>;
}

const SHOP_HTML = readFileSync(new URL("./shop.html", import.meta.url), "utf8");

/** The cart page URL for one variant. A reload keeps the query, so it keeps the variant. */
export const cartUrl = (origin: string, variant: Variant): string =>
  `${origin}/cart?variant=${variant}`;

/** Serves the fixture shop at /cart on a free localhost port. */
export async function startShop(): Promise<ShopServer> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/cart") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(SHOP_HTML);
    } else {
      // Includes /favicon.ico: an empty answer keeps the console and network logs clean.
      res.writeHead(path === "/favicon.ico" ? 204 : 404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
