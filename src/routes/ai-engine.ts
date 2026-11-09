import { Router, type NextFunction, type Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { verifyAuth, requireStaff, type AuthenticatedRequest } from '../middleware/roleAuth.js';
import { resolveSchoolScope } from '../services/security-context.js';
import { getSessionSecret } from '../services/security-config.js';
import {
  buildAiQueryPlan,
  createAiConversationContextToken,
  executeAiQueryPlan,
  getAiEngineCapabilities,
  getAiReadinessStatus,
  isAiEngineEnabled,
  isAiPilotAccessAllowed,
  resolveAiFollowupPlan,
  validateAiQueryPlan,
  SCHOOLBASE_AI_MODEL_REGISTRY,
} from '../services/schoolbase-ai-engine.js';

const AI_QUERY_LIMIT_PER_MINUTE = 30;
const AI_QUERY_RATE_WINDOW_MS = 60_000;
const AI_QUERY_RATE_BUCKET_CAPACITY = 5_000;

const applicationDatabaseUrl = process.env.DATABASE_URL?.trim();
const aiDatabaseUrl = process.env.SCHOOLBASE_AI_DATABASE_URL?.trim();
const parseMysqlDatabaseUrl = (value: string | undefined): URL | null => {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'mysql:' && parsed.hostname && parsed.username ? parsed : null;
  } catch {
    return null;
  }
};
const applicationDatabase = parseMysqlDatabaseUrl(applicationDatabaseUrl);
const aiDatabase = parseMysqlDatabaseUrl(aiDatabaseUrl);
const hasDedicatedAiDatabaseUrl = Boolean(
  applicationDatabase
  && aiDatabase
  && aiDatabase.username !== applicationDatabase.username,
);
const aiPrisma = isAiEngineEnabled() && hasDedicatedAiDatabaseUrl && aiDatabaseUrl
  ? new PrismaClient({ datasources: { db: { url: aiDatabaseUrl } } })
  : null;

export async function disconnectAiEngineDatabase(): Promise<void> {
  if (aiPrisma) await aiPrisma.$disconnect();
}

export function createAiEngineRouter() {
const router = Router();
const aiEngineDisabledReason = !isAiEngineEnabled()
  ? 'Set SCHOOLBASE_AI_ENGINE_ENABLED=true in the backend environment and restart the API.'
  : !aiDatabaseUrl
    ? 'Set SCHOOLBASE_AI_DATABASE_URL to a dedicated read-only test-database connection and restart the API.'
    : !aiDatabase
      ? 'SCHOOLBASE_AI_DATABASE_URL must be a valid MySQL connection URL.'
      : !applicationDatabase
        ? 'DATABASE_URL must be a valid MySQL connection URL before AI execution can be enabled.'
        : aiDatabase.username === applicationDatabase.username
          ? 'SCHOOLBASE_AI_DATABASE_URL must use a separate database username with read-only privileges; URL differences alone are not sufficient.'
          : null;
const engineEnabled = aiEngineDisabledReason === null && aiPrisma !== null;
const aiQueryRateBuckets = new Map<string, { startedAt: number; count: number }>();
const aiPilotGateConfigured = process.env.NODE_ENV !== 'production'
  || Boolean(process.env.SCHOOLBASE_AI_PILOT_SCHOOL_IDS?.split(',').some((schoolId) => schoolId.trim()));

function rejectOutsideAiPilot(
  req: AuthenticatedRequest,
  res: Response,
  schoolId = req.user?.schoolId ?? null,
): boolean {
  if (isAiPilotAccessAllowed({ role: req.user?.role, schoolId })) return false;
  res.status(403).json({
    ok: false,
    error: 'SchoolBase AI is only available to School Admins at an explicitly approved pilot school.',
  });
  return true;
}

function aiQueryRateLimit(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const actorId = req.user?.userId;
  if (!actorId) {
    res.status(401).json({ ok: false, error: 'Authentication is required for AI queries.' });
    return;
  }

  const now = Date.now();
  let bucket = aiQueryRateBuckets.get(actorId);
  if (!bucket || now - bucket.startedAt >= AI_QUERY_RATE_WINDOW_MS) {
    if (!bucket && aiQueryRateBuckets.size >= AI_QUERY_RATE_BUCKET_CAPACITY) {
      for (const [key, value] of aiQueryRateBuckets) {
        if (now - value.startedAt >= AI_QUERY_RATE_WINDOW_MS) aiQueryRateBuckets.delete(key);
      }
      if (aiQueryRateBuckets.size >= AI_QUERY_RATE_BUCKET_CAPACITY) {
        res.status(503).json({ ok: false, error: 'AI query capacity is temporarily unavailable.' });
        return;
      }
    }

    bucket = { startedAt: now, count: 0 };
    aiQueryRateBuckets.set(actorId, bucket);
  }

  if (bucket.count >= AI_QUERY_LIMIT_PER_MINUTE) {
    const retryAfterSeconds = Math.ceil((AI_QUERY_RATE_WINDOW_MS - (now - bucket.startedAt)) / 1_000);
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ ok: false, error: 'AI query rate limit exceeded.' });
    return;
  }

  bucket.count += 1;
  next();
}

router.get('/health', async (_req, res) => {
  if (!engineEnabled || !aiPrisma) {
    return res.json({
      ok: true,
      enabled: false,
      status: 'disabled',
      disabledReason: aiEngineDisabledReason,
      engine: 'SchoolBase AI Read-Only Engine',
      capabilities: ['metadata', 'query-validation', 'read-only-query-execution'],
    });
  }

  try {
    await aiPrisma.$queryRaw`SELECT 1`;
    return res.json({
      ok: true,
      enabled: true,
      status: 'ready',
      database: 'connected',
      databasePrivilegesVerified: false,
      engine: 'SchoolBase AI Read-Only Engine',
      capabilities: ['metadata', 'query-validation', 'read-only-query-execution'],
    });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'unknown';
    console.error('[schoolbase-ai] database health check failed', { code });
    return res.status(503).json({
      ok: false,
      enabled: false,
      status: 'database_unavailable',
      error: 'The configured read-only AI database is unavailable.',
    });
  }
});

router.get('/metadata', verifyAuth, requireStaff, (req, res) => {
  if (rejectOutsideAiPilot(req, res)) return;
  const role = req.user?.role;
  const entries = Object.values(SCHOOLBASE_AI_MODEL_REGISTRY)
    .filter((entry) => entry.permissions.some((permission) => permission === role))
    .map((entry) => ({
      model: entry.model,
      label: entry.label,
      scope: entry.scope,
      sensitivity: entry.sensitivity,
      status: entry.status,
      fields: [...entry.fields],
      filters: [...entry.filters],
      permissions: [...entry.permissions],
      usesBusinessService: entry.usesBusinessService ?? null,
    }));

  res.json({
    ok: true,
    engine: 'SchoolBase AI Read-Only Engine',
    enabled: engineEnabled,
    metadata: entries,
  });
});

router.get('/readiness', verifyAuth, requireStaff, (_req, res) => {
  res.json({
    ok: true,
    enabled: engineEnabled,
    readiness: {
      ...getAiReadinessStatus(),
      blockers: [
        ...getAiReadinessStatus().blockers,
        ...(aiEngineDisabledReason ? [aiEngineDisabledReason] : []),
        ...(!aiPilotGateConfigured ? ['Production pilot access requires SCHOOLBASE_AI_PILOT_SCHOOL_IDS with an approved school ID.'] : []),
        ...(aiPrisma ? ['Verify the SCHOOLBASE_AI_DATABASE_URL database user has read-only privileges limited to approved tables before enabling this environment.'] : []),
      ],
    },
  });
});

router.post('/query/validate', verifyAuth, requireStaff, aiQueryRateLimit, (req, res) => {
  const question = String(req.body?.question ?? '').trim();
  const role = req.user?.role ?? null;
  const schoolId = req.user?.schoolId ?? null;
  const requestedSchoolId = typeof req.body?.schoolId === 'string' ? req.body.schoolId : null;

  if (!question) {
    return res.status(400).json({ ok: false, errors: ['No question was supplied for AI validation.'] });
  }

  const scope = resolveSchoolScope({
    authenticatedSchoolId: schoolId,
    authenticatedRole: role,
    requestedSchoolId,
  });

  if (scope.rejected) {
    return res.status(403).json({ ok: false, errors: [scope.reason ?? 'School scope mismatch.'] });
  }
  if (rejectOutsideAiPilot(req, res, scope.schoolId ?? schoolId)) return;

  const plan = buildAiQueryPlan(question, { role, schoolId: scope.schoolId ?? schoolId, requestedSchoolId: scope.schoolId ?? requestedSchoolId });
  if (!plan) {
    return res.status(422).json({
      ok: false,
      error: 'This request is unsupported or ambiguous for the currently enabled read-only query capabilities.',
    });
  }
  const validation = validateAiQueryPlan(plan, { role, schoolId: scope.schoolId ?? schoolId, requestedSchoolId: scope.schoolId ?? requestedSchoolId });

  if (!validation.ok) {
    return res.status(400).json({ ok: false, errors: validation.errors });
  }

  return res.json({
    ok: true,
    plan: validation.plan,
    capabilities: getAiEngineCapabilities(role),
  });
});

router.post('/query/execute', verifyAuth, requireStaff, aiQueryRateLimit, async (req, res) => {
  if (!engineEnabled || !aiPrisma) {
    return res.status(503).json({
      ok: false,
      error: aiEngineDisabledReason ?? 'SchoolBase AI engine is not enabled for this environment.',
    });
  }

  const question = String(req.body?.question ?? '').trim();
  const role = req.user?.role ?? null;
  const schoolId = req.user?.schoolId ?? null;
  const requestedSchoolId = typeof req.body?.schoolId === 'string' ? req.body.schoolId : null;

  if (!question) {
    return res.status(400).json({ ok: false, error: 'A natural-language question is required.' });
  }

  const scope = resolveSchoolScope({
    authenticatedSchoolId: schoolId,
    authenticatedRole: role,
    requestedSchoolId,
  });

  if (scope.rejected) {
    return res.status(403).json({ ok: false, error: scope.reason ?? 'School scope mismatch.' });
  }
  if (rejectOutsideAiPilot(req, res, scope.schoolId ?? schoolId)) return;

  const validationContext = {
    role,
    schoolId: scope.schoolId ?? schoolId,
    requestedSchoolId: scope.schoolId ?? requestedSchoolId,
    userId: req.user?.userId ?? null,
  };
  let basePlan = buildAiQueryPlan(question, validationContext);
  if (!basePlan && typeof req.body?.contextToken === 'string') {
    const followup = resolveAiFollowupPlan(
      question,
      req.body.contextToken,
      validationContext,
      getSessionSecret(),
    );
    if (!followup.ok) {
      const status = followup.reason === 'expired' ? 410
        : followup.reason === 'identity_changed' ? 409
          : followup.reason === 'unsupported' ? 422
            : 400;
      return res.status(status).json({
        ok: false,
        error: followup.reason === 'expired'
          ? 'Conversation context expired. Please restate your question.'
          : followup.reason === 'identity_changed'
            ? 'Conversation context does not match the current authenticated session.'
            : followup.reason === 'unsupported'
              ? 'This follow-up cannot be safely resolved. Please restate the intended data set.'
              : 'Conversation context is invalid.',
      });
    }
    basePlan = followup.plan;
  }
  if (!basePlan) {
    return res.status(422).json({
      ok: false,
      error: 'This request is unsupported or ambiguous for the currently enabled read-only query capabilities.',
    });
  }
  const validation = validateAiQueryPlan(basePlan, validationContext);

  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: validation.errors.join(' ') });
  }

  try {
    const result = await aiPrisma.$transaction(
      (transaction) => executeAiQueryPlan(transaction, validation.plan, {
        role,
        schoolId: scope.schoolId ?? schoolId,
        requestedSchoolId: scope.schoolId ?? requestedSchoolId,
        userId: req.user?.userId ?? null,
      }),
      { maxWait: 2_000, timeout: 8_000 },
    );

    console.info(JSON.stringify({
      event: 'schoolbase_ai_query',
      requestId: req.headers['x-request-id'] ?? null,
      actorId: req.user?.userId ?? null,
      role,
      schoolId: scope.schoolId ?? schoolId,
      model: result.model,
      action: result.action,
      matched: result.matched,
      readOnly: true,
    }));

    const contextToken = createAiConversationContextToken(
      validation.plan,
      validationContext,
      getSessionSecret(),
    );
    return res.json({ ok: true, result, contextToken });
  } catch (error) {
    console.error('[schoolbase-ai] query execution failed', {
      requestId: req.headers['x-request-id'] ?? null,
      actorId: req.user?.userId ?? null,
      role,
      schoolId: scope.schoolId ?? schoolId,
      error,
    });
    return res.status(500).json({
      ok: false,
      error: 'The read-only query could not be completed. Contact support with the request ID.',
    });
  }
});

return router;
}
