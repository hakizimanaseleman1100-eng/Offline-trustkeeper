import { db } from './db';

// A stable id for THIS device, generated once and kept in local meta. Lets the
// server tell two devices apart even if their local receipt sequences overlap.
export async function getDeviceId() {
  const row = await db.meta.get('device_id');
  if (row?.value) return row.value;
  const id = (crypto.randomUUID?.() ?? String(Date.now())).slice(0, 8);
  await db.meta.put({ key: 'device_id', value: id });
  return id;
}

// Next fiscal receipt number for this device, as "REC-00042". Incremented
// inside a transaction so two near-simultaneous checkouts can't collide.
export async function nextReceiptNo() {
  return db.transaction('rw', db.meta, async () => {
    const row = await db.meta.get('receipt_seq');
    const seq = (row?.value ?? 0) + 1;
    await db.meta.put({ key: 'receipt_seq', value: seq });
    return 'REC-' + String(seq).padStart(5, '0');
  });
}

// Next purchase order number, as "PO-a1b2c3d4-0007". The device id is IN the
// number because the sequence is per device and a venue may record deliveries
// on two phones — without it, two stores could both produce PO-0007.
export async function nextPoNumber() {
  const device = await getDeviceId();
  return db.transaction('rw', db.meta, async () => {
    const row = await db.meta.get('po_seq');
    const seq = (row?.value ?? 0) + 1;
    await db.meta.put({ key: 'po_seq', value: seq });
    return `PO-${device}-${String(seq).padStart(4, '0')}`;
  });
}
