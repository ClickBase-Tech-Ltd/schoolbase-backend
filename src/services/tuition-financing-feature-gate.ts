import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { getPlatformSettingValue } from './platform-settings.js';

export async function isTuitionFinancingEnabled(prisma: PrismaClient): Promise<boolean> {
  try {
    const enabled = await getPlatformSettingValue<unknown>(
      prisma,
      'tuitionFinancingEnabled',
      false,
    );
    return enabled === true;
  } catch (error) {
    console.error('[tuition-financing] Failed to read the platform feature switch:', error);
    return false;
  }
}

export function requireTuitionFinancing(prisma: PrismaClient) {
  return async (_req: Request, res: Response, next: NextFunction) => {
    if (!(await isTuitionFinancingEnabled(prisma))) {
      res.status(404).json({ message: 'Tuition financing is not available.' });
      return;
    }
    next();
  };
}
