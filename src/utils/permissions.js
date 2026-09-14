// The canonical list of module-level permission keys a `staff` user can be
// granted, with real CRUD (Create/View/Edit/Delete) granularity per module.
// A company_admin or super_admin is never checked against this at all, only
// `staff` is.
//
// ⚠️ HISTORY: master data was originally ONE combined "masters" module
// (confirmed with the user at the time) — that was superseded by a direct
// follow-up request for each master-data resource to be its own separately-
// grantable module (matching a reference permissions-UI screenshot the user
// shared), same "module-only → CRUD" style upgrade this permission system
// already went through once before. The flat "masters" key no longer exists
// anywhere in the code.
//
// "reports" only supports "view" — there's nothing to create/edit/delete in
// a report.
//
// IMPORTANT: "view" on a master-data module does NOT gate reference-data
// reads other modules depend on (e.g. Sale's customer dropdown) — see
// middlewares/auth.js's requirePermission `readOnly` option. "view" on e.g.
// "customers" specifically governs the dedicated Customers list PAGE (a
// frontend-only distinction — the backend GET route itself always stays
// open for every master-data module, since it can't tell "loading a
// dropdown" apart from "loading the management page").
const PERMISSION_MODULES = [
  "purchase",
  "sale",
  "purchaseReturn",
  "saleReturn",
  "stockTransfer",
  "reports",
  "items",
  "customers",
  "suppliers",
  "godowns",
  "hsn",
  "itemNames",
  "itemSubGroups",
  "customerGroups",
  "supplierGroups",
  "godownGroups",
  "salesmen",
  "schemes",
  "openingBills",
];

const PERMISSION_ACTIONS = ["view", "create", "edit", "delete"];

// Which actions actually apply to each module — "reports" has no
// create/edit/delete concept at all; every other module (transactional or
// master-data) gets the full CRUD set.
const MODULE_ACTIONS = {
  purchase: ["view", "create", "edit", "delete"],
  sale: ["view", "create", "edit", "delete"],
  purchaseReturn: ["view", "create", "edit", "delete"],
  saleReturn: ["view", "create", "edit", "delete"],
  stockTransfer: ["view", "create", "edit", "delete"],
  reports: ["view"],
  items: ["view", "create", "edit", "delete"],
  customers: ["view", "create", "edit", "delete"],
  suppliers: ["view", "create", "edit", "delete"],
  godowns: ["view", "create", "edit", "delete"],
  hsn: ["view", "create", "edit", "delete"],
  itemNames: ["view", "create", "edit", "delete"],
  itemSubGroups: ["view", "create", "edit", "delete"],
  customerGroups: ["view", "create", "edit", "delete"],
  supplierGroups: ["view", "create", "edit", "delete"],
  godownGroups: ["view", "create", "edit", "delete"],
  salesmen: ["view", "create", "edit", "delete"],
  schemes: ["view", "create", "edit", "delete"],
  openingBills: ["view", "create", "edit", "delete"],
};

const PERMISSION_LABELS = {
  purchase: "Purchase",
  sale: "Sale",
  purchaseReturn: "Purchase Return",
  saleReturn: "Sale Return",
  stockTransfer: "Stock Transfer",
  reports: "Reports",
  items: "Items / M.R.Ps.",
  customers: "Customers",
  suppliers: "Suppliers",
  godowns: "Godowns",
  hsn: "HSN Codes",
  itemNames: "Item Names",
  itemSubGroups: "Item Sub Groups",
  customerGroups: "Customer Groups",
  supplierGroups: "Supplier Groups",
  godownGroups: "Godown Groups",
  salesmen: "Salesmen",
  schemes: "Schemes",
  openingBills: "Opening Bills",
};

// Strips anything that isn't a real module/action pair out of a client-
// submitted permissions object — never trust it as-is, matching this app's
// established "sanitize before persisting" convention for user-submitted
// structured data.
function sanitizePermissions(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  PERMISSION_MODULES.forEach((mod) => {
    const raw = input[mod];
    if (!raw || typeof raw !== "object") return;
    const allowedActions = MODULE_ACTIONS[mod];
    const entry = {};
    allowedActions.forEach((action) => {
      if (raw[action]) entry[action] = true;
    });
    if (Object.keys(entry).length) out[mod] = entry;
  });
  return out;
}

function hasPermission(permissions, moduleKey, action) {
  return !!(permissions && permissions[moduleKey] && permissions[moduleKey][action]);
}

module.exports = {
  PERMISSION_MODULES,
  PERMISSION_ACTIONS,
  MODULE_ACTIONS,
  PERMISSION_LABELS,
  sanitizePermissions,
  hasPermission,
};
