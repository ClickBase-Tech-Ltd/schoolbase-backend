import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { ensurePlatformPaymentPlans } from './services/platform-settings.js';

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.API_PORT || 3006;

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true);
    }

    const allowedOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      'http://10.135.12.55:3000',
    ];

    const isLocalhost = /^(https?:\/\/)(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    if (isLocalhost || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    callback(new Error('CORS not allowed'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// Health checks
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/health/db', (req: Request, res: Response) => {
  res.json({ status: 'ok', database: 'connected', note: 'Database connection not checked in test mode' });
});

// Load routes
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
    const { default: parentRoutes } = await import('./routes/parent.js');
    console.log('✓ Loaded parent routes');
    const { default: dashboardRoutes } = await import('./routes/dashboard.js');
    console.log('✓ Loaded dashboard routes');
    const { default: teacherRoutes } = await import('./routes/teacher.js');
    console.log('✓ Loaded teacher routes');
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

    app.use('/api/admin', adminRoutes);
    app.use('/api/admin/assessment-components', adminComponentsRoutes);
    app.use('/api/admin/flexible-results', adminFlexibleResultsRoutes);
    app.use('/api/assessments/setup', assessmentSetupRoutes);
    app.use('/api/results', resultsEngineRoutes);
    app.use('/api/report-cards', reportCardRoutes);
    app.use('/api/pdf-reports', pdfReportsRoutes);
    app.use('/api/country', countryRoutes);
    app.use('/api', publicRoutes);
    app.use('/api/paystack', paystackRoutes);
    const { default: flutterwaveSubscriptionRoutes } = await import('./routes/flutterwave-subscriptions.js');
    app.use('/api/flutterwave', flutterwaveSubscriptionRoutes);
    app.use('/api/trial', trialRoutes);
    app.use('/api/whatsapp', whatsappRoutes);
    app.use('/api/parent', parentRoutes);
    app.use('/api/admin', dashboardRoutes);
    app.use('/api/teacher', teacherRoutes);
    app.use('/api/auth', authRoutes);
    app.use('/schoolbase-admin/api', schoolbaseAdminRoutes);
    
    console.log('✓ All routes mounted successfully');
  } catch (error) {
    console.error('Error loading routes:', error);
    throw error;
  }
}

// Start server
async function start() {
  try {
    await ensurePlatformPaymentPlans(prisma);
    await loadRoutes();
  } catch (error) {
    console.error('Failed to load routes:', error);
    process.exit(1);
  }
}

start();

// Error handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 SchoolBase Backend API running on http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
});
