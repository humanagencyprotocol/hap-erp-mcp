/** The former auto-seeded demo company, kept as a deterministic test fixture. */
import type { Company } from "../../src/company.js";

export const DEMO_COMPANY: Company = {
  name: "Demo Industrial",
  currency: "EUR",
  items: [
    { id: "item-1", sku: "WIDGET-100", name: "Widget 100", unit: "pcs", list_price: 25.0, stock: 500 },
    { id: "item-2", sku: "WIDGET-200", name: "Widget 200 Pro", unit: "pcs", list_price: 45.0, stock: 300 },
    { id: "item-3", sku: "GEAR-A1", name: "Precision Gear A1", unit: "pcs", list_price: 120.0, stock: 80 },
    { id: "item-4", sku: "GEAR-B2", name: "Precision Gear B2", unit: "pcs", list_price: 150.0, stock: 60 },
    { id: "item-5", sku: "PANEL-S", name: "Control Panel S", unit: "pcs", list_price: 89.5, stock: 150 },
    { id: "item-6", sku: "PANEL-L", name: "Control Panel L", unit: "pcs", list_price: 149.5, stock: 90 },
    { id: "item-7", sku: "CABLE-5M", name: "Cable 5m", unit: "pcs", list_price: 12.0, stock: 1000 },
    { id: "item-8", sku: "SERVICE-KIT", name: "Maintenance Kit", unit: "set", list_price: 340.0, stock: 20 },
  ],
  customers: [
    { id: "cust-1", name: "Nordkap Manufacturing GmbH", email: "ap@nordkap.example", country: "DE", credit_limit: 50000, open_balance: 12000, payment_terms: "NET30" },
    { id: "cust-2", name: "Alpine Components AG", email: "finance@alpinecomp.example", country: "AT", credit_limit: 20000, open_balance: 4000, payment_terms: "NET30" },
    { id: "cust-3", name: "Baltic Retail Group", email: "accounts@balticretail.example", country: "LV", credit_limit: 8000, open_balance: 7500, payment_terms: "NET14" },
    { id: "cust-4", name: "Meridian Industrial Ltd", email: "payables@meridianind.example", country: "IE", credit_limit: 100000, open_balance: 0, payment_terms: "NET60" },
    { id: "cust-5", name: "Solstice Equipment Co", email: "finance@solsticeeq.example", country: "NL", credit_limit: 5000, open_balance: 4800, payment_terms: "NET7" },
  ],
};

