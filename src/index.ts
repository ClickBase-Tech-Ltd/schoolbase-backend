import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { initializeSubscriptionExpiryJob, stopSubscriptionExpiryJob } from './jobs/checkSubscriptionExpiry.js';
import { initializeSubscriptionEmailJob, stopSubscriptionEmailJob } from './jobs/subscriptionEmails.js';
import { initializeSignupRetentionJob } from './jobs/signupRetention.js';
import { ensurePlatformPaymentPlans } from './services/platform-settings.js';
import { activityAuditMiddleware } from './middleware/activityAudit.js';
import baileysSessionManager from './communications/whatsapp-baileys.js';
import { WhatsAppDeliveryWorker } from './services/whatsapp-delivery-worker.js';
import { SchoolWhatsAppRateLimiter } from './services/whatsapp-rate-limiter.js';

dotenv.config();

type ExtendedPrismaClient = PrismaClient & {
  adPlacement: {
    upsert: (...args: any[]) => Promise<any>;
  };
};

const prisma = new PrismaClient() as ExtendedPrismaClient;
const app = express();
const PORT = process.env.API_PORT || 3006;
let subscriptionExpiryTask: any = null;
let subscriptionEmailTask: any = null;
let signupRetentionTask: any = null;

async function ensureDefaultAdPlacements() {
  const placements = [
    { name: 'Login Page Banner', type: 'LOGIN_PAGE_BANNER', path: '/login', label: 'Sponsored', sortOrder: 1 },
    { name: 'Public Partner Strip', type: 'PUBLIC_PARTNER_STRIP', path: '/', label: 'Sponsored', sortOrder: 2 },
    { name: 'Resource / Blog Sponsor', type: 'RESOURCE_SPONSOR', path: '/blog', label: 'Sponsored', sortOrder: 3 },
    { name: 'Parent Login Banner', type: 'PARENT_LOGIN_BANNER', path: '/parent/login', label: 'Sponsored', sortOrder: 4 },
    { name: 'Results Checker Sponsor', type: 'RESULTS_CHECKER_SPONSOR', path: '/results/check', label: 'Sponsored', sortOrder: 5 },
    { name: 'Signup Partner Strip', type: 'SIGNUP_PARTNER_STRIP', path: '/signup', label: 'Sponsored', sortOrder: 6 },
  ] as const;

  for (const placement of placements) {
    await prisma.adPlacement.upsert({
      where: { type: placement.type },
      update: { name: placement.name, path: placement.path, label: placement.label, enabled: true, sortOrder: placement.sortOrder },
      create: { name: placement.name, type: placement.type, path: placement.path, label: placement.label, enabled: true, sortOrder: placement.sortOrder },
    });
  }
}

// Middleware
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'https://localhost:3000',
  'https://localhost:3001',
  'https://127.0.0.1:3000',
  'https://127.0.0.1:3001',
  'https://schoolbase.live',
  'https://www.schoolbase.live',
  'https://*.vercel.app',
  'https://*.schoolbase.live',
  ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map(url => url.trim()) : []),
]; 

const isLocalhostOrigin = (origin: string) => {
  return /^(https?:\/\/)(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
};

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Check exact matches
    if (allowedOrigins.includes(origin)) return callback(null, true);
    
    // Allow localhost with any port
    if (isLocalhostOrigin(origin)) return callback(null, true);

    // Check wildcard patterns
    if (origin.endsWith('.vercel.app')) return callback(null, true);
    if (origin.endsWith('.schoolbase.live')) return callback(null, true);
    
    // Deny all other origins (SECURITY: changed from allow all)
    callback(new Error('CORS not allowed'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'X-School-Id', 'x-school-id', 'X-Admission-Request-Id', 'X-Admission-Status-Token'],
};

app.use(cors(corsOptions));
app.use(express.json({
  limit: '50mb',
  verify: (request, _response, buffer) => {
    if ((request as Request).originalUrl.startsWith('/api/id-cards/webhooks/paystack')) {
      (request as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    }
  },
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', requestId);
  (req as Request & { requestId?: string }).requestId = String(requestId);
  next();
});
app.use(activityAuditMiddleware);

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Database connectivity check
app.get('/health/db', async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', database: 'disconnected' });
  }
});

app.get('/health/ready', async (req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ready', service: 'SchoolBase API', uptimeSeconds: Math.floor(process.uptime()), timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'not_ready', service: 'SchoolBase API', timestamp: new Date().toISOString() });
  }
});

// Load routes after Prisma is ready
async function loadRoutes() {
  console.log('Loading routes...');
  try {
    const { default: adminRoutes } = await import('./routes/admin.js');
    console.log('✓ Loaded admin routes');
    const { default: countryRoutes } = await import('./routes/country.js');
    console.log('✓ Loaded country routes');
    const { default: publicRoutes } = await import('./routes/public.js');
    console.log('✓ Loaded public routes');
    const { default: paystackRoutes } = await import('./routes/paystack.js');
    console.log('✓ Loaded paystack routes');
    const { default: trialRoutes } = await import('./routes/trial.js');
    console.log('✓ Loaded trial routes');
    const { default: whatsappRoutes } = await import('./routes/whatsapp.js');
    console.log('✓ Loaded whatsapp routes');
    const { default: schoolbaseAdminRoutes } = await import('./routes/schoolbase-admin.js');
    console.log('✓ Loaded schoolbase-admin routes');
    const { default: idCardStudioRoutes } = await import('./routes/id-card-studio.js');
    console.log('✓ Loaded ID-card studio routes');
    const { default: schoolbaseAdminIdCardRoutes } = await import('./routes/schoolbase-admin-id-cards.js');
    console.log('✓ Loaded SchoolBase Admin ID-card routes');
    const { default: platformWhatsAppRoutes } = await import('./routes/platform-whatsapp.js');
    console.log('✓ Loaded platform WhatsApp routes');
    // @ts-ignore: Runtime loader resolves the .js path for TS sources in this environment
    const { default: parentRoutes } = await import('./routes/parent.js');
    console.log('✓ Loaded parent routes');
    const { default: dashboardRoutes } = await import('./routes/dashboard.js');
    console.log('✓ Loaded dashboard routes');
    const { default: teacherRoutes } = await import('./routes/teacher.js');
    console.log('✓ Loaded teacher routes');
    const { default: staffRoutes } = await import('./routes/staff.js');
    console.log('✓ Loaded staff routes');
    const { default: staffAttendanceScanRoutes } = await import('./routes/staff-attendance-scan.js');
    console.log('✓ Loaded staff attendance scan routes');
    const { default: timetableRoutes } = await import('./routes/timetable.js');
    console.log('✓ Loaded timetable routes');
    const { default: supportChatRoutes, platformSupportChatRouter } = await import('./routes/support-chat.js');
    console.log('✓ Loaded support chat routes');
    const { default: authRoutes } = await import('./routes/auth.js');
    console.log('✓ Loaded auth routes');
    const { default: adminComponentsRoutes } = await import('./routes/admin-components.js');
    console.log('✓ Loaded admin components routes');
    const { default: adminFlexibleResultsRoutes } = await import('./routes/admin-flexible-results.js');
    console.log('✓ Loaded admin flexible results routes');
    const { default: resultsEngineRoutes } = await import('./routes/results-engine.js');
    console.log('✓ Loaded results engine routes');
    const { default: reportCardRoutes } = await import('./routes/report-card.js');
    console.log('✓ Loaded report card routes');
    const { default: pdfReportsRoutes } = await import('./routes/pdf-reports.js');
    console.log('✓ Loaded PDF reports routes');
    const { default: assessmentSetupRoutes } = await import('./routes/assessment-setup.js');
    console.log('✓ Loaded assessment setup routes');
    const { default: resultPinRoutes } = await import('./routes/result-pins.js');
    console.log('✓ Loaded result PIN routes');
    const { default: bursarRoutes } = await import('./routes/bursar.js');
    console.log('✓ Loaded bursar routes');
    const { default: competitionRoutes } = await import('./routes/competition.js');
    console.log('✓ Loaded Competition routes');
    const { default: schoolReviewRoutes } = await import('./routes/school-reviews.js');
    console.log('✓ Loaded school review routes');

    app.use('/api/admin', adminRoutes);
    app.use('/api/admin/assessment-components', adminComponentsRoutes);
    app.use('/api/admin/flexible-results', adminFlexibleResultsRoutes);
    app.use('/api/assessments/setup', assessmentSetupRoutes);
    app.use('/api/result-pins', resultPinRoutes);
    app.use('/api/results', resultsEngineRoutes);
    app.use('/api/report-cards', reportCardRoutes);
    app.use('/api/pdf-reports', pdfReportsRoutes);
    app.use('/api/country', countryRoutes);
    app.use('/api', publicRoutes);
    app.use('/api/paystack', paystackRoutes);
    app.use('/api/trial', trialRoutes);
    app.use('/api/whatsapp', whatsappRoutes);
    app.use('/api/parent', parentRoutes);
    app.use('/api/admin', dashboardRoutes);
    app.use('/api/teacher', teacherRoutes);
    app.use('/api/staff/attendance', staffAttendanceScanRoutes);
    app.use('/api/staff', staffRoutes);
    app.use('/api/bursar', bursarRoutes);
    app.use('/api/competition', competitionRoutes);
    app.use('/api/reviews', schoolReviewRoutes);
    app.use('/schoolbase-admin/api/reviews', schoolReviewRoutes);
    app.use('/schoolbase-admin/api/competition', competitionRoutes);
    app.use('/api/id-cards', idCardStudioRoutes);
    app.use('/api', timetableRoutes);
    app.use('/api/support-chat', supportChatRoutes);
    app.use('/schoolbase-admin/api/support-chat', platformSupportChatRouter);
    app.use('/api/auth', authRoutes);
    app.use('/schoolbase-admin/api/whatsapp', platformWhatsAppRoutes);
    app.use('/schoolbase-admin/api', schoolbaseAdminRoutes);
    app.use('/schoolbase-admin/api', schoolbaseAdminIdCardRoutes);
    
    console.log('✓ All routes mounted successfully');
  } catch (error) {
    console.error('Error loading routes:', error);
    throw error;
  }
}

// Start server - load routes BEFORE listening
async function start() {
  try {
    await ensurePlatformPaymentPlans(prisma);
    await ensureDefaultAdPlacements();
    await loadRoutes();

    try {
      const restoredWhatsAppSessions = await baileysSessionManager.restorePersistedSessions();
      console.log('[baileys] Restored persisted school sessions:', restoredWhatsAppSessions);
    } catch (error) {
      console.error('[baileys] Failed to restore persisted school sessions:', error);
    }
    
    // Initialize background jobs
    try {
      subscriptionExpiryTask = initializeSubscriptionExpiryJob();
    } catch (error) {
      console.error('Warning: Failed to initialize subscription expiry job:', error);
      // Don't fail startup if job initialization fails - system can still operate
    }

    try {
      subscriptionEmailTask = initializeSubscriptionEmailJob();
    } catch (error) {
      console.error('Warning: Failed to initialize subscription email job:', error);
      // Don't fail startup if job initialization fails - system can still operate
    }

    try {
      signupRetentionTask = initializeSignupRetentionJob();
    } catch (error) {
      console.error('Warning: Failed to initialize signup retention job:', error);
    }

    const whatsappDeliveryWorker = new WhatsAppDeliveryWorker(
      prisma,
      new SchoolWhatsAppRateLimiter({
        minIntervalMs: Number(process.env.WHATSAPP_MIN_SEND_INTERVAL_MS || 3000),
        perMinuteLimit: Number(process.env.WHATSAPP_PER_MINUTE_LIMIT || 10),
        perHourLimit: Number(process.env.WHATSAPP_PER_HOUR_LIMIT || 100),
        perDayLimit: Number(process.env.WHATSAPP_PER_DAY_LIMIT || 300),
      }),
    );

    whatsappDeliveryWorker.startPolling(async (delivery) => {
      const result = await baileysSessionManager.sendTextMessage(
        delivery.schoolId,
        delivery.recipientAddress,
        delivery.messagePreview || 'SchoolBase WhatsApp notification',
      );

      return {
        success: result.success,
        providerMessageId: result.messageId,
        error: result.error,
      };
    }, { intervalMs: Number(process.env.WHATSAPP_QUEUE_INTERVAL_MS || 5000) });
    console.log('[whatsapp-worker] Background queued WhatsApp delivery worker started');
    
    // Error handling middleware (after routes)
    app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      const requestId = (req as Request & { requestId?: string }).requestId;
      console.error(`[request:${requestId || 'unknown'}]`, err);
      res.status(500).json({
        error: err.message || 'Internal Server Error',
        requestId,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
      });
    });

    // 404 handler (after routes)
    app.use((req: Request, res: Response) => {
      res.status(404).json({ error: 'Route not found' });
    });

    app.listen(PORT, () => {
      console.log(`✓ SchoolBase API running on port ${PORT}`);
      console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`✓ Database: Connected`);
    });
  } catch (error) {
    console.error('✗ Failed to start server:', error);
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  if (subscriptionExpiryTask) {
    stopSubscriptionExpiryJob(subscriptionExpiryTask);
  }
  if (subscriptionEmailTask) {
    stopSubscriptionEmailJob(subscriptionEmailTask);
  }
  signupRetentionTask?.stop();
  await prisma.$disconnect();
  process.exit(0);
});
