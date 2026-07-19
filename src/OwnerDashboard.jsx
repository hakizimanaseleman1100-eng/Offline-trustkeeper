import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { supabase } from './supabaseClient';
import { getBusinessId } from './session';
import { hashPin } from './auth';

const STAFF_ROLES = ['WAITER', 'KITCHEN', 'MANAGER', 'OWNER'];

const NAV_LINKS = [
  { key: 'Dashboard', icon: '📊' },
  { key: 'Sales', icon: '🧾' },
  { key: 'Reconcile', icon: '🧮' },
  { key: 'Reports', icon: '📈' },
  { key: 'Stations', icon: '🏪' },
  { key: 'Inventory', icon: '📦' },
  { key: 'Expenses', icon: '💵' },
  { key: 'Team', icon: '👥' },
  { key: 'Customers', icon: '🧑' },
  { key: 'Debts', icon: '📒' },
  { key: 'Order QR', icon: '📱' },
  { key: 'Settings', icon: '⚙️' },
];

// On phones the bottom bar shows only these four most-used views; the rest go
// behind a "More" menu so the bar doesn't get crowded. The desktop sidebar
// always lists everything. Reconcile (the daily end-of-day count) is primary;
// Stations (setup) moves to More.
const MOBILE_PRIMARY = ['Dashboard', 'Sales', 'Reconcile', 'Reports'];
const primaryLinks = NAV_LINKS.filter((l) => MOBILE_PRIMARY.includes(l.key));
const overflowLinks = NAV_LINKS.filter((l) => !MOBILE_PRIMARY.includes(l.key));
const EXPENSE_CATEGORIES = ['Utilities', 'Supplies', 'Maintenance', 'Salaries', 'Other'];

// Rwanda RRA/EBM VAT tax categories. VAT is a single 18% standard rate, so the
// label fixes the rate — the owner picks the label and the rate follows.
//   A = Exempt, B = Standard (18%), C = Zero-rated, D = Non-VAT.
const TAX_CATEGORIES = [
  { label: 'A', rate: 0, desc: 'Exempt' },
  { label: 'B', rate: 18, desc: 'Standard' },
  { label: 'C', rate: 0, desc: 'Zero-rated' },
  { label: 'D', rate: 0, desc: 'Non-VAT' },
];
const taxRateFor = (label) => TAX_CATEGORIES.find((t) => t.label === label)?.rate ?? 0;

function startOfTodayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// Start-of-day ISO for a rolling window: sinceISO(1) = today, sinceISO(7) =
// midnight 6 days ago (i.e. a 7-day window including today).
function sinceISO(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.toISOString();
}

const REPORT_RANGES = [
  { key: 'today', label: 'Today', days: 1 },
  { key: '7d', label: '7 Days', days: 7 },
  { key: '30d', label: '30 Days', days: 30 },
];

function DashboardHome({ cashFlow, loading }) {
  // Sales that were rung up on THIS device but haven't reached Supabase yet.
  // The dashboard's totals come from the server, so until these upload the
  // figures below can be understated — worth flagging to the owner.
  const pendingSales = useLiveQuery(async () => {
    const paidTabIds = new Set(
      (await db.active_tabs.where('status').equals('paid').toArray()).map((t) => t.id)
    );
    const rows = await db.sales.where('synced_status').equals(0).toArray();
    return rows.filter((s) => paidTabIds.has(s.tab_id));
  }, [], []);
  const pendingTotal = pendingSales.reduce((sum, s) => sum + (s.total_price ?? 0), 0);

  return (
    <div className="max-w-sm">
      {pendingSales.length > 0 && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm">
          <span className="font-semibold">{pendingSales.length} sale{pendingSales.length > 1 ? 's' : ''} on this device</span>{' '}
          ({pendingTotal.toLocaleString()} RWF) not yet uploaded — today's totals may be understated until synced.
        </div>
      )}
      <p className="text-slate-500 font-semibold mb-3">Net Cash Flow — Today</p>
      <div className="bg-white rounded-2xl shadow-md p-6">
        {loading ? (
          <p className="text-slate-400">Loading…</p>
        ) : (
          <>
            <div
              className={`text-3xl font-extrabold ${
                cashFlow.net >= 0 ? 'text-emerald-600' : 'text-red-600'
              }`}
            >
              {cashFlow.net.toLocaleString()} RWF
            </div>
            <div className="mt-4 space-y-1 text-sm text-slate-500">
              <div className="flex justify-between">
                <span>Sales (synced)</span>
                <span>{cashFlow.salesTotal.toLocaleString()} RWF</span>
              </div>
              <div className="flex justify-between">
                <span>Expenses</span>
                <span>−{cashFlow.expensesTotal.toLocaleString()} RWF</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function InventoryTab({ notify }) {
  const [products, setProducts] = useState([]);
  const [stations, setStations] = useState([]);
  const [selectedStation, setSelectedStation] = useState('');
  const [stockMap, setStockMap] = useState({}); // product_id(string) -> quantity at selectedStation
  const [stockDraft, setStockDraft] = useState({}); // product_id(string) -> input value
  const [itemName, setItemName] = useState('');
  const [sellingPrice, setSellingPrice] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [productCategory, setProductCategory] = useState('');
  const [productSubCategory, setProductSubCategory] = useState('');
  const [taxLabel, setTaxLabel] = useState('B');
  const [initialStock, setInitialStock] = useState('');
  // Inline editing of catalog fields (name/price/cost/category/tax).
  const [edit, setEdit] = useState(null);
  // Excel/CSV import: parsed preview rows and how to apply the stock column.
  const [importRows, setImportRows] = useState(null);
  const [importing, setImporting] = useState(false);
  const [stockMode, setStockMode] = useState('set'); // 'set' (opening) | 'add' (restock)

  const loadProducts = async () => {
    const { data, error } = await supabase.from('products').select('*').order('item_name');
    if (error) {
      console.error('Failed to load products:', error.message);
      return;
    }
    setProducts((data ?? []).filter((p) => p.active !== false));
  };

  const loadStations = async () => {
    const { data } = await supabase
      .from('stations')
      .select('*')
      .eq('business_id', getBusinessId())
      .eq('active', true)
      .order('name');
    setStations(data ?? []);
    setSelectedStation((cur) => cur || data?.[0]?.id || '');
  };

  const loadStock = async (stationId) => {
    if (!stationId) {
      setStockMap({});
      return;
    }
    const { data } = await supabase.from('station_stock').select('*').eq('station_id', stationId);
    setStockMap(Object.fromEntries((data ?? []).map((r) => [String(r.product_id), r.quantity])));
    setStockDraft({});
  };

  useEffect(() => {
    loadProducts();
    loadStations();
  }, []);
  useEffect(() => {
    loadStock(selectedStation);
  }, [selectedStation]);

  // One place that adjusts a station's stock (and logs the movement).
  const applyStock = async (productId, delta, reason) => {
    const { error } = await supabase.rpc('apply_station_stock', {
      p_moves: [
        {
          station_id: selectedStation,
          product_id: String(productId),
          business_id: getBusinessId(),
          delta,
          reason,
          staff_name: 'Owner',
        },
      ],
    });
    if (error) {
      notify(`Stock update failed: ${error.message}`);
      return false;
    }
    return true;
  };

  // ---- Excel / CSV import ---------------------------------------------------
  // The template carries every importable item field as a column, pre-filled
  // with a realistic starter catalog (bar + kitchen + motel) so the owner can
  // download it, tweak prices, and import in one go. Columns are matched by
  // header name (see handleImportFile), so their order can be rearranged.
  const downloadTemplate = () => {
    const header = 'Item Name,Category,Sub-category,Selling Price,Cost Price,Tax,Item Code,Quantity';
    const rows = [
      // Beverages — Beer
      ['Primus 65cl', 'Beverages', 'Beer', 1800, 1400, 'B', 'BR-001', 48],
      ['Mutzig 65cl', 'Beverages', 'Beer', 2000, 1550, 'B', 'BR-002', 48],
      ['Amstel 65cl', 'Beverages', 'Beer', 2000, 1550, 'B', 'BR-003', 36],
      ['Skol 65cl', 'Beverages', 'Beer', 1800, 1400, 'B', 'BR-004', 36],
      ['Turbo King 65cl', 'Beverages', 'Beer', 2000, 1500, 'B', 'BR-005', 24],
      ['Legend 65cl', 'Beverages', 'Beer', 2000, 1500, 'B', 'BR-006', 24],
      ['Gatanu 65cl', 'Beverages', 'Beer', 1600, 1200, 'B', 'BR-007', 24],
      ['Heineken 33cl', 'Beverages', 'Beer', 2500, 1900, 'B', 'BR-008', 24],
      ['Guinness 33cl', 'Beverages', 'Beer', 2500, 1900, 'B', 'BR-009', 24],
      // Beverages — Soft Drinks
      ['Coca-Cola 33cl', 'Beverages', 'Soft Drinks', 700, 450, 'B', 'SD-001', 60],
      ['Fanta Orange 33cl', 'Beverages', 'Soft Drinks', 700, 450, 'B', 'SD-002', 60],
      ['Fanta Citron 33cl', 'Beverages', 'Soft Drinks', 700, 450, 'B', 'SD-003', 48],
      ['Sprite 33cl', 'Beverages', 'Soft Drinks', 700, 450, 'B', 'SD-004', 48],
      ['Coca-Cola 50cl', 'Beverages', 'Soft Drinks', 1000, 650, 'B', 'SD-005', 36],
      ['Fanta Orange 50cl', 'Beverages', 'Soft Drinks', 1000, 650, 'B', 'SD-006', 36],
      ['Vitalo', 'Beverages', 'Soft Drinks', 500, 300, 'B', 'SD-007', 48],
      ['Novida Pineapple', 'Beverages', 'Soft Drinks', 800, 500, 'B', 'SD-008', 36],
      ['Malta Guinness', 'Beverages', 'Soft Drinks', 1000, 700, 'B', 'SD-009', 24],
      // Beverages — Water
      ['Inyange Water 50cl', 'Beverages', 'Water', 500, 300, 'B', 'WT-001', 72],
      ['Inyange Water 1.5L', 'Beverages', 'Water', 1000, 600, 'B', 'WT-002', 36],
      ['Aquafina 50cl', 'Beverages', 'Water', 500, 300, 'B', 'WT-003', 48],
      ['Sparkling Water 50cl', 'Beverages', 'Water', 1200, 800, 'B', 'WT-004', 24],
      // Beverages — Energy
      ['Red Bull', 'Beverages', 'Energy', 2500, 1800, 'B', 'EN-001', 24],
      ['Monster', 'Beverages', 'Energy', 3000, 2200, 'B', 'EN-002', 24],
      ['Power Play', 'Beverages', 'Energy', 1500, 1000, 'B', 'EN-003', 24],
      // Beverages — Juice
      ['Inyange Juice Mango', 'Beverages', 'Juice', 1000, 650, 'B', 'JU-001', 24],
      ['Inyange Juice Passion', 'Beverages', 'Juice', 1000, 650, 'B', 'JU-002', 24],
      ['Fresh Passion Juice', 'Beverages', 'Juice', 1500, 900, 'B', 'JU-003', 12],
      // Beverages — Wine
      ['Red Wine Glass', 'Beverages', 'Wine', 3000, 1800, 'B', 'WN-001', 20],
      ['White Wine Glass', 'Beverages', 'Wine', 3000, 1800, 'B', 'WN-002', 20],
      ['Cellar Cask Red 750ml', 'Beverages', 'Wine', 12000, 9000, 'B', 'WN-003', 12],
      ['Baron Romero 750ml', 'Beverages', 'Wine', 15000, 11000, 'B', 'WN-004', 8],
      // Beverages — Liquor
      ['Waragi 200ml', 'Beverages', 'Liquor', 2000, 1400, 'B', 'LQ-001', 24],
      ['Konyagi 350ml', 'Beverages', 'Liquor', 3000, 2200, 'B', 'LQ-002', 24],
      ['Johnnie Walker Red Shot', 'Beverages', 'Liquor', 3000, 2000, 'B', 'LQ-003', 30],
      ['Chairmans Shot', 'Beverages', 'Liquor', 2500, 1700, 'B', 'LQ-004', 30],
      ['Amarula Shot', 'Beverages', 'Liquor', 3000, 2100, 'B', 'LQ-005', 20],
      ['Bond 7 Shot', 'Beverages', 'Liquor', 2500, 1700, 'B', 'LQ-006', 20],
      ['Uganda Waragi Shot', 'Beverages', 'Liquor', 2000, 1300, 'B', 'LQ-007', 24],
      ['Vodka Shot', 'Beverages', 'Liquor', 2500, 1700, 'B', 'LQ-008', 24],
      ['Gin and Tonic', 'Beverages', 'Liquor', 3500, 2200, 'B', 'LQ-009', 15],
      ['Whisky Double', 'Beverages', 'Liquor', 6000, 4200, 'B', 'LQ-010', 15],
      // Food — Grill (not stock-tracked; quantity left blank)
      ['Brochette Goat', 'Food', 'Grill', 1000, 500, 'B', 'GR-001', ''],
      ['Brochette Beef', 'Food', 'Grill', 1200, 600, 'B', 'GR-002', ''],
      ['Half Chicken Grilled', 'Food', 'Grill', 5000, 3200, 'B', 'GR-003', ''],
      ['Whole Chicken Grilled', 'Food', 'Grill', 9000, 6000, 'B', 'GR-004', ''],
      ['Grilled Tilapia', 'Food', 'Grill', 6000, 4000, 'B', 'GR-005', ''],
      ['Goat Ribs', 'Food', 'Grill', 7000, 4500, 'B', 'GR-006', ''],
      ['Sambaza Fried', 'Food', 'Grill', 3000, 1800, 'B', 'GR-007', ''],
      // Food — Sides
      ['Chips (Fries)', 'Food', 'Sides', 2000, 1000, 'B', 'SI-001', ''],
      ['Fried Plantain (Ibitoke)', 'Food', 'Sides', 2000, 1100, 'B', 'SI-002', ''],
      ['Ugali', 'Food', 'Sides', 1000, 400, 'B', 'SI-003', ''],
      ['Rice', 'Food', 'Sides', 1500, 700, 'B', 'SI-004', ''],
      ['Grilled Potatoes', 'Food', 'Sides', 2000, 1100, 'B', 'SI-005', ''],
      ['Salad', 'Food', 'Sides', 1500, 700, 'B', 'SI-006', ''],
      // Food — Snacks
      ['Samosa', 'Food', 'Snacks', 500, 250, 'B', 'SN-001', ''],
      ['Chapati', 'Food', 'Snacks', 500, 200, 'B', 'SN-002', ''],
      ['Groundnuts (Ubunyobwa)', 'Food', 'Snacks', 1000, 500, 'B', 'SN-003', ''],
      ['Isombe', 'Food', 'Snacks', 2000, 1000, 'B', 'SN-004', ''],
      // Motel Rooms (not stock-tracked)
      ['Standard Room (Night)', 'Motel Rooms', 'Standard', 15000, 0, 'B', 'RM-001', ''],
      ['Deluxe Room (Night)', 'Motel Rooms', 'Deluxe', 25000, 0, 'B', 'RM-002', ''],
      ['VIP Suite (Night)', 'Motel Rooms', 'Suite', 40000, 0, 'B', 'RM-003', ''],
      ['Extra Bed', 'Motel Rooms', 'Add-on', 5000, 0, 'B', 'RM-004', ''],
      // Tobacco
      ['Cigarette Stick', 'Tobacco', 'Cigarettes', 200, 120, 'B', 'TB-001', 100],
      ['Dunhill Pack', 'Tobacco', 'Cigarettes', 3000, 2400, 'B', 'TB-002', 20],
      ['Intore Pack', 'Tobacco', 'Cigarettes', 2500, 2000, 'B', 'TB-003', 20],
    ];
    const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = [header, ...rows.map((r) => r.map(cell).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'product-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Reads the sheet, matches rows to existing products by name, and builds a
  // preview with per-row status/errors. Nothing is written until Apply.
  const handleImportFile = async (file) => {
    try {
      const XLSX = await import('xlsx'); // loaded on demand so it never bloats the app
      const wb = XLSX.read(await file.arrayBuffer());
      const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      const byName = Object.fromEntries(products.map((p) => [p.item_name.trim().toLowerCase(), p]));

      const rows = raw
        .map((r) => {
          const get = (re) => {
            const key = Object.keys(r).find((k) => re.test(k));
            return key ? String(r[key]).trim() : '';
          };
          const name = get(/^item$|name|ibicuruzwa/i);
          const price = get(/price|ibiciro|selling/i);
          const cost = get(/cost/i);
          const category = get(/^categ|icyiciro/i);
          const subCategory = get(/sub.?categ|subcat|ubwoko/i);
          const code = get(/code|barcode|sku/i);
          let tax = get(/tax/i).toUpperCase().replace(/[^ABCD]/g, '').slice(0, 1);
          const qty = get(/qty|quantity|stock|ibyinjiye|yatangiranye/i);
          if (!name && !price && !cost && !category && !qty) return null; // blank row

          const existing = byName[name.toLowerCase()];
          if (!tax) tax = existing?.tax_label ?? 'B';
          let error = '';
          if (!name) error = 'Missing item name';
          else if (!existing && (price === '' || Number.isNaN(Number(price)))) error = 'New item needs a numeric price';
          else if (price !== '' && Number.isNaN(Number(price))) error = 'Price is not a number';
          else if (qty !== '' && Number.isNaN(Number(qty))) error = 'Quantity is not a number';

          return { name, price, cost, category, subCategory, code, tax, qty, existing, error, action: existing ? 'update' : 'create' };
        })
        .filter(Boolean);

      if (rows.length === 0) {
        notify('No rows found in that file');
        return;
      }
      setImportRows(rows);
    } catch (err) {
      notify(`Could not read file: ${err.message}`);
    }
  };

  const applyImport = async () => {
    setImporting(true);
    const valid = importRows.filter((r) => !r.error);
    let created = 0, updated = 0;
    for (const r of valid) {
      let productId;
      let currentStock = 0;
      if (r.action === 'create') {
        const { data, error } = await supabase
          .from('products')
          .insert({
            business_id: getBusinessId(),
            item_name: r.name,
            unit_price: Number(r.price) || 0,
            cost_price: Number(r.cost) || 0,
            category: r.category || '',
            sub_category: r.subCategory || null,
            item_code: r.code || null,
            tax_label: r.tax,
            tax_rate: taxRateFor(r.tax),
          })
          .select('id')
          .single();
        if (error) {
          notify(`Failed on ${r.name}: ${error.message}`);
          continue;
        }
        productId = data.id;
        created++;
      } else {
        productId = r.existing.id;
        currentStock = stockMap[String(productId)] ?? 0;
        const fields = { tax_label: r.tax, tax_rate: taxRateFor(r.tax) };
        if (r.price !== '') fields.unit_price = Number(r.price);
        if (r.cost !== '') fields.cost_price = Number(r.cost);
        if (r.category !== '') fields.category = r.category;
        if (r.subCategory !== '') fields.sub_category = r.subCategory;
        if (r.code !== '') fields.item_code = r.code;
        const { error } = await supabase.from('products').update(fields).eq('id', productId);
        if (error) {
          notify(`Failed on ${r.name}: ${error.message}`);
          continue;
        }
        updated++;
      }
      // Apply the stock column to the selected station (Set = target, Add = restock).
      if (r.qty !== '' && selectedStation) {
        const target = Number(r.qty);
        const delta = stockMode === 'set' ? target - currentStock : target;
        if (delta !== 0) await applyStock(productId, delta, delta > 0 ? 'issue' : 'adjust');
      }
    }
    setImporting(false);
    setImportRows(null);
    notify(`Imported: ${created} new, ${updated} updated`);
    loadProducts();
    loadStock(selectedStation);
  };

  const handleAddProduct = async (e) => {
    e.preventDefault();
    const { data, error } = await supabase
      .from('products')
      .insert({
        business_id: getBusinessId(),
        item_name: itemName,
        unit_price: Number(sellingPrice),
        cost_price: Number(costPrice),
        category: productCategory,
        sub_category: productSubCategory || null,
        tax_label: taxLabel,
        tax_rate: taxRateFor(taxLabel),
      })
      .select('id')
      .single();
    if (error) {
      notify(`Failed to add product: ${error.message}`);
      return;
    }
    // Issue the opening stock to the selected station, if given.
    if (initialStock !== '' && selectedStation) {
      await applyStock(data.id, Number(initialStock), 'issue');
    }
    setItemName('');
    setSellingPrice('');
    setCostPrice('');
    setProductCategory('');
    setProductSubCategory('');
    setTaxLabel('B');
    setInitialStock('');
    notify(`Added ${itemName}`);
    loadProducts();
    loadStock(selectedStation);
  };

  const startEdit = (p) => setEdit({ id: p.id, ...p });

  const saveEdit = async () => {
    const { error } = await supabase
      .from('products')
      .update({
        item_name: edit.item_name,
        unit_price: Number(edit.unit_price),
        cost_price: Number(edit.cost_price),
        category: edit.category,
        sub_category: edit.sub_category || null,
        tax_label: edit.tax_label,
        tax_rate: taxRateFor(edit.tax_label),
      })
      .eq('id', edit.id);
    if (error) {
      notify(`Could not save: ${error.message}`);
      return;
    }
    setEdit(null);
    notify('Product updated');
    loadProducts();
  };

  // Set a product's stock AT the selected station to an absolute count; we
  // apply the difference as a movement (issue if adding, adjust if reducing).
  const setStockFor = async (p) => {
    const key = String(p.id);
    const target = Number(stockDraft[key]);
    if (Number.isNaN(target)) return;
    const current = stockMap[key] ?? 0;
    const delta = target - current;
    if (delta === 0) return;
    const ok = await applyStock(p.id, delta, delta > 0 ? 'issue' : 'adjust');
    if (ok) {
      notify(`${p.item_name}: stock set to ${target}`);
      loadStock(selectedStation);
    }
  };

  const deleteProduct = async (p) => {
    if (!window.confirm(`Remove "${p.item_name}" from the menu?`)) return;
    const { error } = await supabase.from('products').update({ active: false }).eq('id', p.id);
    if (error) {
      notify(`Could not remove: ${error.message}`);
      return;
    }
    notify(`Removed ${p.item_name}`);
    loadProducts();
  };

  const editCell = (field, props = {}) => (
    <input
      value={edit[field] ?? ''}
      onChange={(e) => setEdit({ ...edit, [field]: e.target.value })}
      className="w-full px-2 py-1 rounded border border-gray-300"
      {...props}
    />
  );

  const noStations = stations.length === 0;

  return (
    <div className="space-y-6">
      {/* Station picker — stock is managed per station */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-semibold text-slate-600">Stock at station:</span>
        {noStations ? (
          <span className="text-slate-400 text-sm">Add a station in the Stations tab first.</span>
        ) : (
          <select
            value={selectedStation}
            onChange={(e) => setSelectedStation(e.target.value)}
            className="px-4 py-2 rounded-lg border border-gray-300 bg-white"
          >
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <form
        onSubmit={handleAddProduct}
        className="bg-white rounded-2xl shadow-md p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
      >
        <input required placeholder="Item Name" value={itemName} onChange={(e) => setItemName(e.target.value)} className="px-4 py-2 rounded-lg border border-gray-300" />
        <input required type="number" placeholder="Selling Price" value={sellingPrice} onChange={(e) => setSellingPrice(e.target.value)} className="px-4 py-2 rounded-lg border border-gray-300" />
        <input required type="number" placeholder="Cost Price" value={costPrice} onChange={(e) => setCostPrice(e.target.value)} className="px-4 py-2 rounded-lg border border-gray-300" />
        <input required placeholder="Category (e.g. Beverages)" value={productCategory} onChange={(e) => setProductCategory(e.target.value)} className="px-4 py-2 rounded-lg border border-gray-300" />
        <input placeholder="Sub-category (e.g. Beer)" value={productSubCategory} onChange={(e) => setProductSubCategory(e.target.value)} className="px-4 py-2 rounded-lg border border-gray-300" />
        <select value={taxLabel} onChange={(e) => setTaxLabel(e.target.value)} className="px-4 py-2 rounded-lg border border-gray-300">
          {TAX_CATEGORIES.map((t) => (
            <option key={t.label} value={t.label}>
              Tax {t.label} — {t.desc} ({t.rate}%)
            </option>
          ))}
        </select>
        <input
          type="number"
          placeholder={selectedStation ? 'Opening stock (blank = untracked)' : 'Select a station to stock'}
          value={initialStock}
          disabled={!selectedStation}
          onChange={(e) => setInitialStock(e.target.value)}
          className="px-4 py-2 rounded-lg border border-gray-300 disabled:bg-slate-100"
        />
        <button type="submit" className="col-span-1 sm:col-span-2 lg:col-span-3 py-2 rounded-lg bg-amber-500 text-white font-semibold active:scale-95">
          Add Product
        </button>
      </form>

      {/* Bulk import from Excel/CSV */}
      <div className="bg-white rounded-2xl shadow-md p-6 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="font-semibold text-slate-700">Import from Excel / CSV</p>
            <p className="text-sm text-slate-400">
              Bulk add products &amp; stock.{' '}
              <button type="button" onClick={downloadTemplate} className="text-amber-600 underline font-semibold">
                Download template
              </button>
            </p>
          </div>
          <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
            <button
              type="button"
              onClick={() => setStockMode('set')}
              className={`px-3 py-1.5 rounded-md text-sm font-semibold ${stockMode === 'set' ? 'bg-white shadow text-slate-800' : 'text-slate-500'}`}
            >
              Set stock
            </button>
            <button
              type="button"
              onClick={() => setStockMode('add')}
              className={`px-3 py-1.5 rounded-md text-sm font-semibold ${stockMode === 'add' ? 'bg-white shadow text-slate-800' : 'text-slate-500'}`}
            >
              Add (restock)
            </button>
          </div>
        </div>
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(e) => e.target.files?.[0] && handleImportFile(e.target.files[0]) && (e.target.value = '')}
          className="block w-full text-sm text-slate-500 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-amber-500 file:text-white file:font-semibold"
        />
        {!selectedStation && (
          <p className="text-xs text-amber-600">Stock column is ignored until a station is selected above.</p>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-100 text-slate-500 text-sm uppercase">
              <tr>
                <th className="px-5 py-3">Item</th>
                <th className="px-5 py-3">Category</th>
                <th className="px-5 py-3">Sub-category</th>
                <th className="px-5 py-3">Price</th>
                <th className="px-5 py-3">Cost</th>
                <th className="px-5 py-3">Tax</th>
                <th className="px-5 py-3">Stock{selectedStation ? '' : ' (pick station)'}</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {products.map((p) => {
                const key = String(p.id);
                const qty = stockMap[key];
                const tracked = qty !== undefined;
                return edit?.id === p.id ? (
                  <tr key={p.id} className="bg-amber-50">
                    <td className="px-5 py-3">{editCell('item_name')}</td>
                    <td className="px-5 py-3">{editCell('category')}</td>
                    <td className="px-5 py-3">{editCell('sub_category')}</td>
                    <td className="px-5 py-3">{editCell('unit_price', { type: 'number' })}</td>
                    <td className="px-5 py-3">{editCell('cost_price', { type: 'number' })}</td>
                    <td className="px-5 py-3">
                      <select value={edit.tax_label ?? 'B'} onChange={(e) => setEdit({ ...edit, tax_label: e.target.value })} className="w-full px-2 py-1 rounded border border-gray-300">
                        {TAX_CATEGORIES.map((t) => (
                          <option key={t.label} value={t.label}>
                            {t.label} ({t.rate}%)
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-5 py-3 text-slate-400">—</td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      <button onClick={saveEdit} className="px-3 py-1 rounded-lg bg-emerald-600 text-white text-sm font-semibold active:scale-95">Save</button>
                      <button onClick={() => setEdit(null)} className="ml-2 px-3 py-1 rounded-lg bg-slate-100 text-slate-600 text-sm font-semibold active:scale-95">Cancel</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={p.id}>
                    <td className="px-5 py-3 font-semibold text-slate-800 whitespace-nowrap">{p.item_name}</td>
                    <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{p.category}</td>
                    <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{p.sub_category || <span className="text-slate-300">—</span>}</td>
                    <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{p.unit_price?.toLocaleString()} RWF</td>
                    <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{p.cost_price?.toLocaleString()} RWF</td>
                    <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{p.tax_label} ({p.tax_rate}%)</td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      {selectedStation ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            value={stockDraft[key] ?? (tracked ? qty : '')}
                            placeholder="—"
                            onChange={(e) => setStockDraft({ ...stockDraft, [key]: e.target.value })}
                            className={`w-16 px-2 py-1 rounded border border-gray-300 ${tracked && qty <= 0 ? 'text-red-600' : tracked && qty <= 5 ? 'text-amber-600' : ''}`}
                          />
                          <button onClick={() => setStockFor(p)} className="px-2 py-1 rounded bg-slate-100 text-slate-700 text-xs font-semibold active:scale-95">
                            Set
                          </button>
                        </div>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      <button onClick={() => startEdit(p)} className="px-3 py-1 rounded-lg bg-slate-100 text-slate-700 text-sm font-semibold active:scale-95">Edit</button>
                      <button onClick={() => deleteProduct(p)} className="ml-2 px-3 py-1 rounded-lg bg-red-50 text-red-600 text-sm font-semibold active:scale-95">Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {products.length === 0 && <p className="px-5 py-6 text-slate-400">No products yet.</p>}
      </div>

      {/* Import preview — review before anything is written */}
      {importRows && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4" onClick={() => !importing && setImportRows(null)}>
          <div className="absolute inset-0 bg-black/40" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-extrabold text-lg text-slate-900">Import preview</h3>
              <button onClick={() => !importing && setImportRows(null)} className="text-slate-400 text-2xl leading-none w-8 h-8">×</button>
            </div>
            <div className="px-5 py-2 text-sm text-slate-500 border-b border-gray-100">
              {importRows.filter((r) => !r.error && r.action === 'create').length} new ·{' '}
              {importRows.filter((r) => !r.error && r.action === 'update').length} update ·{' '}
              <span className={importRows.some((r) => r.error) ? 'text-red-600 font-semibold' : ''}>
                {importRows.filter((r) => r.error).length} error
              </span>
              {' · '}stock: {stockMode === 'set' ? 'set to value' : 'add (restock)'}
              {selectedStation ? '' : ' — no station, stock skipped'}
            </div>
            <div className="overflow-auto flex-1">
              <table className="w-full text-left text-sm">
                <thead className="text-slate-400 text-xs uppercase sticky top-0 bg-white">
                  <tr>
                    <th className="px-4 py-2">Item</th>
                    <th className="px-4 py-2">Category</th>
                    <th className="px-4 py-2">Sub-cat</th>
                    <th className="px-4 py-2">Price</th>
                    <th className="px-4 py-2">Tax</th>
                    <th className="px-4 py-2">Qty</th>
                    <th className="px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {importRows.map((r, i) => (
                    <tr key={i} className={r.error ? 'bg-red-50' : ''}>
                      <td className="px-4 py-2 font-semibold text-slate-700">{r.name || '—'}</td>
                      <td className="px-4 py-2 text-slate-500">{r.category || ''}</td>
                      <td className="px-4 py-2 text-slate-500">{r.subCategory || ''}</td>
                      <td className="px-4 py-2 text-slate-500">{r.price || (r.action === 'update' ? '(keep)' : '')}</td>
                      <td className="px-4 py-2 text-slate-500">{r.tax}</td>
                      <td className="px-4 py-2 text-slate-500">{r.qty || ''}</td>
                      <td className="px-4 py-2">
                        {r.error ? (
                          <span className="text-red-600 font-semibold">{r.error}</span>
                        ) : r.action === 'create' ? (
                          <span className="text-emerald-600 font-semibold">New</span>
                        ) : (
                          <span className="text-slate-500">Update</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="p-4 border-t border-gray-100 flex gap-3">
              <button
                onClick={() => setImportRows(null)}
                disabled={importing}
                className="flex-1 h-11 rounded-xl bg-slate-100 text-slate-600 font-bold active:scale-95 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={applyImport}
                disabled={importing || importRows.every((r) => r.error)}
                className="flex-1 h-11 rounded-xl bg-amber-500 text-white font-bold active:scale-95 disabled:opacity-50"
              >
                {importing ? 'Importing…' : `Apply ${importRows.filter((r) => !r.error).length} rows`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ExpensesTab({ notify }) {
  const [amount, setAmount] = useState('');
  const [expenseCategory, setExpenseCategory] = useState(EXPENSE_CATEGORIES[0]);
  const [description, setDescription] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [supplierTin, setSupplierTin] = useState('');
  const [ebmReceiptRef, setEbmReceiptRef] = useState('');

  const handleAddExpense = async (e) => {
    e.preventDefault();
    const { error } = await supabase.from('expenses').insert({
      business_id: getBusinessId(),
      amount: Number(amount),
      category: expenseCategory,
      description,
      supplier_tin: advancedOpen ? supplierTin || null : null,
      ebm_receipt_ref: advancedOpen ? ebmReceiptRef || null : null,
    });
    if (error) {
      notify(`Failed to log expense: ${error.message}`);
      return;
    }
    setAmount('');
    setDescription('');
    setSupplierTin('');
    setEbmReceiptRef('');
    setAdvancedOpen(false);
    notify('Expense logged');
  };

  return (
    <form onSubmit={handleAddExpense} className="max-w-lg bg-white rounded-2xl shadow-md p-6 space-y-4">
      <input
        required
        type="number"
        placeholder="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="w-full px-4 py-2 rounded-lg border border-gray-300"
      />
      <select
        value={expenseCategory}
        onChange={(e) => setExpenseCategory(e.target.value)}
        className="w-full px-4 py-2 rounded-lg border border-gray-300"
      >
        {EXPENSE_CATEGORIES.map((cat) => (
          <option key={cat} value={cat}>
            {cat}
          </option>
        ))}
      </select>
      <textarea
        placeholder="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="w-full px-4 py-2 rounded-lg border border-gray-300"
      />

      <button
        type="button"
        onClick={() => setAdvancedOpen((open) => !open)}
        className="text-slate-500 font-semibold underline text-sm"
      >
        {advancedOpen ? '− Hide' : '+ Show'} Advanced Tax Tracking
      </button>
      {advancedOpen && (
        <div className="space-y-4">
          <input
            placeholder="Supplier TIN"
            value={supplierTin}
            onChange={(e) => setSupplierTin(e.target.value)}
            className="w-full px-4 py-2 rounded-lg border border-gray-300"
          />
          <input
            placeholder="EBM Receipt Reference"
            value={ebmReceiptRef}
            onChange={(e) => setEbmReceiptRef(e.target.value)}
            className="w-full px-4 py-2 rounded-lg border border-gray-300"
          />
        </div>
      )}

      <button type="submit" className="w-full py-2 rounded-lg bg-amber-500 text-white font-semibold active:scale-95">
        Log Expense
      </button>
    </form>
  );
}

function TeamTab({ notify }) {
  const [staff, setStaff] = useState([]);
  const [stations, setStations] = useState([]);
  const [name, setName] = useState('');
  const [role, setRole] = useState('WAITER');
  const [pin, setPin] = useState('');
  const [stationId, setStationId] = useState('');

  const stationName = (id) => stations.find((s) => s.id === id)?.name;

  const loadStaff = async () => {
    const [staffRes, stationsRes] = await Promise.all([
      supabase.from('staff').select('*').eq('business_id', getBusinessId()).order('name'),
      supabase.from('stations').select('*').eq('business_id', getBusinessId()).eq('active', true).order('name'),
    ]);
    if (staffRes.error) {
      console.error('Failed to load staff:', staffRes.error.message);
      return;
    }
    setStaff(staffRes.data ?? []);
    setStations(stationsRes.data ?? []);
  };

  useEffect(() => {
    loadStaff();
  }, []);

  const assignStation = async (member, station_id) => {
    const { error } = await supabase.from('staff').update({ station_id: station_id || null }).eq('id', member.id);
    if (error) {
      notify(`Could not assign station: ${error.message}`);
      return;
    }
    loadStaff();
  };

  const handleAddStaff = async (e) => {
    e.preventDefault();
    if (!/^\d{4}$/.test(pin)) {
      notify('PIN must be exactly 4 digits');
      return;
    }
    const pin_hash = await hashPin(pin);
    // Friendly pre-check so a duplicate PIN reads as a clear message rather
    // than a raw unique-index violation. The DB index is still the source of
    // truth if two owners add at once.
    if (staff.some((s) => s.active !== false && s.pin_hash === pin_hash)) {
      notify('That PIN is already in use — pick another');
      return;
    }
    const { error } = await supabase.from('staff').insert({
      business_id: getBusinessId(),
      name,
      role,
      pin_hash,
      active: true,
      station_id: stationId || null,
    });
    if (error) {
      notify(`Could not add staff: ${error.message}`);
      return;
    }
    setName('');
    setRole('WAITER');
    setPin('');
    setStationId('');
    notify(`Added ${name}`);
    loadStaff();
  };

  const setActive = async (member, active) => {
    const { error } = await supabase.from('staff').update({ active }).eq('id', member.id);
    if (error) {
      notify(active ? `Could not re-activate: ${error.message}` : `Could not deactivate: ${error.message}`);
      return;
    }
    notify(`${member.name} ${active ? 're-activated' : 'deactivated'}`);
    loadStaff();
  };

  return (
    <div className="space-y-8">
      <form
        onSubmit={handleAddStaff}
        className="bg-white rounded-2xl shadow-md p-6 grid grid-cols-1 sm:grid-cols-4 gap-4"
      >
        <input
          required
          placeholder="Staff name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="px-4 py-2 rounded-lg border border-gray-300 sm:col-span-2"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="px-4 py-2 rounded-lg border border-gray-300"
        >
          {STAFF_ROLES.map((r) => (
            <option key={r} value={r}>
              {r.charAt(0) + r.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
        <select
          value={stationId}
          onChange={(e) => setStationId(e.target.value)}
          className="px-4 py-2 rounded-lg border border-gray-300"
        >
          <option value="">No station</option>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <input
          required
          inputMode="numeric"
          maxLength={4}
          placeholder="4-digit PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          className="px-4 py-2 rounded-lg border border-gray-300 tracking-widest"
        />
        <button
          type="submit"
          className="sm:col-span-4 py-2 rounded-lg bg-amber-500 text-white font-semibold active:scale-95"
        >
          Add Staff Member
        </button>
      </form>

      <div className="bg-white rounded-2xl shadow-md divide-y divide-gray-100">
        {staff.length === 0 ? (
          <p className="px-5 py-6 text-slate-400">No staff yet.</p>
        ) : (
          staff.map((member) => (
            <div key={member.id} className="flex items-center justify-between px-5 py-4 gap-3">
              <div className="min-w-0">
                <p
                  className={`font-semibold truncate ${
                    member.active === false ? 'text-slate-400 line-through' : 'text-slate-800'
                  }`}
                >
                  {member.name}
                </p>
                <p className="text-xs uppercase tracking-wide text-slate-400">
                  {member.role}
                  {stationName(member.station_id) ? ` · ${stationName(member.station_id)}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <select
                  value={member.station_id ?? ''}
                  onChange={(e) => assignStation(member, e.target.value)}
                  className="px-2 py-1.5 rounded-lg border border-gray-300 text-sm max-w-[8rem]"
                >
                  <option value="">No station</option>
                  {stations.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setActive(member, member.active === false)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-semibold active:scale-95 ${
                    member.active === false ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
                  }`}
                >
                  {member.active === false ? 'Re-activate' : 'Deactivate'}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, tone = 'slate' }) {
  const toneClass = { slate: 'text-slate-900', emerald: 'text-emerald-600', red: 'text-red-600' }[tone];
  return (
    <div className="bg-white rounded-2xl shadow-md p-5">
      <p className="text-xs uppercase tracking-wide text-slate-400 mb-1">{label}</p>
      <p className={`text-2xl font-extrabold ${toneClass}`}>{value}</p>
      {sub && <p className="text-sm text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

function ReportsTab() {
  const [range, setRange] = useState('today');
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const days = REPORT_RANGES.find((r) => r.key === range).days;
      const since = sinceISO(days);
      const [salesRes, productsRes, debtsRes] = await Promise.all([
        supabase
          .from('hospitality_sales')
          .select('*')
          .eq('business_id', getBusinessId())
          .gte('timestamp', since),
        supabase.from('products').select('id, item_name').eq('business_id', getBusinessId()),
        supabase.from('debts').select('amount, staff_name').eq('business_id', getBusinessId()).gte('created_at', since),
      ]);
      if (cancelled) return;

      if (salesRes.error) {
        console.error('Report load failed:', salesRes.error.message);
        setReport(null);
        setLoading(false);
        return;
      }

      const sales = salesRes.data ?? [];
      const nameById = Object.fromEntries((productsRes.data ?? []).map((p) => [p.id, p.item_name]));

      const revenue = sales.reduce((s, r) => s + (r.total_price ?? 0), 0);
      const profit = sales.reduce((s, r) => s + ((r.total_price ?? 0) - (r.cost_price ?? 0) * (r.quantity ?? 1)), 0);
      const receipts = new Set(sales.map((r) => r.receipt_no).filter(Boolean)).size;

      const byMethod = sales.reduce((acc, r) => {
        const m = r.payment_method ?? 'other';
        acc[m] = (acc[m] ?? 0) + (r.total_price ?? 0);
        return acc;
      }, {});

      const itemsMap = sales.reduce((acc, r) => {
        const key = r.item_id;
        acc[key] ||= { name: nameById[key] ?? 'Unknown item', qty: 0, revenue: 0 };
        acc[key].qty += r.quantity ?? 1;
        acc[key].revenue += r.total_price ?? 0;
        return acc;
      }, {});
      const topItems = Object.values(itemsMap).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

      const staffMap = sales.reduce((acc, r) => {
        const name = r.staff_name ?? 'Unattributed';
        acc[name] = (acc[name] ?? 0) + (r.total_price ?? 0);
        return acc;
      }, {});
      const staff = Object.entries(staffMap)
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total);

      // New debts issued in the period, by the waiter in charge.
      const debtMap = (debtsRes.data ?? []).reduce((acc, d) => {
        const name = d.staff_name ?? 'Unattributed';
        acc[name] = (acc[name] ?? 0) + (d.amount ?? 0);
        return acc;
      }, {});
      const debtsByWaiter = Object.entries(debtMap)
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total);
      const debtsTotal = debtsByWaiter.reduce((a, w) => a + w.total, 0);

      // Covers = guests served, one guest_count per receipt (not per line).
      const coversByReceipt = {};
      for (const r of sales) {
        if (r.receipt_no && r.guest_count) coversByReceipt[r.receipt_no] = r.guest_count;
      }
      const covers = Object.values(coversByReceipt).reduce((s, n) => s + n, 0);
      const perCover = covers > 0 ? revenue / covers : 0;

      setReport({ revenue, profit, receipts, count: sales.length, byMethod, topItems, staff, covers, perCover, debtsByWaiter, debtsTotal });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  const money = (n) => `${Math.round(n).toLocaleString()} RWF`;

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        {REPORT_RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setRange(r.key)}
            className={`px-4 py-2 rounded-full text-sm font-semibold transition active:scale-95 ${
              range === r.key ? 'bg-amber-500 text-white' : 'bg-white text-slate-600 shadow-sm'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-slate-400">Loading…</p>
      ) : !report ? (
        <p className="text-slate-400">Could not load report.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Revenue" value={money(report.revenue)} sub={`${report.receipts} receipt${report.receipts === 1 ? '' : 's'}`} />
            <StatCard label="Gross Profit" value={money(report.profit)} tone={report.profit >= 0 ? 'emerald' : 'red'} />
            <StatCard label="Cash" value={money(report.byMethod.cash ?? 0)} />
            <StatCard label="MoMo" value={money(report.byMethod.momo ?? 0)} />
          </div>
          {report.covers > 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard label="Covers" value={report.covers.toLocaleString()} sub="guests served" />
              <StatCard label="Avg / Cover" value={money(report.perCover)} />
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-2xl shadow-md p-5">
              <p className="font-semibold text-slate-700 mb-3">Top Items</p>
              {report.topItems.length === 0 ? (
                <p className="text-slate-400 text-sm">No sales in this period.</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {report.topItems.map((it) => (
                    <li key={it.name} className="flex justify-between py-2 text-sm">
                      <span className="text-slate-700">
                        {it.name} <span className="text-slate-400">× {it.qty}</span>
                      </span>
                      <span className="text-slate-500">{money(it.revenue)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="bg-white rounded-2xl shadow-md p-5">
              <p className="font-semibold text-slate-700 mb-3">By Waiter</p>
              {report.staff.length === 0 ? (
                <p className="text-slate-400 text-sm">No sales in this period.</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {report.staff.map((s) => (
                    <li key={s.name} className="flex justify-between py-2 text-sm">
                      <span className="text-slate-700">{s.name}</span>
                      <span className="text-slate-500">{money(s.total)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="bg-white rounded-2xl shadow-md p-5">
              <p className="font-semibold text-slate-700 mb-3">
                Debts by Waiter <span className="text-slate-400 font-normal text-sm">— new credit issued</span>
              </p>
              {(report.debtsByWaiter?.length ?? 0) === 0 ? (
                <p className="text-slate-400 text-sm">No debts issued in this period.</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {report.debtsByWaiter.map((w) => (
                    <li key={w.name} className="flex justify-between py-2 text-sm">
                      <span className="text-slate-700">{w.name}</span>
                      <span className="font-semibold text-amber-600">{money(w.total)}</span>
                    </li>
                  ))}
                  <li className="flex justify-between py-2 text-sm border-t-2 border-slate-200 font-bold">
                    <span className="text-slate-700">Total</span>
                    <span className="text-amber-600">{money(report.debtsTotal)}</span>
                  </li>
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SalesTab({ notify, currentUser }) {
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  const loadSales = async () => {
    setLoading(true);
    // Last 30 days of receipted sales. Group by receipt_no; rows that are
    // themselves refunds (refund_of set) mark their target as refunded.
    const { data, error } = await supabase
      .from('hospitality_sales')
      .select('*')
      .eq('business_id', getBusinessId())
      .gte('timestamp', sinceISO(30))
      .order('timestamp', { ascending: false });
    if (error) {
      console.error('Failed to load sales:', error.message);
      setLoading(false);
      return;
    }
    const rows = data ?? [];
    const refundedReceipts = new Set(rows.filter((r) => r.refund_of).map((r) => r.refund_of));

    const groups = {};
    for (const r of rows) {
      if (r.refund_of || !r.receipt_no) continue; // skip refund rows + un-receipted legacy sales
      const g = (groups[r.receipt_no] ||= {
        receipt_no: r.receipt_no,
        timestamp: r.timestamp,
        payment_method: r.payment_method,
        staff_name: r.staff_name,
        total: 0,
        lines: [],
        refunded: refundedReceipts.has(r.receipt_no),
      });
      g.total += r.total_price ?? 0;
      g.lines.push(r);
    }
    setReceipts(Object.values(groups).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
    setLoading(false);
  };

  useEffect(() => {
    loadSales();
  }, []);

  const refund = async (g) => {
    if (!window.confirm(`Refund receipt ${g.receipt_no} (${Math.round(g.total).toLocaleString()} RWF)?`)) return;
    setBusy(g.receipt_no);
    // Insert reversing rows: same lines, negated. refund_of ties them back.
    const reversals = g.lines.map((r) => ({
      business_id: getBusinessId(),
      item_id: r.item_id,
      quantity: -(r.quantity ?? 1),
      total_price: -(r.total_price ?? 0),
      cost_price: r.cost_price,
      tax_label: r.tax_label,
      tax_rate: r.tax_rate,
      payment_method: r.payment_method,
      staff_id: currentUser?.id ?? null,
      staff_name: currentUser?.name ?? null,
      receipt_no: r.receipt_no,
      refund_of: g.receipt_no,
      station_id: r.station_id ?? null,
      station_name: r.station_name ?? null,
      timestamp: new Date().toISOString(),
    }));
    const { error } = await supabase.from('hospitality_sales').insert(reversals);
    if (error) {
      notify(`Refund failed: ${error.message}`);
      setBusy(null);
      return;
    }
    // Put the refunded units back into the station they were sold from.
    const moves = Object.values(
      g.lines.reduce((m, r) => {
        if (!r.station_id) return m;
        const k = `${r.station_id}|${r.item_id}`;
        (m[k] ||= {
          station_id: r.station_id,
          product_id: String(r.item_id),
          business_id: getBusinessId(),
          delta: 0,
          reason: 'refund',
          staff_name: currentUser?.name ?? null,
        }).delta += r.quantity ?? 1;
        return m;
      }, {})
    );
    if (moves.length) {
      const { error: stockErr } = await supabase.rpc('apply_station_stock', { p_moves: moves });
      if (stockErr) console.error('Station stock restore failed:', stockErr.message);
    }
    await supabase.from('audit_logs').insert({
      business_id: getBusinessId(),
      action_type: 'REFUND',
      details: `Refunded receipt ${g.receipt_no} (${Math.round(g.total).toLocaleString()} RWF)`,
      staff_id: currentUser?.id ?? null,
      staff_name: currentUser?.name ?? null,
      timestamp: new Date().toISOString(),
    });
    notify(`Refunded ${g.receipt_no}`);
    setBusy(null);
    loadSales();
  };

  if (loading) return <p className="text-slate-400">Loading…</p>;
  if (receipts.length === 0) return <p className="text-slate-400 text-lg">No receipted sales in the last 30 days.</p>;

  return (
    <div className="bg-white rounded-2xl shadow-md divide-y divide-gray-100">
      {receipts.map((g) => (
        <div key={g.receipt_no} className="flex items-center justify-between px-5 py-4 gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-slate-800">
              {g.receipt_no}
              {g.refunded && <span className="ml-2 text-xs font-bold uppercase text-red-500">Refunded</span>}
            </p>
            <p className="text-xs text-slate-400">
              {new Date(g.timestamp).toLocaleString()} · {(g.payment_method ?? '—').toUpperCase()}
              {g.staff_name ? ` · ${g.staff_name}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className={`font-semibold ${g.refunded ? 'text-slate-300 line-through' : 'text-slate-700'}`}>
              {Math.round(g.total).toLocaleString()} RWF
            </span>
            <button
              onClick={() => refund(g)}
              disabled={g.refunded || busy === g.receipt_no}
              className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-sm font-semibold active:scale-95 disabled:opacity-40"
            >
              {busy === g.receipt_no ? '…' : 'Refund'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// End-of-day reconciliation for one station, laid out like the stock sheet
// Rwandan bars already use: N° · IBICURUZWA · STOCK YATANGIRANYE · IBYINJIYE ·
// TOTAL · STOCK IRAYE · IBYACURUJWE · IBICIRO · AYACURUJWE, then the VERSEMENT
// footer. STOCK IRAYE (closing) is a live physical count; sold and revenue
// derive from it, so the storeman is accountable for stock and cash.
function ReconcilePanel({ station }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]); // {id, name, price, opening, received, onHand}
  const [closing, setClosing] = useState({}); // product_id -> physical count (string)
  // VERSEMENT figures come from real data (read-only); only the counted cash is typed.
  const [salesTotal, setSalesTotal] = useState(0); // actual POS sales (matches the dashboard)
  const [cashCollected, setCashCollected] = useState(0); // completed cash payments
  const [momoCollected, setMomoCollected] = useState(0); // completed MoMo payments
  const [expensesTotal, setExpensesTotal] = useState(0); // recorded expenses
  const [actual, setActual] = useState(''); // Actual available (Ahari) — counted at close
  // Debts (amadeni) for this station: recovered & new today, plus running outstanding.
  const [debts, setDebts] = useState({ recovered: 0, started: 0, outstanding: 0 });
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const since = startOfTodayISO();
      const [productsRes, stockRes, movesRes, salesRes, expRes, debtsRes, payRes] = await Promise.all([
        supabase.from('products').select('id, item_name, unit_price, cost_price, active').eq('business_id', getBusinessId()).order('item_name'),
        supabase.from('station_stock').select('*').eq('station_id', station.id),
        supabase.from('stock_movements').select('*').eq('station_id', station.id).gte('created_at', since),
        supabase.from('hospitality_sales').select('payment_method, total_price').eq('station_id', station.id).gte('timestamp', since),
        supabase.from('expenses').select('amount').eq('business_id', getBusinessId()).gte('created_at', since),
        supabase.from('debts').select('amount, status, created_at').eq('business_id', getBusinessId()).eq('station_id', station.id),
        supabase.from('debt_payments').select('amount, created_at').eq('business_id', getBusinessId()).eq('station_id', station.id),
      ]);
      if (cancelled) return;

      // Debts (amadeni): new & recovered today, plus the running outstanding balance.
      const debtRows = debtsRes.data ?? [];
      const payRows = payRes.data ?? [];
      const startedToday = debtRows.filter((d) => d.created_at >= since).reduce((a, d) => a + (d.amount ?? 0), 0);
      const recoveredToday = payRows.filter((p) => p.created_at >= since).reduce((a, p) => a + (p.amount ?? 0), 0);
      const owed = debtRows.filter((d) => d.status !== 'void').reduce((a, d) => a + (d.amount ?? 0), 0);
      const paid = payRows.reduce((a, p) => a + (p.amount ?? 0), 0);

      const onHand = Object.fromEntries((stockRes.data ?? []).map((r) => [String(r.product_id), Number(r.quantity)]));
      // Movements today: total change (to reconstruct opening) and issues (IBYINJIYE).
      const deltaSum = {};
      const issued = {};
      for (const m of movesRes.data ?? []) {
        const k = String(m.product_id);
        deltaSum[k] = (deltaSum[k] ?? 0) + Number(m.delta);
        if (m.reason === 'issue') issued[k] = (issued[k] ?? 0) + Number(m.delta);
      }

      const list = (productsRes.data ?? [])
        .filter((p) => p.active !== false)
        .map((p) => {
          const id = String(p.id);
          const oh = onHand[id] ?? 0;
          return {
            id,
            name: p.item_name,
            price: Number(p.unit_price ?? 0),
            cost: Number(p.cost_price ?? 0),
            received: issued[id] ?? 0,
            onHand: oh,
            opening: oh - (deltaSum[id] ?? 0), // start-of-day = now minus today's movement
          };
        });

      let cashSum = 0, momoSum = 0, salesSum = 0;
      for (const s of salesRes.data ?? []) {
        const amt = s.total_price ?? 0;
        salesSum += amt;
        if (s.payment_method === 'cash') cashSum += amt;
        else if (s.payment_method === 'momo') momoSum += amt;
      }
      const expSum = (expRes.data ?? []).reduce((a, e) => a + (e.amount ?? 0), 0);

      setRows(list);
      // Closing defaults to system on-hand; the storeman overwrites with the count.
      setClosing(Object.fromEntries(list.map((r) => [r.id, String(r.onHand)])));
      setSalesTotal(Math.round(salesSum));
      setCashCollected(Math.round(cashSum));
      setMomoCollected(Math.round(momoSum));
      setExpensesTotal(Math.round(expSum));
      setDebts({ recovered: Math.round(recoveredToday), started: Math.round(startedToday), outstanding: Math.round(owed - paid) });
      // Default the counted amount to what the system expects; the storeman edits it.
      setActual(String(Math.round(cashSum + momoSum)));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [station.id]);

  const money = (n) => Math.round(n).toLocaleString();

  if (loading) return <p className="text-slate-400">Loading…</p>;

  // Live totals derived from the (editable) closing counts. The system closing
  // is what the POS thinks is left (station stock after sales); the difference
  // is the physical count minus that — negative = a shortage (missing stock).
  const computed = rows.map((r) => {
    const closingVal = Number(closing[r.id] ?? r.onHand) || 0;
    const total = r.opening + r.received;
    const sold = Math.max(0, total - closingVal);
    const systemClosing = r.onHand;
    const diffQty = closingVal - systemClosing;
    return { ...r, total, closingVal, sold, revenue: sold * r.price, systemClosing, diffQty, diffMoney: diffQty * r.price };
  });
  const totalSales = computed.reduce((a, r) => a + r.revenue, 0); // stock-derived, for the table
  const totalSold = computed.reduce((a, r) => a + r.sold, 0);
  const totalDiffQty = computed.reduce((a, r) => a + r.diffQty, 0);
  const totalDiffMoney = computed.reduce((a, r) => a + r.diffMoney, 0);
  const signed = (n) => `${n > 0 ? '+' : ''}${money(n)}`;
  const diffColor = (n) => (n < 0 ? 'text-red-600' : n > 0 ? 'text-emerald-600' : 'text-slate-300');

  // VERSEMENT: what the system expects to have been collected vs what was counted.
  const expectedCollected = cashCollected + momoCollected;
  const actualAvailable = Number(actual) || 0;
  const cashDifference = actualAvailable - expectedCollected;
  const profit = salesTotal - expensesTotal;

  // Value of the stock still on hand (the physical closing count), at cost and at
  // selling price; the gap is the gross profit expected once it's all sold.
  const stockAtCost = computed.reduce((a, r) => a + r.closingVal * r.cost, 0);
  const stockAtPrice = computed.reduce((a, r) => a + r.closingVal * r.price, 0);
  const expectedGross = stockAtPrice - stockAtCost;

  // Build the whole reconciliation as a PDF (loaded on demand). Returns the doc
  // plus a filename, so the same document can be downloaded or shared.
  const buildReconciliationPdf = async () => {
    const { jsPDF } = await import('jspdf');
    const autoTable = (await import('jspdf-autotable')).default;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const venue = (await db.meta.get('business'))?.value?.name || 'Reconciliation';
    const dateStr = new Date().toLocaleDateString();

    doc.setFontSize(16);
    doc.text(venue, 40, 42);
    doc.setFontSize(10);
    doc.setTextColor(110);
    doc.text(`Isesengura / Reconciliation — ${station.name}`, 40, 60);
    doc.text(dateStr, pageW - 40, 42, { align: 'right' });
    doc.setTextColor(0);

    autoTable(doc, {
      startY: 74,
      head: [['N°', 'IBICURUZWA', 'STOCK YATANGIRANYE', 'IBYINJIYE', 'TOTAL', 'STOCK IRAYE', 'SYSTEM', 'IBYACURUJWE', 'IBICIRO', 'AYACURUJWE', 'ITANDUKANIRO', 'ITANDUKANIRO (RWF)']],
      body: computed.map((r, i) => [
        i + 1, r.name, r.opening, r.received, r.total, r.closingVal, r.systemClosing, r.sold, money(r.price), money(r.revenue), signed(r.diffQty), signed(r.diffMoney),
      ]),
      foot: [['', 'IGITERANYO', '', '', '', '', '', totalSold, '', money(totalSales), signed(totalDiffQty), signed(totalDiffMoney)]],
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
      headStyles: { fillColor: [30, 41, 59], fontSize: 7, halign: 'right' },
      footStyles: { fillColor: [241, 245, 249], textColor: 20, fontStyle: 'bold', halign: 'right' },
      columnStyles: { 0: { halign: 'left' }, 1: { halign: 'left' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' }, 9: { halign: 'right' }, 10: { halign: 'right' }, 11: { halign: 'right' } },
      bodyStyles: { halign: 'right' },
    });

    const sumY = doc.lastAutoTable.finalY + 20;
    const rwf = (n) => `${money(n)} RWF`;
    const summary = (left, width, title, rows) =>
      autoTable(doc, {
        startY: sumY,
        margin: { left },
        tableWidth: width,
        head: [[title, '']],
        body: rows,
        theme: 'grid',
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [30, 41, 59] },
        columnStyles: { 1: { halign: 'right' } },
      });

    summary(40, 250, 'VERSEMENT', [
      ['Total Sales (Ayacurujwe)', rwf(salesTotal)],
      ['Cash Collected', rwf(cashCollected)],
      ['MoMo Collected', rwf(momoCollected)],
      ['Actual available (Ahari)', rwf(actualAvailable)],
      ['Difference', `${cashDifference > 0 ? '+' : ''}${rwf(cashDifference)}`],
      ['Daily Expenses', rwf(expensesTotal)],
      ['Profit Before Tax', rwf(profit)],
    ]);
    summary(300, 250, 'AGACIRO KA STOCK IHARI', [
      ['At cost (Ikiguzi)', rwf(stockAtCost)],
      ['At selling price (Igiciro)', rwf(stockAtPrice)],
      ['Expected gross profit', rwf(expectedGross)],
    ]);
    summary(560, 240, 'AMADENI (Debts)', [
      ['Recovered (Yishyuwe)', rwf(debts.recovered)],
      ['New today (Mashya)', rwf(debts.started)],
      ['Outstanding (Asigaye)', rwf(debts.outstanding)],
    ]);

    const safe = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    return { doc, filename: `reconciliation-${safe(station.name)}-${new Date().toISOString().slice(0, 10)}.pdf` };
  };

  const downloadPdf = async () => {
    setPdfBusy(true);
    try {
      const { doc, filename } = await buildReconciliationPdf();
      doc.save(filename);
    } catch (err) {
      console.error('PDF failed:', err);
      window.alert('Could not build the PDF.');
    } finally {
      setPdfBusy(false);
    }
  };

  const sharePdf = async () => {
    setPdfBusy(true);
    try {
      const { doc, filename } = await buildReconciliationPdf();
      const file = new File([doc.output('blob')], filename, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
      } else {
        doc.save(filename); // desktop / unsupported — fall back to a download
      }
    } catch (err) {
      if (err?.name !== 'AbortError') console.error('Share failed:', err);
    } finally {
      setPdfBusy(false);
    }
  };

  const numInput = (value, onChange, extra = '') => (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-24 px-2 py-1 rounded border border-gray-300 text-right ${extra}`}
    />
  );

  return (
    <div className="space-y-4">
      {/* Export the whole reconciliation report as a PDF (download or share). */}
      <div className="flex justify-end gap-2">
        <button
          onClick={downloadPdf}
          disabled={pdfBusy}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-slate-900 text-white active:scale-95 disabled:opacity-50"
        >
          {pdfBusy ? 'Preparing…' : '⬇ Download PDF'}
        </button>
        <button
          onClick={sharePdf}
          disabled={pdfBusy}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-amber-500 text-white active:scale-95 disabled:opacity-50"
        >
          ↗ Share
        </button>
      </div>

      <div className="overflow-x-auto bg-white rounded-xl shadow-md">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-slate-100 text-slate-600 text-[11px]">
            <tr>
              <th className="px-2 py-2">N°</th>
              <th className="px-2 py-2">IBICURUZWA<div className="font-normal text-slate-400 normal-case">Item</div></th>
              <th className="px-2 py-2 text-right">STOCK YATANGIRANYE<div className="font-normal text-slate-400 normal-case">Opening</div></th>
              <th className="px-2 py-2 text-right">IBYINJIYE<div className="font-normal text-slate-400 normal-case">In</div></th>
              <th className="px-2 py-2 text-right">TOTAL</th>
              <th className="px-2 py-2 text-right">STOCK IRAYE<div className="font-normal text-slate-400 normal-case">Closing count</div></th>
              <th className="px-2 py-2 text-right">SYSTEM<div className="font-normal text-slate-400 normal-case">System closing</div></th>
              <th className="px-2 py-2 text-right">IBYACURUJWE<div className="font-normal text-slate-400 normal-case">Sold</div></th>
              <th className="px-2 py-2 text-right">IBICIRO<div className="font-normal text-slate-400 normal-case">Price</div></th>
              <th className="px-2 py-2 text-right">AYACURUJWE<div className="font-normal text-slate-400 normal-case">Revenue</div></th>
              <th className="px-2 py-2 text-right">ITANDUKANIRO<div className="font-normal text-slate-400 normal-case">Difference (qty)</div></th>
              <th className="px-2 py-2 text-right">ITANDUKANIRO (RWF)<div className="font-normal text-slate-400 normal-case">Difference value</div></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {computed.map((r, i) => (
              <tr key={r.id}>
                <td className="px-2 py-1.5 text-slate-400">{i + 1}</td>
                <td className="px-2 py-1.5 font-semibold text-slate-700">{r.name}</td>
                <td className="px-2 py-1.5 text-right text-slate-500">{r.opening}</td>
                <td className="px-2 py-1.5 text-right text-slate-500">{r.received}</td>
                <td className="px-2 py-1.5 text-right text-slate-500">{r.total}</td>
                <td className="px-2 py-1.5 text-right">
                  <input
                    type="number"
                    value={closing[r.id] ?? ''}
                    onChange={(e) => setClosing({ ...closing, [r.id]: e.target.value })}
                    className="w-16 px-2 py-1 rounded border border-gray-300 text-right"
                  />
                </td>
                <td className="px-2 py-1.5 text-right text-slate-500">{r.systemClosing}</td>
                <td className="px-2 py-1.5 text-right font-semibold text-slate-800">{r.sold}</td>
                <td className="px-2 py-1.5 text-right text-slate-500">{money(r.price)}</td>
                <td className="px-2 py-1.5 text-right font-semibold text-slate-800">{money(r.revenue)}</td>
                <td className={`px-2 py-1.5 text-right font-semibold ${diffColor(r.diffQty)}`}>{signed(r.diffQty)}</td>
                <td className={`px-2 py-1.5 text-right font-semibold ${diffColor(r.diffMoney)}`}>{signed(r.diffMoney)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-100 border-t-2 border-slate-200 text-slate-800">
            <tr className="font-bold">
              <td className="px-2 py-2" />
              <td className="px-2 py-2">IGITERANYO<div className="font-normal text-slate-400 text-[11px] normal-case">Totals</div></td>
              <td className="px-2 py-2" />
              <td className="px-2 py-2" />
              <td className="px-2 py-2" />
              <td className="px-2 py-2" />
              <td className="px-2 py-2" />
              <td className="px-2 py-2 text-right">{totalSold}</td>
              <td className="px-2 py-2" />
              <td className="px-2 py-2 text-right">{money(totalSales)}</td>
              <td className={`px-2 py-2 text-right ${diffColor(totalDiffQty)}`}>{signed(totalDiffQty)}</td>
              <td className={`px-2 py-2 text-right ${diffColor(totalDiffMoney)}`}>{signed(totalDiffMoney)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 lg:items-start">
      {/* VERSEMENT — end-of-day reconciliation */}
      <div className="bg-white rounded-xl shadow-md p-4 w-full lg:max-w-md">
        <p className="font-extrabold text-slate-800 mb-3">VERSEMENT <span className="text-slate-400 font-normal text-sm">— end of day</span></p>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between items-center">
            <span className="text-slate-600">Total Sales (Ayacurujwe)</span>
            <span className="font-bold text-slate-900">{money(salesTotal)} RWF</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-slate-600">Cash Collected</span>
            <span className="font-semibold text-slate-800">{money(cashCollected)} RWF</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-slate-600">MoMo Collected</span>
            <span className="font-semibold text-slate-800">{money(momoCollected)} RWF</span>
          </div>
          <div className="flex justify-between items-center border-t border-gray-100 pt-2">
            <span className="text-slate-600">Actual available (Ahari)</span>
            {numInput(actual, setActual)}
          </div>
          <div className="flex justify-between items-center">
            <span className="text-slate-600">Difference</span>
            <span className={`font-bold ${cashDifference === 0 ? 'text-emerald-600' : 'text-red-600'}`}>
              {cashDifference > 0 ? '+' : ''}{money(cashDifference)} RWF
            </span>
          </div>
          <div className="flex justify-between items-center border-t border-gray-100 pt-2">
            <span className="text-slate-600">Daily Expenses</span>
            <span className="font-semibold text-slate-800">{money(expensesTotal)} RWF</span>
          </div>
          <div className="flex justify-between items-center border-t border-gray-100 pt-2">
            <span className="text-slate-700 font-semibold">Profit Before Tax</span>
            <span className="font-extrabold text-emerald-600">{money(profit)} RWF</span>
          </div>
        </div>
      </div>

      {/* Right column: stock value on top, debts below it. */}
      <div className="w-full lg:max-w-sm space-y-4">
        {/* AGACIRO KA STOCK IHARI — value of the stock still on hand */}
        <div className="bg-white rounded-xl shadow-md p-4">
          <p className="font-extrabold text-slate-800 mb-3">
            AGACIRO KA STOCK IHARI <span className="text-slate-400 font-normal text-sm">— stock value on hand</span>
          </p>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-slate-600">At cost (Ikiguzi)</span>
              <span className="font-semibold text-slate-800">{money(stockAtCost)} RWF</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-600">At selling price (Igiciro)</span>
              <span className="font-semibold text-slate-800">{money(stockAtPrice)} RWF</span>
            </div>
            <div className="flex justify-between items-center border-t border-gray-100 pt-2">
              <span className="text-slate-700 font-semibold">Expected gross profit</span>
              <span className="font-extrabold text-emerald-600">{money(expectedGross)} RWF</span>
            </div>
          </div>
        </div>

        {/* AMADENI — debts. Figures come from the (future) debt-management
            feature; until then they read zero. */}
        <div className="bg-white rounded-xl shadow-md p-4">
          <p className="font-extrabold text-slate-800 mb-3">
            AMADENI <span className="text-slate-400 font-normal text-sm">— debts</span>
          </p>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-slate-600">Recovered (Yishyuwe)</span>
              <span className="font-semibold text-emerald-600">{money(debts.recovered)} RWF</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-600">New today (Mashya)</span>
              <span className="font-semibold text-slate-800">{money(debts.started)} RWF</span>
            </div>
            <div className="flex justify-between items-center border-t border-gray-100 pt-2">
              <span className="text-slate-700 font-semibold">Outstanding (Asigaye)</span>
              <span className="font-extrabold text-amber-600">{money(debts.outstanding)} RWF</span>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

// Dedicated daily reconciliation view — picks a station (auto for single-station
// venues) and shows its stock sheet + VERSEMENT. This is the storeman's main
// end-of-day screen, so it's a top-level tab rather than buried under Stations.
function ReconcileTab() {
  const [stations, setStations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('stations')
        .select('*')
        .eq('business_id', getBusinessId())
        .eq('active', true)
        .order('name');
      setStations(data ?? []);
      setSelectedId((cur) => cur || data?.[0]?.id || null);
    })();
  }, []);

  if (stations.length === 0) {
    return <p className="text-slate-500 text-lg">No stations yet — add one in the Stations tab to reconcile.</p>;
  }

  const selected = stations.find((s) => s.id === selectedId) ?? stations[0];

  return (
    <div className="space-y-4">
      {stations.length > 1 && (
        <div className="flex gap-2 flex-wrap">
          {stations.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={`px-4 py-2 rounded-full text-sm font-semibold transition active:scale-95 ${
                selected.id === s.id ? 'bg-amber-500 text-white' : 'bg-white text-slate-600 shadow-sm'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <ReconcilePanel key={selected.id} station={selected} />
    </div>
  );
}

function StationsTab({ notify }) {
  const [stations, setStations] = useState([]);
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

  const loadStations = async () => {
    const { data, error } = await supabase
      .from('stations')
      .select('*')
      .eq('business_id', getBusinessId())
      .order('name');
    if (error) {
      console.error('Failed to load stations:', error.message);
      return;
    }
    setStations(data ?? []);
  };

  useEffect(() => {
    loadStations();
  }, []);

  const addStation = async (e) => {
    e.preventDefault();
    const { error } = await supabase
      .from('stations')
      .insert({ business_id: getBusinessId(), name: name.trim() });
    if (error) {
      notify(`Could not add station: ${error.message}`);
      return;
    }
    setName('');
    notify(`Added ${name.trim()}`);
    loadStations();
  };

  const saveRename = async (station) => {
    const { error } = await supabase.from('stations').update({ name: editName.trim() }).eq('id', station.id);
    if (error) {
      notify(`Could not rename: ${error.message}`);
      return;
    }
    setEditingId(null);
    loadStations();
  };

  const setActive = async (station, active) => {
    const { error } = await supabase.from('stations').update({ active }).eq('id', station.id);
    if (error) {
      notify(`Could not update: ${error.message}`);
      return;
    }
    notify(`${station.name} ${active ? 're-activated' : 'deactivated'}`);
    loadStations();
  };

  return (
    <div className="space-y-8">
      <form onSubmit={addStation} className="bg-white rounded-2xl shadow-md p-6 flex flex-col sm:flex-row gap-3">
        <input
          required
          placeholder="Station name (e.g. Main Bar, Pool Bar, Reception)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 px-4 py-2 rounded-lg border border-gray-300"
        />
        <button type="submit" className="px-6 py-2 rounded-lg bg-amber-500 text-white font-semibold active:scale-95">
          Add Station
        </button>
      </form>

      <div className="bg-white rounded-2xl shadow-md divide-y divide-gray-100">
        {stations.length === 0 ? (
          <p className="px-5 py-6 text-slate-400">No stations yet. Add your selling points above.</p>
        ) : (
          stations.map((s) => (
            <div key={s.id}>
              <div className="flex items-center justify-between px-5 py-4 gap-3">
                {editingId === s.id ? (
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 px-3 py-1.5 rounded-lg border border-gray-300"
                  />
                ) : (
                  <span className={`font-semibold ${s.active === false ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
                    {s.name}
                  </span>
                )}
                <div className="flex items-center gap-2 shrink-0">
                  {editingId === s.id ? (
                    <>
                      <button onClick={() => saveRename(s)} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold active:scale-95">
                        Save
                      </button>
                      <button onClick={() => setEditingId(null)} className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-sm font-semibold active:scale-95">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => { setEditingId(s.id); setEditName(s.name); }}
                        className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-sm font-semibold active:scale-95"
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => setActive(s, s.active === false)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-semibold active:scale-95 ${
                          s.active === false ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
                        }`}
                      >
                        {s.active === false ? 'Re-activate' : 'Deactivate'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Debt management (amadeni): outstanding debts customers took on credit at the
// POS, each stamped with the waiter in charge. The owner records recoveries
// (debt_payments) here; a debt settles once fully paid.
function DebtsTab({ notify, currentUser }) {
  const [debts, setDebts] = useState([]);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showSettled, setShowSettled] = useState(false);
  const [payFor, setPayFor] = useState(null); // debt being recovered
  const [payAmount, setPayAmount] = useState('');
  const money = (n) => Math.round(n || 0).toLocaleString();

  const load = async () => {
    setLoading(true);
    const [dRes, pRes] = await Promise.all([
      supabase.from('debts').select('*').eq('business_id', getBusinessId()).order('created_at', { ascending: false }),
      supabase.from('debt_payments').select('*').eq('business_id', getBusinessId()),
    ]);
    if (dRes.error) console.error('Failed to load debts:', dRes.error.message);
    setDebts(dRes.data ?? []);
    setPayments(pRes.data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const paidFor = (debtId) => payments.filter((p) => p.debt_id === debtId).reduce((a, p) => a + (p.amount ?? 0), 0);
  const rows = debts
    .filter((d) => d.status !== 'void')
    .map((d) => {
      const paid = paidFor(d.id);
      return { ...d, paid, remaining: Math.max(0, (d.amount ?? 0) - paid), settled: d.status === 'settled' || paid >= (d.amount ?? 0) };
    });
  const open = rows.filter((r) => !r.settled);
  const outstanding = open.reduce((a, r) => a + r.remaining, 0);
  const recoveredAll = payments.reduce((a, p) => a + (p.amount ?? 0), 0);
  const visible = showSettled ? rows : open;

  const openPay = (d) => {
    setPayFor(d);
    setPayAmount(String(Math.round(d.remaining)));
  };

  const recordPayment = async () => {
    const amount = Number(payAmount);
    if (!amount || amount <= 0) return notify('Enter an amount');
    const capped = Math.min(amount, payFor.remaining);
    const { error } = await supabase.from('debt_payments').insert({
      business_id: getBusinessId(),
      debt_id: payFor.id,
      amount: capped,
      staff_id: currentUser?.id ?? null,
      staff_name: currentUser?.name ?? 'Owner',
      station_id: payFor.station_id ?? null,
      station_name: payFor.station_name ?? null,
    });
    if (error) return notify(`Could not record payment: ${error.message}`);
    // Settle the debt once fully paid.
    if (payFor.paid + capped >= (payFor.amount ?? 0)) {
      await supabase.from('debts').update({ status: 'settled' }).eq('id', payFor.id);
    }
    notify(`Recovered ${money(capped)} from ${payFor.customer_name}`);
    setPayFor(null);
    setPayAmount('');
    load();
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard label="Outstanding" value={`${compactMoney(outstanding)} RWF`} tone={outstanding ? 'red' : 'slate'} sub={`${open.length} open`} />
        <StatCard label="Recovered" value={`${compactMoney(recoveredAll)} RWF`} tone="emerald" sub="all time" />
        <StatCard label="Debts" value={rows.length.toLocaleString()} />
      </div>

      <div className="flex items-center justify-between">
        <p className="text-slate-500 font-semibold">
          {showSettled ? 'All debts' : 'Open debts'} <span className="text-slate-400 font-normal">— taken on credit at the POS</span>
        </p>
        <button
          onClick={() => setShowSettled((v) => !v)}
          className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-slate-100 text-slate-600 active:scale-95"
        >
          {showSettled ? 'Hide settled' : 'Show settled'}
        </button>
      </div>

      {loading ? (
        <p className="text-slate-400">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-md px-5 py-6 text-slate-400">No {showSettled ? '' : 'open '}debts.</div>
      ) : (
        <div className="bg-white rounded-2xl shadow-md divide-y divide-gray-100">
          {visible.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 px-5 py-4">
              <div className="min-w-0">
                <p className={`font-semibold truncate ${d.settled ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{d.customer_name}</p>
                <p className="text-xs text-slate-400 truncate">
                  {new Date(d.created_at).toLocaleDateString()} · 👤 {d.staff_name || '—'}
                  {d.station_name ? ` · ${d.station_name}` : ''}
                  {d.note ? ` · ${d.note}` : ''}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-bold text-slate-900 tabular-nums">{money(d.remaining)} RWF</p>
                {d.paid > 0 && !d.settled && <p className="text-[11px] text-slate-400 tabular-nums">of {money(d.amount)}</p>}
                {d.settled && <p className="text-[11px] text-emerald-600 font-semibold">Settled</p>}
              </div>
              {!d.settled && (
                <button
                  onClick={() => openPay(d)}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-sm font-semibold bg-emerald-500 text-white active:scale-95"
                >
                  Record payment
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Record-payment modal */}
      {payFor && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setPayFor(null)}>
          <div className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div>
              <p className="font-bold text-slate-800">Record payment</p>
              <p className="text-sm text-slate-400 truncate">
                {payFor.customer_name} — {money(payFor.remaining)} RWF outstanding
              </p>
            </div>
            <input
              type="number"
              inputMode="numeric"
              autoFocus
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg border border-gray-300 tabular-nums text-right"
            />
            <div className="flex gap-2">
              <button onClick={() => setPayFor(null)} className="flex-1 py-2.5 rounded-lg bg-slate-100 text-slate-600 font-semibold active:scale-95">
                Cancel
              </button>
              <button onClick={recordPayment} className="flex-1 py-2.5 rounded-lg bg-emerald-500 text-white font-semibold active:scale-95">
                Record
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Printable table/room QR codes. Each encodes a link to this app that drops the
// guest straight into read-only self-service for THIS venue, with the table
// pre-filled — so a customer scans the code on their own phone and orders. The
// link is deterministic (venue id + label), so codes are reproducible without
// storing them; the label list is just remembered locally for convenience.
function PortalQrTab({ notify }) {
  const [labels, setLabels] = useState([]);
  const [input, setInput] = useState('');
  const [quickN, setQuickN] = useState('');
  const [qrMap, setQrMap] = useState({}); // label -> QR data URL
  const [appUrl, setAppUrl] = useState(''); // configured public app link (Settings)

  // Codes point to the App link set in Settings; fall back to this device's URL.
  const base = (appUrl || window.location.origin).replace(/\/+$/, '');
  const isLocal = /localhost|127\.0\.0\.1|\b0\.0\.0\.0\b/.test(base);
  const urlFor = (label) => `${base}/?s=${encodeURIComponent(getBusinessId())}&t=${encodeURIComponent(label)}`;

  useEffect(() => {
    (async () => {
      const row = await db.meta.get('portal_labels');
      if (Array.isArray(row?.value) && row.value.length) setLabels(row.value);
      const biz = (await db.meta.get('business'))?.value;
      if (biz?.app_url) setAppUrl(biz.app_url);
    })();
  }, []);

  // Regenerate QR images whenever the label list changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (labels.length === 0) {
        setQrMap({});
        return;
      }
      const QRCode = await import('qrcode');
      const entries = await Promise.all(
        labels.map(async (l) => [l, await QRCode.toDataURL(urlFor(l), { width: 400, margin: 1 })])
      );
      if (!cancelled) setQrMap(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, base]);

  const persist = (next) => {
    setLabels(next);
    db.meta.put({ key: 'portal_labels', value: next });
  };
  const addLabel = () => {
    const v = input.trim();
    if (!v) return;
    if (labels.includes(v)) {
      notify('Already added');
      return;
    }
    persist([...labels, v]);
    setInput('');
  };
  const addTables = () => {
    const n = Math.min(Number(quickN) || 0, 100);
    if (n < 1) return;
    const next = [...labels];
    for (let i = 1; i <= n; i++) {
      const l = `Table ${i}`;
      if (!next.includes(l)) next.push(l);
    }
    persist(next);
    setQuickN('');
  };
  const removeLabel = (l) => persist(labels.filter((x) => x !== l));

  // Print a self-contained sheet of all codes (opens a clean print window so it
  // doesn't fight the dashboard layout). Each card is cut-and-place ready.
  const printAll = () => {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const cards = labels
      .map(
        (l) => `<div class="card"><img src="${qrMap[l] || ''}"/><div class="label">${esc(l)}</div><div class="hint">Scan to order</div></div>`
      )
      .join('');
    const html = `<!doctype html><html><head><title>Order QR codes</title><style>
      *{font-family:sans-serif;box-sizing:border-box}
      .grid{display:flex;flex-wrap:wrap;gap:16px;padding:16px;justify-content:center}
      .card{width:240px;border:1px dashed #999;border-radius:12px;padding:14px;text-align:center;page-break-inside:avoid}
      .card img{width:210px;height:210px}
      .label{font-weight:800;font-size:20px;margin-top:8px}
      .hint{color:#666;font-size:12px;margin-top:2px}
    </style></head><body><div class="grid">${cards}</div>
    <script>window.onload=function(){window.print()}<\/script></body></html>`;
    const w = window.open('', '_blank');
    if (!w) {
      notify('Allow pop-ups to print');
      return;
    }
    w.document.write(html);
    w.document.close();
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="bg-white rounded-2xl shadow-md p-5 sm:p-6 space-y-4">
        <div>
          <p className="font-semibold text-slate-700">Table &amp; room QR codes</p>
          <p className="text-sm text-slate-400">
            Print these and place them on tables or in rooms. A guest scans one with their phone to open self-service — the table is filled in
            automatically, so their order reaches the right table.
          </p>
          <p className="text-xs text-slate-400 mt-2">
            Codes point to: <span className="font-mono text-slate-600 break-all">{base}</span>
          </p>
          {isLocal && (
            <p className="text-xs text-amber-600 mt-1">
              This is a local address — other phones can’t open it. Set your public <span className="font-semibold">App link</span> in Settings first.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">Add a table / room</span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addLabel()}
              placeholder="e.g. Table 7 or Room 101"
              className="w-52 px-4 py-2 rounded-lg border border-gray-300"
            />
          </label>
          <button onClick={addLabel} className="px-5 py-2 rounded-lg bg-slate-900 text-white font-semibold active:scale-95">
            Add
          </button>
          <span className="text-slate-300">|</span>
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">Quick add tables 1–N</span>
            <input
              type="number"
              inputMode="numeric"
              value={quickN}
              onChange={(e) => setQuickN(e.target.value)}
              placeholder="e.g. 10"
              className="w-28 px-4 py-2 rounded-lg border border-gray-300 tabular-nums"
            />
          </label>
          <button onClick={addTables} className="px-5 py-2 rounded-lg bg-slate-100 text-slate-700 font-semibold active:scale-95">
            Add tables
          </button>
        </div>
      </div>

      {labels.length > 0 && (
        <div className="flex items-center justify-between flex-wrap gap-3">
          <p className="text-slate-500 font-semibold">{labels.length} code{labels.length === 1 ? '' : 's'}</p>
          <button onClick={printAll} className="px-6 py-2.5 rounded-xl bg-amber-500 text-white font-bold active:scale-95">
            🖨️ Print all
          </button>
        </div>
      )}

      {labels.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-md px-5 py-6 text-slate-400">No codes yet — add a table or room above.</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {labels.map((l) => (
            <div key={l} className="bg-white rounded-2xl shadow-md p-4 flex flex-col items-center gap-2 text-center">
              {qrMap[l] ? (
                <img src={qrMap[l]} alt={`QR for ${l}`} className="w-full max-w-[160px] aspect-square" />
              ) : (
                <div className="w-full max-w-[160px] aspect-square bg-slate-100 rounded-lg animate-pulse" />
              )}
              <p className="font-bold text-slate-800 truncate w-full">{l}</p>
              <button onClick={() => removeLabel(l)} className="text-xs font-semibold text-red-600 active:scale-95">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// One place for the venue's business constants — reused across receipts,
// payments and the loyalty rule. Persisted on the `businesses` row and mirrored
// into local meta so the POS can print a complete bill offline.
function SettingsTab({ notify }) {
  const [f, setF] = useState(null); // form fields, null until loaded
  const [saving, setSaving] = useState(false);
  const set = (patch) => setF((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('businesses')
        .select('name, address, phone, email, tin, momo_code, receipt_footer, loyalty_threshold, loyalty_reward_pct, app_url')
        .eq('id', getBusinessId())
        .single();
      if (error) {
        notify(`Could not load settings: ${error.message}`);
        setF({});
        return;
      }
      setF({
        name: data.name ?? '',
        address: data.address ?? '',
        phone: data.phone ?? '',
        email: data.email ?? '',
        tin: data.tin ?? '',
        momo_code: data.momo_code ?? '',
        receipt_footer: data.receipt_footer ?? '',
        loyalty_threshold: data.loyalty_threshold ?? '',
        loyalty_reward_pct: data.loyalty_reward_pct ?? '',
        app_url: data.app_url ?? '',
      });
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    const payload = {
      name: f.name?.trim() || 'My Venue',
      address: f.address?.trim() || null,
      phone: f.phone?.trim() || null,
      email: f.email?.trim() || null,
      tin: f.tin?.trim() || null,
      momo_code: f.momo_code?.trim() || null,
      receipt_footer: f.receipt_footer?.trim() || null,
      loyalty_threshold: f.loyalty_threshold === '' ? null : Number(f.loyalty_threshold),
      loyalty_reward_pct: f.loyalty_reward_pct === '' ? null : Number(f.loyalty_reward_pct),
      app_url: f.app_url?.trim().replace(/\/+$/, '') || null,
    };
    const { error } = await supabase.from('businesses').update(payload).eq('id', getBusinessId());
    setSaving(false);
    if (error) return notify(`Could not save: ${error.message}`);
    // Keep the local mirror in step so the next printed bill uses the new info.
    await db.meta.put({ key: 'business', value: payload });
    notify('Settings saved');
  };

  if (!f) return <p className="text-slate-400">Loading…</p>;

  const field = (label, key, props = {}) => (
    <label className="text-sm block">
      <span className="block text-slate-500 mb-1">{label}</span>
      <input
        value={f[key] ?? ''}
        onChange={(e) => set({ [key]: e.target.value })}
        className="w-full px-4 py-2.5 rounded-lg border border-gray-300"
        {...props}
      />
    </label>
  );

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Business identity — printed at the top of every receipt */}
      <div className="bg-white rounded-2xl shadow-md p-5 sm:p-6 space-y-4">
        <div>
          <p className="font-semibold text-slate-700">Business identity</p>
          <p className="text-sm text-slate-400">Shown at the top of printed and shared bills.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field('Business name', 'name')}
          {field('TIN', 'tin', { inputMode: 'numeric' })}
          {field('Phone', 'phone', { type: 'tel' })}
          {field('Email', 'email', { type: 'email' })}
          <div className="sm:col-span-2">{field('Address', 'address')}</div>
        </div>
      </div>

      {/* Payments */}
      <div className="bg-white rounded-2xl shadow-md p-5 sm:p-6 space-y-4">
        <div>
          <p className="font-semibold text-slate-700">Payments</p>
          <p className="text-sm text-slate-400">Your MoMo pay number / code is printed on the bill so guests can pay.</p>
        </div>
        {field('MoMo pay number / code', 'momo_code', { inputMode: 'numeric', placeholder: 'e.g. 0788123456 or *182*8*1*CODE#' })}
      </div>

      {/* Receipt footer */}
      <div className="bg-white rounded-2xl shadow-md p-5 sm:p-6 space-y-4">
        <div>
          <p className="font-semibold text-slate-700">Receipt footer</p>
          <p className="text-sm text-slate-400">A short thank-you or note at the bottom of the bill.</p>
        </div>
        {field('Footer message', 'receipt_footer', { placeholder: 'e.g. Murakoze! Come again.' })}
      </div>

      {/* Self-service link — the public app URL the table/room QR codes point to */}
      <div className="bg-white rounded-2xl shadow-md p-5 sm:p-6 space-y-4">
        <div>
          <p className="font-semibold text-slate-700">Self-service link</p>
          <p className="text-sm text-slate-400">
            The public address of this app — used for the table/room QR codes so a guest's phone can open them. Paste the link you see in the
            browser when the app is deployed (not localhost).
          </p>
        </div>
        {field('App link', 'app_url', { type: 'url', placeholder: 'e.g. https://your-venue.vercel.app' })}
      </div>

      {/* Loyalty reward rule (moved here from Customers) */}
      <div className="bg-white rounded-2xl shadow-md p-5 sm:p-6 space-y-4">
        <div>
          <p className="font-semibold text-slate-700">Loyalty reward</p>
          <p className="text-sm text-slate-400">
            Flag a customer for a coupon once their lifetime spend reaches this target. Leave blank to grant coupons only by hand.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field('Spend reaches (RWF)', 'loyalty_threshold', { type: 'number', inputMode: 'numeric', placeholder: 'e.g. 50000' })}
          {field('Reward (% off)', 'loyalty_reward_pct', { type: 'number', inputMode: 'numeric', placeholder: 'e.g. 10' })}
        </div>
      </div>

      <button
        onClick={save}
        disabled={saving}
        className="w-full sm:w-auto px-8 py-3 rounded-xl bg-amber-500 text-white font-bold active:scale-95 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save settings'}
      </button>
    </div>
  );
}

// Compact money for tight stat cards: 2,500,000 -> "2.5M", 45,000 -> "45k".
// Keeps big lifetime-spend figures from overflowing a phone-width card.
function compactMoney(n) {
  const v = Math.round(n || 0);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)}k`;
  return v.toLocaleString();
}
const couponLabel = (c) => (c.kind === 'percent' ? `${c.value}% off` : `${Number(c.value).toLocaleString()} RWF off`);

function CustomersTab({ notify }) {
  const [customers, setCustomers] = useState([]);
  const [stats, setStats] = useState({}); // customer_id -> { spend, profit, visits, last }
  const [coupons, setCoupons] = useState({}); // customer_id -> [active coupons]
  const [masterSet, setMasterSet] = useState(false);
  const [master, setMaster] = useState('');
  const [rule, setRule] = useState({ threshold: '', pct: '' }); // loyalty auto-reward
  const [grantFor, setGrantFor] = useState(null); // customer being granted a manual coupon
  const [grant, setGrant] = useState({ kind: 'percent', value: '', reason: '' });
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [cRes, bRes, sRes, cpRes] = await Promise.all([
      supabase.from('customers').select('*').eq('business_id', getBusinessId()).order('username'),
      supabase.from('businesses').select('customer_master_hash, loyalty_threshold, loyalty_reward_pct').eq('id', getBusinessId()).single(),
      supabase
        .from('hospitality_sales')
        .select('customer_id, total_price, cost_price, quantity, receipt_no, timestamp')
        .eq('business_id', getBusinessId())
        .not('customer_id', 'is', null),
      supabase.from('customer_coupons').select('*').eq('business_id', getBusinessId()).eq('status', 'active'),
    ]);
    if (cRes.error) console.error('Failed to load customers:', cRes.error.message);
    else setCustomers(cRes.data ?? []);
    if (!bRes.error && bRes.data) {
      setMasterSet(!!bRes.data.customer_master_hash);
      setRule({ threshold: bRes.data.loyalty_threshold ?? '', pct: bRes.data.loyalty_reward_pct ?? '' });
    }
    // Aggregate spend / profit / visits / last visit per customer.
    const agg = {};
    for (const r of sRes.data ?? []) {
      const a = (agg[r.customer_id] ||= { spend: 0, profit: 0, receipts: new Set(), last: 0 });
      a.spend += r.total_price ?? 0;
      a.profit += (r.total_price ?? 0) - (r.cost_price ?? 0) * (r.quantity ?? 1);
      if (r.receipt_no) a.receipts.add(r.receipt_no);
      const t = new Date(r.timestamp).getTime();
      if (t > a.last) a.last = t;
    }
    setStats(Object.fromEntries(Object.entries(agg).map(([id, a]) => [id, { spend: a.spend, profit: a.profit, visits: a.receipts.size, last: a.last }])));
    // Group active coupons by customer.
    const byCust = {};
    for (const cp of cpRes.data ?? []) (byCust[cp.customer_id] ||= []).push(cp);
    setCoupons(byCust);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const saveMaster = async () => {
    if (!master) return notify('Enter a master password');
    const customer_master_hash = await hashPin(master);
    const { error } = await supabase.from('businesses').update({ customer_master_hash }).eq('id', getBusinessId());
    if (error) return notify(`Could not save: ${error.message}`);
    setMaster('');
    setMasterSet(true);
    notify('Customer master password saved');
  };

  const setActive = async (c, active) => {
    const { error } = await supabase.from('customers').update({ active }).eq('id', c.id);
    if (error) return notify(`Could not update: ${error.message}`);
    notify(`${c.username} ${active ? 're-activated' : 'deactivated'}`);
    load();
  };

  const addCoupon = async (c, kind, value, reason) => {
    const { error } = await supabase.from('customer_coupons').insert({
      business_id: getBusinessId(),
      customer_id: c.id,
      customer_username: c.username,
      kind,
      value,
      reason: reason || null,
      status: 'active',
    });
    if (error) return notify(`Could not grant coupon: ${error.message}`);
    notify(`Coupon granted to ${c.username}`);
    load();
  };

  const grantReward = (c) => addCoupon(c, 'percent', Number(rule.pct), `Loyalty — spent ${Number(rule.threshold).toLocaleString()}+`);

  const submitGrant = async () => {
    const value = Number(grant.value);
    if (!value || value <= 0) return notify('Enter a coupon value');
    if (grant.kind === 'percent' && value > 100) return notify('Percent must be 100 or less');
    await addCoupon(grantFor, grant.kind, value, grant.reason.trim());
    setGrantFor(null);
    setGrant({ kind: 'percent', value: '', reason: '' });
  };

  const ruleActive = Number(rule.threshold) > 0 && Number(rule.pct) > 0;
  const eligible = (c) => ruleActive && (stats[c.id]?.spend ?? 0) >= Number(rule.threshold) && (coupons[c.id]?.length ?? 0) === 0;

  // Customers sorted by lifetime spend (best customers first).
  const ranked = [...customers].sort((a, b) => (stats[b.id]?.spend ?? 0) - (stats[a.id]?.spend ?? 0));
  const totalSpend = Object.values(stats).reduce((s, a) => s + a.spend, 0);
  const activeCouponCount = Object.values(coupons).reduce((s, list) => s + list.length, 0);

  return (
    <div className="space-y-6">
      {/* Overview */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard label="Customers" value={customers.length.toLocaleString()} />
        <StatCard label="Total spend" value={`${compactMoney(totalSpend)} RWF`} sub="by registered customers" />
        <StatCard label="Active coupons" value={activeCouponCount.toLocaleString()} tone={activeCouponCount ? 'emerald' : 'slate'} />
      </div>

      {/* Customer cards — spend, profit, visits, coupons */}
      <div>
        <p className="text-slate-500 font-semibold mb-3">
          Registered customers <span className="text-slate-400 font-normal">— they register themselves in Self-service</span>
        </p>
        {loading ? (
          <p className="text-slate-400">Loading…</p>
        ) : ranked.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-md px-5 py-6 text-slate-400">No customers registered yet.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {ranked.map((c) => {
              const s = stats[c.id] ?? { spend: 0, profit: 0, visits: 0, last: 0 };
              const list = coupons[c.id] ?? [];
              const inactive = c.active === false;
              return (
                <div key={c.id} className={`bg-white rounded-2xl shadow-md p-4 sm:p-5 flex flex-col gap-3 ${inactive ? 'opacity-60' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className={`font-semibold text-base truncate ${inactive ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{c.username}</p>
                      <p className="text-xs text-slate-400 truncate">
                        {[c.phone, c.email, c.tin && `TIN ${c.tin}`].filter(Boolean).join(' · ') || 'No contact details'}
                      </p>
                    </div>
                    <button
                      onClick={() => setActive(c, inactive)}
                      className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold active:scale-95 ${
                        inactive ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
                      }`}
                    >
                      {inactive ? 'Restore' : 'Deactivate'}
                    </button>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-xl bg-slate-50 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">Spend</p>
                      <p className="text-sm font-bold text-slate-800 tabular-nums">{compactMoney(s.spend)}</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">Profit</p>
                      <p className={`text-sm font-bold tabular-nums ${s.profit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{compactMoney(s.profit)}</p>
                    </div>
                    <div className="rounded-xl bg-slate-50 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">Visits</p>
                      <p className="text-sm font-bold text-slate-800 tabular-nums">{s.visits}</p>
                    </div>
                  </div>

                  {list.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {list.map((cp) => (
                        <span key={cp.id} className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-semibold">
                          🎟 {couponLabel(cp)}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 mt-auto pt-1">
                    {eligible(c) && (
                      <button
                        onClick={() => grantReward(c)}
                        className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-emerald-500 text-white active:scale-95"
                      >
                        Grant {rule.pct}% reward
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setGrantFor(c);
                        setGrant({ kind: 'percent', value: '', reason: '' });
                      }}
                      className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-slate-100 text-slate-600 active:scale-95"
                    >
                      Grant coupon
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Master password — used to help a customer who forgot theirs */}
      <div className="bg-white rounded-2xl shadow-md p-5 sm:p-6 space-y-3 max-w-lg">
        <div>
          <p className="font-semibold text-slate-700">Customer master password</p>
          <p className="text-sm text-slate-400">
            A fallback to help a customer who forgot their password. {masterSet ? 'Currently set.' : 'Not set yet.'}
          </p>
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            placeholder={masterSet ? 'Enter a new master password' : 'Set a master password'}
            value={master}
            onChange={(e) => setMaster(e.target.value)}
            className="flex-1 min-w-0 px-4 py-2 rounded-lg border border-gray-300"
          />
          <button onClick={saveMaster} className="shrink-0 px-6 py-2 rounded-lg bg-amber-500 text-white font-semibold active:scale-95">
            Save
          </button>
        </div>
      </div>

      {/* Manual grant modal */}
      {grantFor && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setGrantFor(null)}>
          <div className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div>
              <p className="font-bold text-slate-800">Grant coupon</p>
              <p className="text-sm text-slate-400 truncate">to {grantFor.username}</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setGrant((g) => ({ ...g, kind: 'percent' }))}
                className={`py-2 rounded-lg text-sm font-semibold active:scale-95 ${grant.kind === 'percent' ? 'bg-amber-500 text-white' : 'bg-slate-100 text-slate-600'}`}
              >
                % off
              </button>
              <button
                onClick={() => setGrant((g) => ({ ...g, kind: 'amount' }))}
                className={`py-2 rounded-lg text-sm font-semibold active:scale-95 ${grant.kind === 'amount' ? 'bg-amber-500 text-white' : 'bg-slate-100 text-slate-600'}`}
              >
                RWF off
              </button>
            </div>
            <input
              type="number"
              inputMode="numeric"
              autoFocus
              placeholder={grant.kind === 'percent' ? 'Percent, e.g. 10' : 'Amount off, e.g. 2000'}
              value={grant.value}
              onChange={(e) => setGrant((g) => ({ ...g, value: e.target.value }))}
              className="w-full px-4 py-2.5 rounded-lg border border-gray-300 tabular-nums"
            />
            <input
              type="text"
              placeholder="Reason (optional)"
              value={grant.reason}
              onChange={(e) => setGrant((g) => ({ ...g, reason: e.target.value }))}
              className="w-full px-4 py-2.5 rounded-lg border border-gray-300"
            />
            <div className="flex gap-2">
              <button onClick={() => setGrantFor(null)} className="flex-1 py-2.5 rounded-lg bg-slate-100 text-slate-600 font-semibold active:scale-95">
                Cancel
              </button>
              <button onClick={submitGrant} className="flex-1 py-2.5 rounded-lg bg-emerald-500 text-white font-semibold active:scale-95">
                Grant
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OwnerDashboard({ currentUser, onLogout }) {
  const [activeLink, setActiveLink] = useState('Dashboard');
  const [moreOpen, setMoreOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [cashFlow, setCashFlow] = useState({ salesTotal: 0, expensesTotal: 0, net: 0 });
  const [cashFlowLoading, setCashFlowLoading] = useState(true);

  const notify = (message) => {
    setNotice(message);
    setTimeout(() => setNotice(''), 3000);
  };

  useEffect(() => {
    if (activeLink !== 'Dashboard') return;
    let cancelled = false;

    (async () => {
      setCashFlowLoading(true);
      const since = startOfTodayISO();
      const [salesRes, expensesRes] = await Promise.all([
        supabase.from('hospitality_sales').select('total_price').gte('timestamp', since),
        supabase.from('expenses').select('amount').gte('created_at', since),
      ]);
      if (cancelled) return;

      if (salesRes.error || expensesRes.error) {
        console.error('Failed to load financial summary:', salesRes.error?.message, expensesRes.error?.message);
        setCashFlowLoading(false);
        return;
      }

      const salesTotal = salesRes.data.reduce((sum, row) => sum + row.total_price, 0);
      const expensesTotal = expensesRes.data.reduce((sum, row) => sum + row.amount, 0);
      setCashFlow({ salesTotal, expensesTotal, net: salesTotal - expensesTotal });
      setCashFlowLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [activeLink]);

  return (
    <div className="min-h-screen bg-gray-50 font-sans flex flex-col md:flex-row">
      {/* Mobile top bar — sidebar is hidden below md, so logout needs a home here */}
      <header className="md:hidden bg-slate-900 text-white px-4 py-4 flex justify-between items-center shrink-0">
        <span className="text-xl font-extrabold tracking-tight">Sovereign OS</span>
        <button
          onClick={onLogout}
          className="px-3 py-2 rounded-lg bg-slate-700 text-sm font-semibold active:scale-95"
        >
          Logout
        </button>
      </header>

      {/* Desktop sidebar — full text nav, hidden on mobile in favor of the icon bar below */}
      <aside className="hidden md:flex md:flex-col w-64 bg-slate-900 text-white shrink-0">
        <div className="px-6 py-5 text-2xl font-extrabold tracking-tight border-b border-slate-800">
          Sovereign OS
        </div>
        <nav className="flex-1 py-4">
          {NAV_LINKS.map(({ key, icon }) => (
            <button
              key={key}
              onClick={() => setActiveLink(key)}
              className={`w-full text-left px-6 py-3 text-lg font-semibold transition flex items-center gap-3 ${
                activeLink === key
                  ? 'bg-slate-800 text-white border-r-4 border-amber-500'
                  : 'text-slate-400 hover:bg-slate-800/50'
              }`}
            >
              <span className="text-xl">{icon}</span>
              {key}
            </button>
          ))}
        </nav>
        <button
          onClick={onLogout}
          className="px-6 py-4 text-left text-sm font-semibold text-slate-400 border-t border-slate-800 hover:bg-slate-800/50"
        >
          Logout
        </button>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-4 sm:p-8 pb-24 md:pb-8 max-w-5xl w-full mx-auto">
        <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 mb-6">{activeLink}</h1>

        {notice && (
          <div className="mb-6 px-4 py-3 rounded-lg bg-slate-900 text-white inline-block">{notice}</div>
        )}

        {activeLink === 'Dashboard' && <DashboardHome cashFlow={cashFlow} loading={cashFlowLoading} />}
        {activeLink === 'Sales' && <SalesTab notify={notify} currentUser={currentUser} />}
        {activeLink === 'Reconcile' && <ReconcileTab />}
        {activeLink === 'Stations' && <StationsTab notify={notify} />}
        {activeLink === 'Inventory' && <InventoryTab notify={notify} />}
        {activeLink === 'Expenses' && <ExpensesTab notify={notify} />}
        {activeLink === 'Team' && <TeamTab notify={notify} />}
        {activeLink === 'Customers' && <CustomersTab notify={notify} />}
        {activeLink === 'Debts' && <DebtsTab notify={notify} currentUser={currentUser} />}
        {activeLink === 'Order QR' && <PortalQrTab notify={notify} />}
        {activeLink === 'Settings' && <SettingsTab notify={notify} />}
        {activeLink === 'Reports' && <ReportsTab />}
      </main>

      {/* Mobile "More" sheet — the overflow views live here so the bottom bar
          stays to four. */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-20 flex flex-col justify-end" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-t-3xl shadow-xl pb-4">
            <div className="w-10 h-1.5 bg-gray-200 rounded-full mx-auto mt-3 mb-1" />
            {overflowLinks.map(({ key, icon }) => (
              <button
                key={key}
                onClick={() => { setActiveLink(key); setMoreOpen(false); }}
                className={`w-full flex items-center gap-3 px-6 py-4 text-lg font-semibold ${
                  activeLink === key ? 'text-amber-600' : 'text-slate-700'
                }`}
              >
                <span className="text-2xl">{icon}</span>
                {key}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Mobile bottom bar — four most-used views plus a More menu */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-slate-900 border-t border-slate-800 flex justify-around py-2 z-10">
        {primaryLinks.map(({ key, icon }) => (
          <button
            key={key}
            onClick={() => { setActiveLink(key); setMoreOpen(false); }}
            className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg text-[11px] font-semibold transition ${
              activeLink === key ? 'text-amber-400' : 'text-slate-400'
            }`}
          >
            <span className="text-xl leading-none">{icon}</span>
            {key}
          </button>
        ))}
        <button
          onClick={() => setMoreOpen((o) => !o)}
          className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg text-[11px] font-semibold transition ${
            moreOpen || overflowLinks.some((l) => l.key === activeLink) ? 'text-amber-400' : 'text-slate-400'
          }`}
        >
          <span className="text-xl leading-none">☰</span>
          More
        </button>
      </nav>
    </div>
  );
}

export default OwnerDashboard;
