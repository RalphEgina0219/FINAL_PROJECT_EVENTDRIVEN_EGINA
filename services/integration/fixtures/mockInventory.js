/*
 * MOCK Inventory catalog (INTEGRATION_INVENTORY_MODE=mock). This is a stand-in for the JOHNVIVZ Inventory app,
 * which owns products, prices and stock. Nothing here is real. CRM never edits it: it only reads it through
 * services/integration/inventoryAdapter.js, and only the adapter's mock override helper (used by tests) changes it.
 * stock = quantity on hand in the mock Inventory; reservations held by CRM orders are subtracted by the adapter.
 */
export const MOCK_SOURCE_VERSION = "mock-2026-11";

// [product_id, sku, name, unit, category, price, vatable, stock, status]
const ROWS = [
  ["MOCK-P-1001", "RICE-SIN-5", "Sinandomeng Rice 5kg", "bag", "Rice & Grains", 285, 0, 400, "active"],
  ["MOCK-P-1002", "RICE-DIN-5", "Dinorado Rice 5kg", "bag", "Rice & Grains", 340, 0, 250, "active"],
  ["MOCK-P-1003", "EGG-TRAY-30", "Fresh Eggs (tray of 30)", "tray", "Dairy & Eggs", 245, 0, 300, "active"],
  ["MOCK-P-1004", "MILK-FR-1L", "Fresh Milk 1L", "carton", "Dairy & Eggs", 98, 1, 220, "active"],
  ["MOCK-P-1005", "NOOD-CANTON", "Pancit Canton (pack)", "pack", "Pantry", 18.5, 1, 900, "active"],
  ["MOCK-P-1006", "OIL-COOK-1L", "Cooking Oil 1L", "bottle", "Pantry", 92, 1, 380, "active"],
  ["MOCK-P-1007", "SUGAR-W-1", "White Sugar 1kg", "pack", "Pantry", 78, 1, 500, "active"],
  ["MOCK-P-1008", "CAN-SARD-155", "Canned Sardines 155g", "can", "Canned Goods", 24, 1, 1200, "active"],
  ["MOCK-P-1009", "COFFEE-3IN1", "Instant Coffee 3-in-1 (10s)", "pack", "Beverages", 62, 1, 640, "active"],
  ["MOCK-P-1010", "BREAD-LOAF", "Bread Loaf", "loaf", "Bakery", 58, 1, 150, "active"],
  ["MOCK-P-1011", "CRACK-CREAM", "Cream Crackers (box)", "box", "Biscuits & Snacks", 44, 1, 6, "active"], // low stock
  ["MOCK-P-1012", "DETERG-1KG", "Laundry Detergent 1kg", "pack", "Household", 115, 1, 260, "active"],
  ["MOCK-P-1013", "WATER-500", "Bottled Water 500ml", "bottle", "Beverages", 15, 1, 2000, "active"],
  ["MOCK-P-1014", "CHICK-FRZ-KG", "Frozen Whole Chicken (per kg)", "kg", "Meat & Poultry", 190, 0, 120.5, "active"],
  ["MOCK-P-1015", "MANGO-KG", "Seasonal Mango (per kg)", "kg", "Fruits", 130, 0, 0, "active"], // out of stock
  ["MOCK-P-1016", "BISC-DISC", "Discontinued Biscuits", "pack", "Biscuits & Snacks", 30, 1, 50, "inactive"], // not sold any more
];

export const MOCK_PRODUCTS = ROWS.map(([product_id, sku, name, unit, category_name, selling_price, is_vatable, stock, status]) => ({
  product_id, sku, name, unit, category_name, selling_price, is_vatable, stock, status, low_stock_level: 10,
}));
