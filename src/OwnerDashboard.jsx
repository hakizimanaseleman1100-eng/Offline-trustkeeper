import { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { supabase } from './supabaseClient';
import { CURRENT_BUSINESS_ID } from './config';
import { hashPin } from './auth';

const STAFF_ROLES = ['WAITER', 'KITCHEN', 'MANAGER', 'OWNER'];

const NAV_LINKS = [
  { key: 'Dashboard', icon: '📊' },
  { key: 'Sales', icon: '🧾' },
  { key: 'Inventory', icon: '📦' },
  { key: 'Expenses', icon: '💵' },
  { key: 'Reports', icon: '📈' },
  { key: 'Team', icon: '👥' },
];
const EXPENSE_CATEGORIES = ['Utilities', 'Supplies', 'Maintenance', 'Salaries', 'Other'];

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
  const [itemName, setItemName] = useState('');
  const [sellingPrice, setSellingPrice] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [productCategory, setProductCategory] = useState('');
  const [taxLabel, setTaxLabel] = useState('B');
  const [taxRate, setTaxRate] = useState('18');
  // Inline editing: `edit` holds the id being edited and a draft of its fields.
  const [edit, setEdit] = useState(null);

  const loadProducts = async () => {
    const { data, error } = await supabase.from('products').select('*').order('item_name');
    if (error) {
      console.error('Failed to load products:', error.message);
      return;
    }
    // Hide soft-deleted products (active === false). Rows predating migration
    // 0003 have no `active` field and are treated as active.
    setProducts((data ?? []).filter((p) => p.active !== false));
  };

  useEffect(() => {
    loadProducts();
  }, []);

  const handleAddProduct = async (e) => {
    e.preventDefault();
    const { error } = await supabase.from('products').insert({
      business_id: CURRENT_BUSINESS_ID,
      item_name: itemName,
      unit_price: Number(sellingPrice),
      cost_price: Number(costPrice),
      category: productCategory,
      tax_label: taxLabel,
      tax_rate: Number(taxRate),
    });
    if (error) {
      notify(`Failed to add product: ${error.message}`);
      return;
    }
    setItemName('');
    setSellingPrice('');
    setCostPrice('');
    setProductCategory('');
    setTaxLabel('B');
    setTaxRate('18');
    notify(`Added ${itemName}`);
    loadProducts();
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
        tax_label: edit.tax_label,
        tax_rate: Number(edit.tax_rate),
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

  // Soft delete — keeps the row for historical sales, just hides it from POS.
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

  return (
    <div className="space-y-8">
      <form
        onSubmit={handleAddProduct}
        className="bg-white rounded-2xl shadow-md p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
      >
        <input
          required
          placeholder="Item Name"
          value={itemName}
          onChange={(e) => setItemName(e.target.value)}
          className="px-4 py-2 rounded-lg border border-gray-300"
        />
        <input
          required
          type="number"
          placeholder="Selling Price"
          value={sellingPrice}
          onChange={(e) => setSellingPrice(e.target.value)}
          className="px-4 py-2 rounded-lg border border-gray-300"
        />
        <input
          required
          type="number"
          placeholder="Cost Price"
          value={costPrice}
          onChange={(e) => setCostPrice(e.target.value)}
          className="px-4 py-2 rounded-lg border border-gray-300"
        />
        <input
          required
          placeholder="Category"
          value={productCategory}
          onChange={(e) => setProductCategory(e.target.value)}
          className="px-4 py-2 rounded-lg border border-gray-300"
        />
        <input
          required
          placeholder="Tax Label"
          value={taxLabel}
          onChange={(e) => setTaxLabel(e.target.value)}
          className="px-4 py-2 rounded-lg border border-gray-300"
        />
        <input
          required
          type="number"
          placeholder="Tax Rate"
          value={taxRate}
          onChange={(e) => setTaxRate(e.target.value)}
          className="px-4 py-2 rounded-lg border border-gray-300"
        />
        <button
          type="submit"
          className="col-span-1 sm:col-span-2 lg:col-span-3 py-2 rounded-lg bg-amber-500 text-white font-semibold active:scale-95"
        >
          Add Product
        </button>
      </form>

      <div className="bg-white rounded-2xl shadow-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-100 text-slate-500 text-sm uppercase">
              <tr>
                <th className="px-5 py-3">Item</th>
                <th className="px-5 py-3">Category</th>
                <th className="px-5 py-3">Price</th>
                <th className="px-5 py-3">Cost</th>
                <th className="px-5 py-3">Tax</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {products.map((p) =>
                edit?.id === p.id ? (
                  <tr key={p.id} className="bg-amber-50">
                    <td className="px-5 py-3">{editCell('item_name')}</td>
                    <td className="px-5 py-3">{editCell('category')}</td>
                    <td className="px-5 py-3">{editCell('unit_price', { type: 'number' })}</td>
                    <td className="px-5 py-3">{editCell('cost_price', { type: 'number' })}</td>
                    <td className="px-5 py-3">
                      <div className="flex gap-1">
                        {editCell('tax_label')}
                        {editCell('tax_rate', { type: 'number' })}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      <button onClick={saveEdit} className="px-3 py-1 rounded-lg bg-emerald-600 text-white text-sm font-semibold active:scale-95">
                        Save
                      </button>
                      <button onClick={() => setEdit(null)} className="ml-2 px-3 py-1 rounded-lg bg-slate-100 text-slate-600 text-sm font-semibold active:scale-95">
                        Cancel
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={p.id}>
                    <td className="px-5 py-3 font-semibold text-slate-800 whitespace-nowrap">{p.item_name}</td>
                    <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{p.category}</td>
                    <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{p.unit_price?.toLocaleString()} RWF</td>
                    <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{p.cost_price?.toLocaleString()} RWF</td>
                    <td className="px-5 py-3 text-slate-500 whitespace-nowrap">
                      {p.tax_label} ({p.tax_rate}%)
                    </td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      <button onClick={() => startEdit(p)} className="px-3 py-1 rounded-lg bg-slate-100 text-slate-700 text-sm font-semibold active:scale-95">
                        Edit
                      </button>
                      <button onClick={() => deleteProduct(p)} className="ml-2 px-3 py-1 rounded-lg bg-red-50 text-red-600 text-sm font-semibold active:scale-95">
                        Delete
                      </button>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
        {products.length === 0 && <p className="px-5 py-6 text-slate-400">No products yet.</p>}
      </div>
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
      business_id: CURRENT_BUSINESS_ID,
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
  const [name, setName] = useState('');
  const [role, setRole] = useState('WAITER');
  const [pin, setPin] = useState('');

  const loadStaff = async () => {
    const { data, error } = await supabase
      .from('staff')
      .select('*')
      .eq('business_id', CURRENT_BUSINESS_ID)
      .order('name');
    if (error) {
      console.error('Failed to load staff:', error.message);
      return;
    }
    setStaff(data ?? []);
  };

  useEffect(() => {
    loadStaff();
  }, []);

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
      business_id: CURRENT_BUSINESS_ID,
      name,
      role,
      pin_hash,
      active: true,
    });
    if (error) {
      notify(`Could not add staff: ${error.message}`);
      return;
    }
    setName('');
    setRole('WAITER');
    setPin('');
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
                <p className="text-xs uppercase tracking-wide text-slate-400">{member.role}</p>
              </div>
              <button
                onClick={() => setActive(member, member.active === false)}
                className={`shrink-0 px-3 py-1.5 rounded-lg text-sm font-semibold active:scale-95 ${
                  member.active === false
                    ? 'bg-emerald-50 text-emerald-600'
                    : 'bg-red-50 text-red-600'
                }`}
              >
                {member.active === false ? 'Re-activate' : 'Deactivate'}
              </button>
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
      const [salesRes, productsRes] = await Promise.all([
        supabase
          .from('hospitality_sales')
          .select('*')
          .eq('business_id', CURRENT_BUSINESS_ID)
          .gte('timestamp', since),
        supabase.from('products').select('id, item_name').eq('business_id', CURRENT_BUSINESS_ID),
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

      setReport({ revenue, profit, receipts, count: sales.length, byMethod, topItems, staff });
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
      .eq('business_id', CURRENT_BUSINESS_ID)
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
      business_id: CURRENT_BUSINESS_ID,
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
      timestamp: new Date().toISOString(),
    }));
    const { error } = await supabase.from('hospitality_sales').insert(reversals);
    if (error) {
      notify(`Refund failed: ${error.message}`);
      setBusy(null);
      return;
    }
    await supabase.from('audit_logs').insert({
      business_id: CURRENT_BUSINESS_ID,
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

function OwnerDashboard({ currentUser, onLogout }) {
  const [activeLink, setActiveLink] = useState('Dashboard');
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
        {activeLink === 'Inventory' && <InventoryTab notify={notify} />}
        {activeLink === 'Expenses' && <ExpensesTab notify={notify} />}
        {activeLink === 'Team' && <TeamTab notify={notify} />}
        {activeLink === 'Reports' && <ReportsTab />}
      </main>

      {/* Mobile bottom icon bar — icon + short label is easier to scan at a glance than a text list */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-slate-900 border-t border-slate-800 flex justify-around py-2 z-10">
        {NAV_LINKS.map(({ key, icon }) => (
          <button
            key={key}
            onClick={() => setActiveLink(key)}
            className={`flex flex-col items-center gap-0.5 px-1.5 py-1 rounded-lg text-[10px] font-semibold transition ${
              activeLink === key ? 'text-amber-400' : 'text-slate-400'
            }`}
          >
            <span className="text-xl leading-none">{icon}</span>
            {key}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default OwnerDashboard;
