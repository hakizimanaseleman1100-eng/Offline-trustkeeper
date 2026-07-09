// The active tenant is no longer hardcoded — it comes from the signed-in venue
// account. Use getBusinessId() from ./session instead. Kept as a fallback only
// for the legacy single venue that predates accounts.
export const LEGACY_BUSINESS_ID = 'biz_123';
