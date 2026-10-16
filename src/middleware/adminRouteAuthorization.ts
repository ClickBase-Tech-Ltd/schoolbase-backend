import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthenticatedRequest } from './roleAuth.js';
import { adminRouteAccess, isAdminRouteAllowed } from '../services/admin-route-access.js';

export function createAdminRouteAuthorization(authenticate: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const access = adminRouteAccess(req.path, req.method);
    if (access === 'PUBLIC' || access === 'SIGNED_TOKEN') return next();

    authenticate(req, res, (error?: unknown) => {
      if (error) return next(error);
      const role = (req as AuthenticatedRequest).user?.role;
      if (!isAdminRouteAllowed(access, role)) {
        return res.status(403).json({ error: 'Forbidden: role is not authorized for this admin resource' });
      }
      next();
    });
  };
}