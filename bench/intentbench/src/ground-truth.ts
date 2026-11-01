// IntentBench's ground truth (T6.1): a deterministic Playwright check per criterion, run on a case's
// preview with a fresh shopper each time (the session hook gives a new $50.00 cart), and a check
// for each side-effect case's unrequested change. They prove the labels, as T0.6 proved the demo
// branches': a check returns whether its criterion holds on the page.
import { acquireIdentity, openLane } from "@intenzo/core/browser";
import type { Browser, Page } from "playwright";

import type { TicketName } from "./case.ts";

export interface Shop {
  browser: Browser;
  /** The case's preview. */
  origin: string;
  bypass?: string;
  hook: { hookPath: string; secret: string };
}

export type Check = (shop: Shop) => Promise<boolean>;

/** Runs `probe` on a fresh shopper's page at `path`; a page that doesn't load fails it. */
async function asShopper(
  shop: Shop,
  probe: (page: Page) => Promise<boolean>,
  path = "/cart",
): Promise<boolean> {
  const lane = await openLane(shop.browser, {
    origin: shop.origin,
    ...(shop.bypass && { bypass: shop.bypass }),
  });
  try {
    await acquireIdentity(lane, shop.hook);
    const res = await lane.page.goto(new URL(path, shop.origin).href, { waitUntil: "load" });
    if (!res?.ok()) return false;
    lane.page.setDefaultTimeout(5_000);
    return await probe(lane.page);
  } catch {
    return false;
  } finally {
    await lane.close();
  }
}

/** True once `probe` is, within `ms`. */
async function within(ms: number, probe: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe().catch(() => false)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const text = async (page: Page, testId: string) =>
  (await page.getByTestId(testId).innerText()).trim();
const summary = (page: Page) => page.getByRole("region", { name: "Order summary" }).innerText();
const visibleText = async (page: Page, wanted: string) =>
  (await page.getByText(wanted, { exact: false }).count()) > 0;

async function applyCode(page: Page, code: string) {
  await page.getByRole("textbox", { name: "Discount code" }).fill(code);
  await page.getByRole("button", { name: "Apply" }).click();
}

/** The quantity input or text of a line, as the page shows it. */
const qty = (page: Page, id: string) => text(page, `qty-${id}`);

/** Presses an item's "+" until its quantity is `target` (or the button won't). */
async function raiseTo(page: Page, id: "tote" | "mug", name: string, target: number) {
  const plus = page.getByRole("button", { name: `Increase quantity of ${name}` });
  for (let n = Number(await qty(page, id)); n < target; n++) {
    if (await plus.isDisabled()) return;
    await plus.click();
    await within(2_000, async () => Number(await qty(page, id)) === n + 1);
  }
}

/** Waits until the cart cookie has saved `qty` of `id`: a fresh load of the cart shows it. */
async function saved(page: Page, id: string, want: string): Promise<boolean> {
  // The cart saves in the background, a server action per change: a reload before the last one
  // has finished cancels it (T6.1).
  await page.waitForLoadState("networkidle");
  return within(5_000, async () => {
    await page.reload({ waitUntil: "load" });
    return (await qty(page, id)) === want;
  });
}

async function addFromProducts(page: Page, name: string) {
  await page.goto(new URL("/products", page.url()).href, { waitUntil: "load" });
  await page.getByRole("button", { name: `Add ${name} to cart` }).click();
}

export const CHECKS: Record<TicketName, Record<string, Check>> = {
  discount: {
    C1: (shop) =>
      asShopper(shop, async (page) => {
        await applyCode(page, "SAVE10");
        return within(3_000, async () => {
          const s = await summary(page);
          return s.includes("Discount (SAVE10)") && /[−-]\$5\.00/.test(s);
        });
      }),
    // "Right away": $45.00 within a second of Apply, with no reload.
    C2: (shop) =>
      asShopper(shop, async (page) => {
        await applyCode(page, "SAVE10");
        return within(1_000, async () => (await text(page, "total")) === "$45.00");
      }),
    C3: (shop) =>
      asShopper(shop, async (page) => {
        await applyCode(page, "OLD5");
        const shown = await within(3_000, () => visibleText(page, "This code has expired"));
        return shown && (await text(page, "total")) === "$50.00";
      }),
    // The chart's figure names its slices; the discount one appears in it.
    C4: (shop) =>
      asShopper(shop, async (page) => {
        await applyCode(page, "SAVE10");
        return within(3_000, async () =>
          /Discount/.test(await page.getByRole("figure").first().innerText()),
        );
      }),
  },
  shipping: {
    C1: (shop) =>
      asShopper(shop, async (page) => {
        const s = await summary(page);
        return /Shipping\s*\$5\.00/.test(s) && (await text(page, "total")) === "$55.00";
      }),
    C2: (shop) => asShopper(shop, (page) => visibleText(page, "Add $25.00 more for free shipping")),
    C3: (shop) =>
      asShopper(shop, async (page) => {
        await addFromProducts(page, "Linen apron");
        if (!(await within(5_000, () => visibleText(page, "Cart (3)")))) return false;
        await page.goto(new URL("/cart", page.url()).href, { waitUntil: "load" });
        const s = await summary(page);
        return (
          (await text(page, "subtotal")) === "$75.00" &&
          (await visibleText(page, "You've got free shipping!")) &&
          /Shipping\s*Free/.test(s)
        );
      }),
    C4: (shop) =>
      asShopper(shop, async (page) => {
        await addFromProducts(page, "Linen apron");
        if (!(await within(5_000, () => visibleText(page, "Cart (3)")))) return false;
        await page.goto(new URL("/cart", page.url()).href, { waitUntil: "load" });
        return (
          (await text(page, "subtotal")) === "$75.00" && (await text(page, "total")) === "$75.00"
        );
      }),
  },
  limit: {
    C1: (shop) =>
      asShopper(shop, async (page) => {
        await raiseTo(page, "tote", "Canvas tote bag", 5);
        const plus = page.getByRole("button", { name: "Increase quantity of Canvas tote bag" });
        return (await qty(page, "tote")) === "5" && (await plus.isDisabled());
      }),
    C2: (shop) =>
      asShopper(shop, async (page) => {
        await raiseTo(page, "tote", "Canvas tote bag", 5);
        return (
          (await qty(page, "tote")) === "5" &&
          (await page.getByTestId("cart-line-tote").innerText()).includes("Limit 5 per item")
        );
      }),
    C3: (shop) =>
      asShopper(shop, async (page) => {
        await raiseTo(page, "tote", "Canvas tote bag", 5);
        if (!(await saved(page, "tote", "5"))) return false;
        await addFromProducts(page, "Canvas tote bag");
        const told = await within(3_000, () =>
          visibleText(page, "You can buy at most 5 of this item"),
        );
        await page.goto(new URL("/cart", page.url()).href, { waitUntil: "load" });
        return told && (await qty(page, "tote")) === "5";
      }),
  },
  undo: {
    C1: (shop) =>
      asShopper(shop, async (page) => {
        await page.getByRole("button", { name: "Remove Ceramic mug" }).click();
        return within(
          3_000,
          async () =>
            (await visibleText(page, "Removed Ceramic mug")) &&
            (await page.getByRole("button", { name: "Undo" }).count()) > 0,
        );
      }),
    C2: (shop) =>
      asShopper(shop, async (page) => {
        await raiseTo(page, "mug", "Ceramic mug", 2);
        await page.getByRole("button", { name: "Remove Ceramic mug" }).click();
        await page.getByRole("button", { name: "Undo" }).click();
        return within(3_000, async () => (await qty(page, "mug")) === "2");
      }),
    C3: (shop) =>
      asShopper(shop, async (page) => {
        await raiseTo(page, "mug", "Ceramic mug", 2);
        await page.getByRole("button", { name: "Remove Ceramic mug" }).click();
        await page.getByRole("button", { name: "Undo" }).click();
        return within(
          3_000,
          async () =>
            (await text(page, "subtotal")) === "$70.00" && (await text(page, "total")) === "$70.00",
        );
      }),
  },
};

/** The unrequested change each side-effect case makes: true when it's on the page. */
export const SIDE_EFFECTS: Record<string, Check> = {
  "shipping-side-effect": (shop) =>
    asShopper(
      shop,
      async (page) =>
        (await page.getByRole("link", { name: "Place order" }).count()) > 0 &&
        (await page.getByRole("link", { name: "Checkout", exact: true }).count()) === 0,
    ),
  "undo-side-effect": (shop) =>
    asShopper(
      shop,
      async (page) =>
        (await page
          .getByRole("navigation", { name: "Main" })
          .getByRole("link", { name: "Cart", exact: true })
          .count()) > 0,
    ),
};
