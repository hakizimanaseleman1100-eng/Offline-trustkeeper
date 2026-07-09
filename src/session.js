import { supabase } from './supabaseClient';

// The business (tenant) this device is operating as. Cached in localStorage so
// it's available synchronously on load and offline. Defaults to the legacy id
// so the existing single venue keeps working before it has signed up.
const LEGACY_BUSINESS_ID = 'biz_123';
let businessId = localStorage.getItem('business_id') || LEGACY_BUSINESS_ID;

export function getBusinessId() {
  return businessId;
}
export function setBusinessId(id) {
  if (!id) return;
  businessId = id;
  localStorage.setItem('business_id', id);
}
export function clearBusiness() {
  businessId = LEGACY_BUSINESS_ID;
  localStorage.removeItem('business_id');
}

// ---- Supabase Auth (the venue account) ------------------------------------
export async function currentSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function signInBusiness(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export function signUpBusiness(email, password) {
  return supabase.auth.signUp({ email, password });
}

export async function signOutBusiness() {
  await supabase.auth.signOut();
  clearBusiness();
}

// The caller's business id from their profile (null if not linked yet).
export async function resolveBusinessId() {
  const { data, error } = await supabase.rpc('auth_business_id');
  if (!error && data) {
    setBusinessId(data);
    return data;
  }
  return null;
}

// Attach the signed-in user to a business (first account adopts legacy data).
export async function ensureBusiness(name) {
  const { data, error } = await supabase.rpc('create_business', { p_name: name ?? '' });
  if (!error && data) {
    setBusinessId(data);
    return data;
  }
  return null;
}
