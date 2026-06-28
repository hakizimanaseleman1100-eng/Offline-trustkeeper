// Hardcoded for now — there's no real multi-tenant login yet, so this stands
// in for "which property's data are we scoped to." Every Supabase read/write
// must filter or tag by this until real tenant auth exists.
export const CURRENT_BUSINESS_ID = 'biz_123';
