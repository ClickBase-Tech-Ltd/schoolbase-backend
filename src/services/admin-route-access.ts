export type AdminRouteAccess =
  | 'PUBLIC'
  | 'SIGNED_TOKEN'
  | 'AUTHENTICATED_SCHOOL'
  | 'SCHOOL_ADMIN'
  | 'ACCOUNTING'
  | 'PLATFORM_ADMIN';

const PUBLIC_ADMIN_ROUTES = new Set([
  'POST /login',
  'POST /verify',
  'POST /request-password-reset',
  'POST /reset-password',
]);

const SHARED_ASSET_ROUTES = new Set(['/school-logo', '/school-stamp', '/school-signature']);

export function adminRouteAccess(path: string, method: string): AdminRouteAccess {
  const normalizedPath = `/${path.split('/').filter(Boolean).join('/')}`;
  const normalizedMethod = method.toUpperCase();

  if (PUBLIC_ADMIN_ROUTES.has(`${normalizedMethod} ${normalizedPath}`)) return 'PUBLIC';
  if (normalizedPath === '/impersonate' && normalizedMethod === 'POST') return 'SIGNED_TOKEN';
  if ([...SHARED_ASSET_ROUTES].some((route) => normalizedPath === route || normalizedPath.startsWith(`${route}/`))) {
    return 'AUTHENTICATED_SCHOOL';
  }
  if (normalizedPath === '/platform' || normalizedPath.startsWith('/platform/')) return 'PLATFORM_ADMIN';
  if (normalizedPath === '/school' || /^\/school\/[^/]+$/.test(normalizedPath)) return 'ACCOUNTING';
  if (normalizedPath === '/academic-years' && normalizedMethod === 'GET') return 'ACCOUNTING';
  if (
    (normalizedPath === '/whatsapp/status'
      || normalizedPath === '/whatsapp-baileys/status'
      || normalizedPath === '/api/admin/whatsapp/status')
    && normalizedMethod === 'GET'
  ) return 'ACCOUNTING';
  if (normalizedPath === '/fees' || normalizedPath.startsWith('/fees/')
    || normalizedPath === '/invoices' || normalizedPath.startsWith('/invoices/')) return 'ACCOUNTING';

  return 'SCHOOL_ADMIN';
}

export function isAdminRouteAllowed(access: AdminRouteAccess, role?: string | null): boolean {
  if (access === 'PUBLIC' || access === 'SIGNED_TOKEN') return true;
  if (!role) return false;
  if (access === 'AUTHENTICATED_SCHOOL') {
    return ['SCHOOL_ADMIN', 'BURSAR', 'TEACHER', 'PARENT', 'STUDENT'].includes(role);
  }
  // Finance endpoints are deliberately shared by School Admin workflows and the Bursar portal.
  // Page access remains exclusive; this is limited to the finance API surface.
  if (access === 'ACCOUNTING') return role === 'BURSAR' || role === 'SCHOOL_ADMIN';
  if (access === 'PLATFORM_ADMIN') return role === 'PLATFORM_ADMIN';
  return role === 'SCHOOL_ADMIN';
}