import nodemailer from 'nodemailer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { resolvePublicResultsUrl } from './public-url.js';
import { getPlatformSettingValue, normalizeEmailList } from './platform-settings.js';

const prisma = new PrismaClient();

async function getNotificationRecipients(key: 'signupNotificationRecipients' | 'supportNotificationRecipients'): Promise<string[]> {
  const configured = await getPlatformSettingValue<unknown>(prisma, key, []);
  const recipients = normalizeEmailList(configured);
  if (recipients.length === 0) {
    throw new Error(`No notification recipients configured for ${key}.`);
  }
  return recipients;
}

export function buildTransportConfig() {
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const explicitSecure = process.env.SMTP_SECURE;
  const secure = explicitSecure === undefined
    ? port === 465
    : explicitSecure.toLowerCase() === 'true';

  return {
    host: process.env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure && port === 587,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 5000,
    socketTimeout: 10000,
  };
}

export function assertSmtpAcceptedRecipients(result: { accepted?: Array<string | { address?: string }>; rejected?: Array<string | { address?: string }>; response?: string }, expectedRecipients: string[]) {
  const accepted = new Set((result.accepted ?? []).map((recipient) => typeof recipient === 'string' ? recipient.toLowerCase() : String(recipient.address ?? '').toLowerCase()));
  const rejected = new Set((result.rejected ?? []).map((recipient) => typeof recipient === 'string' ? recipient.toLowerCase() : String(recipient.address ?? '').toLowerCase()));
  const missing = expectedRecipients.map((email) => email.trim().toLowerCase()).filter((email) => !accepted.has(email) || rejected.has(email));
  if (missing.length > 0) {
    throw new Error(`SMTP did not accept all intended recipients (${missing.length} rejected or unconfirmed).`);
  }
}

const transporter = nodemailer.createTransport(buildTransportConfig() as any);

// ═══════════════════════════════════════════════════════════════════════════════
// BRAND COLORS & CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const BRAND = {
  primary: '#0A66C2',        // SchoolBase Blue
  primaryHover: '#004182',   // Darker Blue
  primaryLight: '#E8F4FC',   // Light Blue Background
  success: '#057642',        // Green
  warning: '#915907',        // Orange
  error: '#CC1016',          // Red
  text: '#191919',           // Dark Gray
  textMuted: '#666666',      // Medium Gray
  border: '#E0E0E0',         // Light Gray
  surface: '#FFFFFF',        // White
  background: '#F3F2EF',     // Off-White
};

const DEFAULT_EMAIL_LOGO = 'https://schoolbase.live/logo.png';

export function buildEmailAssetUrlCandidates(value?: string | null): string[] {
  if (!value) return [];
  if (/^https?:\/\//.test(value)) return [value];

  const assetPath = value.startsWith('/') ? value : `/${value}`;
  const configuredBases = [
    process.env.BACKEND_URL,
    process.env.API_URL,
    process.env.BACKEND_API_URL,
    process.env.NEXT_PUBLIC_API_URL,
    'http://localhost:3006',
    'https://api.schoolbase.live',
  ].filter((base): base is string => Boolean(base));

  return [...new Set(configuredBases.map((base) => {
    const normalizedBase = base.replace(/\/+$/, '').replace(/\/api$/, '');
    return new URL(assetPath, normalizedBase).toString();
  }))];
}

function getLogoExtension(contentType: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  return 'img';
}

function getLogoContentType(value: string): string {
  const extension = path.extname(value).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  return 'image/png';
}

export async function fetchInlineLogo(value?: string | null) {
  if (!value) return null;

  if (value.startsWith('/') && !/^https?:\/\//.test(value)) {
    const localPath = path.join(process.cwd(), value.replace(/^\/+/, ''));
    try {
      const content = await readFile(localPath);
      const cid = `school-logo-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      return {
        src: `cid:${cid}`,
        attachment: {
          filename: `school-logo${path.extname(localPath) || '.png'}`,
          content,
          cid,
          contentType: getLogoContentType(localPath),
        },
      };
    } catch {
      // The logo may be stored on a different backend instance; try its public asset URL below.
    }
  }

  for (const assetUrl of buildEmailAssetUrlCandidates(value)) {
    try {
      const response = await fetch(assetUrl);
      if (!response.ok) continue;

      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || 'image/png';
      const cid = `school-logo-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      return {
        src: `cid:${cid}`,
        attachment: {
          filename: `school-logo.${getLogoExtension(contentType)}`,
          content: buffer,
          cid,
          contentType,
        },
      };
    } catch {
      continue;
    }
  }

  return null;
}

const EMAIL_STYLES = `
  * { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: ${BRAND.text};
    line-height: 1.6;
    background-color: ${BRAND.background};
  }
  .email-container {
    max-width: 680px;
    margin: 20px auto;
    background-color: ${BRAND.surface};
    border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.08);
    overflow: hidden;
  }
  .header {
    background: linear-gradient(135deg, ${BRAND.primary} 0%, #084a9a 100%);
    color: ${BRAND.surface};
    padding: 24px 30px;
    text-align: center;
  }
  .header h1 {
    font-size: 28px;
    font-weight: 700;
    margin: 0 0 4px 0;
  }
  .header-subtitle {
    font-size: 14px;
    opacity: 0.9;
    margin: 0;
  }
  .logo {
    width: 40px;
    height: 40px;
    margin: 0 auto 12px;
  }
  .content {
    padding: 40px 30px;
  }
  .content p {
    margin: 0 0 16px 0;
    font-size: 15px;
    color: ${BRAND.text};
  }
  .content h2 {
    font-size: 20px;
    font-weight: 700;
    color: ${BRAND.text};
    margin: 24px 0 16px 0;
  }
  .button {
    display: inline-block;
    background-color: ${BRAND.primary};
    color: ${BRAND.surface};
    padding: 12px 32px;
    text-decoration: none;
    border-radius: 6px;
    font-weight: 600;
    font-size: 14px;
    margin: 20px 0;
  }
  .button:hover {
    background-color: ${BRAND.primaryHover};
  }
  .button-container {
    text-align: center;
    margin: 30px 0;
  }
  .info-box {
    background-color: ${BRAND.primaryLight};
    border-left: 4px solid ${BRAND.primary};
    padding: 16px;
    margin: 20px 0;
    border-radius: 4px;
  }
  .info-box p {
    margin: 0 0 8px 0;
    font-size: 14px;
  }
  .info-box strong {
    font-weight: 600;
    color: ${BRAND.text};
  }
  .warning-box {
    background-color: #FFF3E0;
    border: 1px solid #FFE0B2;
    border-left: 4px solid ${BRAND.warning};
    padding: 16px;
    margin: 20px 0;
    border-radius: 4px;
  }
  .warning-box p {
    margin: 0;
    font-size: 13px;
    color: #92400e;
  }
  .otp-code {
    background-color: ${BRAND.surface};
    border: 2px solid ${BRAND.primary};
    color: ${BRAND.primary};
    font-family: 'Courier New', monospace;
    font-size: 32px;
    font-weight: 700;
    letter-spacing: 4px;
    padding: 20px;
    text-align: center;
    border-radius: 8px;
    margin: 24px 0;
  }
  .status-badge {
    display: inline-block;
    padding: 8px 12px;
    border-radius: 4px;
    font-weight: 600;
    font-size: 13px;
    margin-top: 8px;
  }
  .status-present {
    background-color: #E8F5E9;
    color: ${BRAND.success};
  }
  .status-absent {
    background-color: #FFEBEE;
    color: ${BRAND.error};
  }
  .status-late {
    background-color: #FFF3E0;
    color: ${BRAND.warning};
  }
  .amount-large {
    font-size: 24px;
    font-weight: 700;
    color: ${BRAND.primary};
    margin: 12px 0;
  }
  .list-item {
    margin: 12px 0;
    padding-left: 24px;
    position: relative;
    font-size: 14px;
  }
  .list-item:before {
    content: "✓";
    position: absolute;
    left: 0;
    color: ${BRAND.success};
    font-weight: 700;
  }
  .divider {
    border: none;
    border-top: 1px solid ${BRAND.border};
    margin: 24px 0;
  }
  .footer {
    background-color: ${BRAND.background};
    padding: 24px 30px;
    border-top: 1px solid ${BRAND.border};
    font-size: 12px;
    color: ${BRAND.textMuted};
  }
  .footer a {
    color: ${BRAND.primary};
    text-decoration: none;
  }
  .footer-text {
    margin: 8px 0;
    font-size: 11px;
    color: #999;
  }
`;

/**
 * Validate email address format
 * @param email Email address to validate
 * @returns true if valid, false otherwise
 */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') {
    return false;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim().toLowerCase());
}


// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 1: OTP VERIFICATION EMAIL
// ═══════════════════════════════════════════════════════════════════════════════

export async function sendSignupOtpEmail(email: string, otp: string, schoolName: string) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const safeSchoolName = escapeEmailHtml(schoolName);
    const textBody = `SchoolBase Email Verification Code\n\nHello,\n\nWelcome to SchoolBase! You're creating a school account for ${schoolName}.\n\nTo complete your registration, enter the verification code: ${otp}\n\nThis code expires in 10 minutes. Never share this code with anyone. SchoolBase staff will never ask for your verification code.\n\nIf you didn't request this code, ignore this email. Your email won't be registered unless verified.\n\nContact support at support@schoolbase.live if you need help.`;

    const message = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: 'SchoolBase Email Verification Code',
      text: textBody,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <img src="https://schoolbase.live/logo.png" alt="SchoolBase Logo" class="logo" />
                <h1>SchoolBase</h1>
                <p class="header-subtitle">Verify Your Email Address</p>
              </div>
              <div class="content">
                <p>Hello,</p>
                <p>Welcome to SchoolBase! You're creating a school account for <strong>${safeSchoolName}</strong>.</p>
                <p>To complete your registration, please enter this verification code:</p>
                
                <div style="text-align: center;">
                  <div class="otp-code">${otp}</div>
                </div>
                
                <p style="text-align: center; font-size: 13px; color: ${BRAND.textMuted};">
                  This code expires in 10 minutes
                </p>

                <p style="margin-top: 24px;">Enter this code on the verification screen to unlock your SchoolBase workspace. This code can only be used once.</p>

                <div class="warning-box">
                  <p><strong>🔒 Security Tip:</strong> Never share this code with anyone. SchoolBase staff will never ask for your verification code.</p>
                </div>

                <p style="margin-top: 24px;">If you didn't request this code, you can safely ignore this email. Your email won't be registered unless you verify it.</p>

                <p>Need help? <a href="https://schoolbase.live/help" style="color: ${BRAND.primary};">Contact Support</a></p>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
                <p class="footer-text">Questions? <a href="mailto:support@schoolbase.live">support@schoolbase.live</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    assertSmtpAcceptedRecipients(message, [email]);

    console.log('OTP email accepted by SMTP provider. Message ID:', message.messageId);
    return true;
  } catch (error) {
    console.error('Failed to send OTP email:', error);
    throw error;
  }
}

export async function sendPendingSignupReminderEmail(
  email: string,
  adminName: string,
  schoolName: string,
  otp: string,
) {
  if (!isValidEmail(email)) {
    throw new Error(`Invalid email address: ${email}`);
  }

  const verificationUrl = `https://schoolbase.live/signup/verify?email=${encodeURIComponent(email)}`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
    to: email,
    subject: `Complete your SchoolBase signup - ${schoolName}`,
    text: `Hi ${adminName},\n\nYou started creating a SchoolBase account for ${schoolName}, but your signup is still waiting for email verification.\n\nUse this verification code to complete your signup: ${otp}\n\nThis code expires in 10 minutes. Continue here: ${verificationUrl}\n\nIf you need help, contact support@schoolbase.live.`,
    html: `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"><style>${EMAIL_STYLES}</style></head>
        <body>
          <div class="email-container">
            <div class="header">
              <img src="https://schoolbase.live/logo.png" alt="SchoolBase Logo" class="logo" />
              <h1>SchoolBase</h1>
              <p class="header-subtitle">Complete Your Signup</p>
            </div>
            <div class="content">
              <p>Hi ${adminName},</p>
              <p>You started creating a SchoolBase account for <strong>${schoolName}</strong>, but your signup is still waiting for email verification.</p>
              <p>Use this verification code to complete your signup:</p>
              <div style="text-align: center;"><div class="otp-code">${otp}</div></div>
              <p style="text-align: center; font-size: 13px; color: ${BRAND.textMuted};">This code expires in 10 minutes.</p>
              <div class="button-container"><a href="${verificationUrl}" class="button">Continue Signup</a></div>
              <div class="warning-box"><p><strong>Security tip:</strong> Never share this code with anyone. SchoolBase staff will never ask for it.</p></div>
              <p>Need help? <a href="https://schoolbase.live/help" style="color: ${BRAND.primary};">Contact Support</a></p>
            </div>
            <div class="footer"><p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p><p class="footer-text">Questions? <a href="mailto:support@schoolbase.live">support@schoolbase.live</a></p></div>
          </div>
        </body>
      </html>
    `,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 2: WELCOME EMAIL (ADMIN)
// ═══════════════════════════════════════════════════════════════════════════════

export async function sendWelcomeEmail(email: string, schoolName: string, adminName: string) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const textBody = `Welcome to SchoolBase!\n\nHello ${adminName},\n\nCongratulations! Your workspace for ${schoolName} is now active and ready to use. You now have 7 days of free access to explore all SchoolBase features.\n\nWhat you can do right now:\n- Add your school staff and teachers\n- Register students and their classes\n- Set up fee structures and payment terms\n- Configure your school settings and branding\n- Invite parents to the portal\n\nIf you need help, contact support@schoolbase.live or visit https://schoolbase.live/help.\n\nWarm regards,\nThe SchoolBase Team`;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: `Welcome to SchoolBase! Your workspace is ready – Let's go live in a few minutes`,
      text: textBody,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <img src="https://schoolbase.live/logo.png" alt="SchoolBase Logo" class="logo" />
                <h1>Welcome to SchoolBase!</h1>
                <p class="header-subtitle">Your school's management just got simpler</p>
              </div>
              <div class="content">
                <p>Hello ${adminName},</p>
                <p>Congratulations! Your workspace for <strong>${schoolName}</strong> is now active and ready to use.</p>
                <p>You now have 7 days of free access to explore all SchoolBase features. Let's get your school set up for success!</p>

                <div class="info-box">
                  <p>We've designed SchoolBase to make school management simple. Whether you're managing fees, publishing results, or communicating with parents, everything is designed to save you time and reduce paperwork.</p>
                </div>

                <h2 style="margin-top: 32px;">What you can do right now:</h2>
                <div class="list-item">Add your school staff and teachers</div>
                <div class="list-item">Register students and their classes</div>
                <div class="list-item">Set up fee structures and payment terms</div>
                <div class="list-item">Configure your school settings and branding</div>
                <div class="list-item">Invite parents to the portal</div>

                <h2 style="margin-top: 32px;">Quick Setup Guide:</h2>
                <p><strong>1. Complete Your School Profile</strong><br>Add your school's logo, contact info, and bank details</p>
                <p><strong>2. Add Your Staff</strong><br>Teachers get their own accounts and temporary passwords</p>
                <p><strong>3. Register Students</strong><br>Import from CSV with admission numbers or add manually</p>
                <p><strong>4. Set Up Fees & Classes</strong><br>Define fee structures and organize students into classes</p>
                <p><strong>5. Invite Parents</strong><br>They login with WhatsApp number + child's admission number (no password needed!)</p>

                <div class="button-container">
                  <a href="https://schoolbase.live/admin/dashboard" class="button">Go to Your Dashboard</a>
                </div>

                <p>Our support team is here to help at every step. If you get stuck, just reply to this email or <a href="https://schoolbase.live/help" style="color: ${BRAND.primary};">visit our Help Center</a>.</p>

                <div class="info-box">
                  <p><strong>💡 Pro Tip:</strong> Check out our video tutorials in the Help section—they show you exactly how to set up fees, publish results, and more. Most admins are fully set up in under 30 minutes!</p>
                </div>

                <p style="margin-top: 32px;">Thank you for choosing SchoolBase. We're excited to partner with you in building a better school experience for your entire community.</p>

                <p>Warm regards,<br><strong>The SchoolBase Team 🙌</strong></p>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
                <p class="footer-text"><a href="https://schoolbase.live/help">Help Center</a> | <a href="https://schoolbase.live/contact">Contact Support</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    return true;
  } catch (error) {
    console.error('Failed to send welcome email:', error);
    throw error;
  }
}

// Sends internal notification to configured team addresses when a new school signs up
export async function sendInternalSignupNotification(schoolName: string, adminEmail: string, adminName: string) {
  try {
    const recipients = await getNotificationRecipients('signupNotificationRecipients');
    const to = recipients.join(',');

    const textBody = `New school signup\n\nSchool: ${schoolName}\nAdmin: ${adminName} <${adminEmail}>\n\nPlease follow up as needed.`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to,
      subject: `New School Signup: ${schoolName}`,
      text: textBody,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <img src="https://schoolbase.live/logo.png" alt="SchoolBase Logo" class="logo" />
                <h1>New School Signup</h1>
                <p class="header-subtitle">Notify internal team</p>
              </div>
              <div class="content">
                <p>A new school has completed signup on SchoolBase.</p>
                <div class="list-item"><strong>School:</strong> ${schoolName}</div>
                <div class="list-item"><strong>Admin:</strong> ${adminName} &lt;${adminEmail}&gt;</div>
                <div style="margin-top:18px;">
                  <p>Please review the workspace and reach out to the school to assist with onboarding.</p>
                </div>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase</p>
                <p class="footer-text">Support: <a href="mailto:support@schoolbase.live">support@schoolbase.live</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log('Internal signup notification sent to:', to);
    return true;
  } catch (error) {
    console.error('Failed to send internal signup notification:', error);
    throw error;
  }
}

function getAdsNotificationRecipients(): string[] {
  return (process.env.ADS_NOTIFICATION_EMAILS || process.env.SUPPORT_EMAIL || 'support@schoolbase.live,clickbasetechnologiesltd@gmail.com')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

export function escapeEmailHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] || character));
}

function buildSchoolBaseEmailTemplate({
  title,
  subtitle,
  introHtml,
  detailRows = [],
  actionText,
  actionUrl,
  footerText,
}: {
  title: string;
  subtitle: string;
  introHtml: string;
  detailRows?: Array<[string, string]>;
  actionText?: string;
  actionUrl?: string;
  footerText?: string;
}) {
  const detailHtml = detailRows.length > 0
    ? detailRows.map(([label, value]) => `<div style="margin: 10px 0; font-size: 14px; color: ${BRAND.text};"><strong>${escapeEmailHtml(label)}:</strong> ${escapeEmailHtml(value)}</div>`).join('')
    : '';

  const actionHtml = actionText && actionUrl
    ? `<div style="text-align:center; margin: 28px 0 18px;"><a href="${escapeEmailHtml(actionUrl)}" style="display:inline-block; background-color:${BRAND.primary}; color:${BRAND.surface}; text-decoration:none; padding: 12px 24px; border-radius: 6px; font-weight: 700; font-size: 14px;">${escapeEmailHtml(actionText)}</a></div>`
    : '';

  return `<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>${EMAIL_STYLES}</style>
      </head>
      <body>
        <div class="email-container">
          <div class="header">
            <img src="https://schoolbase.live/logo.png" alt="SchoolBase Logo" class="logo" />
            <h1>${escapeEmailHtml(title)}</h1>
            <p class="header-subtitle">${escapeEmailHtml(subtitle)}</p>
          </div>
          <div class="content">
            ${introHtml}
            ${detailRows.length > 0 ? `<div class="info-box">${detailHtml}</div>` : ''}
            ${actionHtml}
            ${footerText ? `<p style="margin-top: 24px; font-size: 14px; color: ${BRAND.textMuted};">${escapeEmailHtml(footerText)}</p>` : ''}
            <p style="margin-top: 24px;">Warm regards,<br><strong>The SchoolBase Team</strong></p>
          </div>
          <div class="footer">
            <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
            <p class="footer-text"><a href="https://schoolbase.live" style="color: ${BRAND.primary}; text-decoration: none;">SchoolBase</a> | <a href="mailto:support@schoolbase.live" style="color: ${BRAND.primary}; text-decoration: none;">Support</a></p>
          </div>
        </div>
      </body>
    </html>`;
}

export async function sendAdvertiserApplicationNotification(input: {
  companyName: string;
  contactName: string;
  email: string;
  campaignTitle: string;
  landingUrl: string;
  placementTypes: string[];
}) {
  const details = `Company: ${input.companyName}\nContact: ${input.contactName} <${input.email}>\nCampaign: ${input.campaignTitle}\nLanding URL: ${input.landingUrl}\nRequested placements: ${input.placementTypes.join(', ') || 'Not specified'}`;
  const subject = `New advertising application: ${input.companyName}`;
  const html = buildSchoolBaseEmailTemplate({
    title: 'New advertising application',
    subtitle: 'Pending review',
    introHtml: '<p>A new advertiser application is waiting for review.</p>',
    detailRows: [
      ['Company', input.companyName],
      ['Contact', `${input.contactName} <${input.email}>`],
      ['Campaign', input.campaignTitle],
      ['Landing URL', input.landingUrl],
      ['Requested placements', input.placementTypes.join(', ') || 'Not specified'],
    ],
    actionText: 'Open Platform Admin',
    actionUrl: 'https://schoolbase.live/schoolbase-admin/ads',
    footerText: 'Open Platform Admin > Ads & Marketplace to review it.',
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'noreply@schoolbase.live',
    to: getAdsNotificationRecipients().join(','),
    subject,
    text: `A new SchoolBase advertising application needs review.\n\n${details}`,
    html,
  });
}

export async function sendAdvertiserStatusEmail(input: {
  email: string;
  contactName: string;
  companyName: string;
  status: 'RECEIVED' | 'VERIFIED' | 'REJECTED' | 'APPROVED';
  reason?: string | null;
}) {
  const statusText = input.status === 'RECEIVED' ? 'advertising application has been received and is awaiting review' : input.status === 'VERIFIED' ? 'advertiser profile has been verified' : input.status === 'APPROVED' ? 'campaign has been approved for launch' : 'application needs changes before it can proceed';
  const subject = input.status === 'REJECTED' ? `SchoolBase advertising application update: ${input.companyName}` : `SchoolBase advertising update: ${input.companyName}`;
  const message = `Hello ${input.contactName},\n\nYour ${input.companyName} ${statusText}.${input.reason ? `\n\nReview note: ${input.reason}` : ''}\n\nThe SchoolBase team will contact you about the next step.\n\nSchoolBase`;

  const introHtml = input.reason
    ? `<p>Hello ${escapeEmailHtml(input.contactName)},</p><p>Your <strong>${escapeEmailHtml(input.companyName)}</strong> ${escapeEmailHtml(statusText)}.</p><p><strong>Review note:</strong> ${escapeEmailHtml(input.reason)}</p><p>The SchoolBase team will contact you about the next step.</p>`
    : `<p>Hello ${escapeEmailHtml(input.contactName)},</p><p>Your <strong>${escapeEmailHtml(input.companyName)}</strong> ${escapeEmailHtml(statusText)}.</p><p>The SchoolBase team will contact you about the next step.</p>`;

  const detailRows: Array<[string, string]> = [
    ['Company', input.companyName],
    ['Status', statusText],
  ];

  if (input.reason) {
    detailRows.push(['Review note', input.reason]);
  }

  const html = buildSchoolBaseEmailTemplate({
    title: input.status === 'REJECTED' ? 'Application update' : 'Advertising update',
    subtitle: input.status === 'APPROVED' ? 'Approved for launch' : input.status === 'VERIFIED' ? 'Profile verified' : input.status === 'REJECTED' ? 'Changes required' : 'Received and under review',
    introHtml,
    detailRows,
    actionText: input.status === 'APPROVED' ? 'Open SchoolBase' : undefined,
    actionUrl: input.status === 'APPROVED' ? 'https://schoolbase.live/login' : undefined,
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'noreply@schoolbase.live',
    to: input.email,
    subject,
    text: message,
    html,
  });
}

// Notify support team about a new support request from a school
export async function sendSupportRequestNotification(
  requestId: string,
  subject: string,
  messageText: string,
  schoolName?: string,
  schoolEmail?: string | null,
) {
  try {
    const supportRecipients = await getNotificationRecipients('supportNotificationRecipients');
    const recipients = [schoolEmail, ...supportRecipients]
      .filter(Boolean)
      .flatMap((value) => typeof value === 'string' ? [value] : []);
    const to = Array.from(new Set(recipients)).join(',');

    const textBody = `New support request (#${requestId})\n\nSchool: ${schoolName || 'Unknown'}\nSubject: ${subject}\n\nMessage:\n${messageText}`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to,
      subject: `New Support Request: ${subject} [${schoolName || 'Unknown'}]`,
      text: textBody,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <img src="https://schoolbase.live/logo.png" alt="SchoolBase Logo" class="logo" />
                <h1>New Support Request</h1>
                <p class="header-subtitle">Request ID: ${requestId}</p>
              </div>
              <div class="content">
                <div class="list-item"><strong>School:</strong> ${schoolName || 'Unknown'}</div>
                <div class="list-item"><strong>Subject:</strong> ${subject}</div>
                <h2 style="margin-top:16px;">Message</h2>
                <p style="white-space:pre-wrap;">${messageText}</p>
                <div style="margin-top:20px;">
                  <p>View the request in the admin panel and respond as needed.</p>
                </div>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase</p>
                <p class="footer-text">Support: <a href="mailto:support@schoolbase.live">support@schoolbase.live</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log('Support request notification sent to:', to);
    return true;
  } catch (error) {
    console.error('Failed to send support request notification:', error);
    throw error;
  }
}

// Notify school and support team when a support request is resolved or closed
export async function sendSupportStatusUpdateNotification(
  requestId: string,
  status: string,
  subject: string,
  messageText: string,
  schoolName?: string,
  schoolEmail?: string | null,
) {
  try {
    const supportRecipients = await getNotificationRecipients('supportNotificationRecipients');
    const recipients = [schoolEmail, ...supportRecipients]
      .filter(Boolean)
      .flatMap((value) => typeof value === 'string' ? [value] : []);
    const to = Array.from(new Set(recipients)).join(',');

    const normalizedStatus = status.toUpperCase();
    const textBody = `Support request update (#${requestId})\n\nStatus: ${normalizedStatus}\nSchool: ${schoolName || 'Unknown'}\nSubject: ${subject}\n\nMessage:\n${messageText}`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to,
      subject: `Support Request ${normalizedStatus}: #${requestId} [${schoolName || 'Unknown'}]`,
      text: textBody,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <img src="https://schoolbase.live/logo.png" alt="SchoolBase Logo" class="logo" />
                <h1>Support Request ${normalizedStatus}</h1>
                <p class="header-subtitle">Request ID: ${requestId}</p>
              </div>
              <div class="content">
                <div class="list-item"><strong>School:</strong> ${schoolName || 'Unknown'}</div>
                <div class="list-item"><strong>Subject:</strong> ${subject}</div>
                <div class="list-item"><strong>Status:</strong> ${normalizedStatus}</div>
                <h2 style="margin-top:16px;">Update</h2>
                <p style="white-space:pre-wrap;">${messageText}</p>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase</p>
                <p class="footer-text">Support: <a href="mailto:support@schoolbase.live">support@schoolbase.live</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log('Support status notification sent to:', to);
    return true;
  } catch (error) {
    console.error('Failed to send support status notification:', error);
    throw error;
  }
}

// Notify support team about a follow-up message on an existing support request
export async function sendSupportFollowupNotification(
  requestId: string,
  messageText: string,
  schoolName?: string,
  schoolEmail?: string | null,
) {
  try {
    const supportRecipients = await getNotificationRecipients('supportNotificationRecipients');
    const recipients = [schoolEmail, ...supportRecipients]
      .filter(Boolean)
      .flatMap((value) => typeof value === 'string' ? [value] : []);
    const to = Array.from(new Set(recipients)).join(',');

    const textBody = `Support request update (#${requestId})\n\nSchool: ${schoolName || 'Unknown'}\n\nMessage:\n${messageText}`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to,
      subject: `Support Request Update: #${requestId} [${schoolName || 'Unknown'}]`,
      text: textBody,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <img src="https://schoolbase.live/logo.png" alt="SchoolBase Logo" class="logo" />
                <h1>Support Request Update</h1>
                <p class="header-subtitle">Request ID: ${requestId}</p>
              </div>
              <div class="content">
                <div class="list-item"><strong>School:</strong> ${schoolName || 'Unknown'}</div>
                <h2 style="margin-top:16px;">New Message</h2>
                <p style="white-space:pre-wrap;">${messageText}</p>
                <div style="margin-top:20px;">
                  <p>View the request in the admin panel and respond as needed.</p>
                </div>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase</p>
                <p class="footer-text">Support: <a href="mailto:support@schoolbase.live">support@schoolbase.live</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log('Support followup notification sent to:', to);
    return true;
  } catch (error) {
    console.error('Failed to send support followup notification:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 3: PASSWORD RESET EMAIL
// ═══════════════════════════════════════════════════════════════════════════════

export async function sendPasswordResetEmail(email: string, resetLink: string, userName: string) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const textBody = `Reset Your SchoolBase Password\n\nHello ${userName},\n\nWe received a request to reset the password for your SchoolBase account. Use the link below to create a new password:\n${resetLink}\n\nThis link expires in 1 hour. If you didn't request this, ignore the email or contact support@schoolbase.live.\n\nNever share your password with anyone. SchoolBase staff will never ask for your password.`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: 'Reset Your SchoolBase Password',
      text: textBody,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <img src="https://schoolbase.live/logo.png" alt="SchoolBase Logo" class="logo" />
                <h1>Reset Your Password</h1>
                <p class="header-subtitle">SchoolBase Account Security</p>
              </div>
              <div class="content">
                <p>Hello ${userName},</p>
                <p>We received a request to reset the password for your SchoolBase account. If you made this request, click the button below to create a new password:</p>

                <div class="button-container">
                  <a href="${resetLink}" class="button">Reset Your Password</a>
                </div>

                <p style="font-size: 13px; color: ${BRAND.textMuted};">Or copy and paste this link in your browser:</p>
                <p style="background-color: ${BRAND.background}; padding: 12px; border-radius: 4px; word-break: break-all; font-size: 12px; color: ${BRAND.text}; margin: 12px 0;">
                  <a href="${resetLink}" style="color: ${BRAND.primary};">${resetLink}</a>
                </p>

                <div class="warning-box">
                  <p><strong>⏰ Important:</strong> This link expires in 1 hour. If you don't use it within an hour, you'll need to request a new password reset.</p>
                </div>

                <p><strong>Didn't request this?</strong> Your account may have been compromised. If you didn't request a password reset, please <a href="https://schoolbase.live/contact" style="color: ${BRAND.primary};">contact our support team</a> immediately or ignore this email. Your password won't change unless you complete the reset.</p>

                <h2 style="font-size: 14px; margin-top: 24px;">Security Tips:</h2>
                <div class="list-item">Never share your password with anyone</div>
                <div class="list-item">SchoolBase staff will never ask for your password</div>
                <div class="list-item">Always use a strong, unique password</div>

                <p style="margin-top: 32px;">Need help? <a href="https://schoolbase.live/help" style="color: ${BRAND.primary};">Visit our Help Center</a> or reply to this email.</p>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
                <p class="footer-text">Security concern? <a href="mailto:support@schoolbase.live">Report it</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    return true;
  } catch (error) {
    console.error('Failed to send password reset email:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 4: FEE REMINDER EMAIL (PARENTS)
// ═══════════════════════════════════════════════════════════════════════════════

export async function sendFeeReminderEmail(
  email: string,
  guardianName: string,
  pupilName: string,
  className: string,
  termName: string,
  currency: string,
  totalAmount: string,
  paidAmount: string,
  outstandingAmount: string,
  schoolName: string,
  schoolLogo?: string,
) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const schoolLogoInline = await fetchInlineLogo(schoolLogo);
    const attachments = schoolLogoInline?.attachment ? [schoolLogoInline.attachment] : undefined;
    const textBody = `School Fee Payment Reminder - ${schoolName}\n\nDear ${guardianName},\n\nThis is a friendly reminder that there is an outstanding school fee balance for ${pupilName}.\n\nStudent: ${pupilName}\nClass: ${className}\nTerm: ${termName}\n\nOutstanding Balance: ${currency} ${outstandingAmount}\nTotal Fees: ${currency} ${totalAmount}\nAlready Paid: ${currency} ${paidAmount}\n\nPlease arrange payment as soon as possible to avoid disruptions. Contact the school office for payment options or visit https://schoolbase.live/parent/invoices to review the invoice.\n\nThank you,\n${schoolName} Finance Team`;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: `School Fee Payment Reminder - ${schoolName}`,
      text: textBody,
      ...(attachments ? { attachments } : {}),
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                ${schoolLogoInline ? `<img src="${schoolLogoInline.src}" alt="${schoolName}" class="logo" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover;">` : `<img src="${DEFAULT_EMAIL_LOGO}" alt="SchoolBase Logo" class="logo" />`}
                <h1>${schoolName}</h1>
                <p class="header-subtitle">School Fee Payment Reminder</p>
              </div>
              <div class="content">
                <p>Dear ${guardianName},</p>
                <p>We hope this message finds you well. This is a friendly reminder that there is an outstanding school fee balance for <strong>${pupilName}</strong>.</p>

                <div class="info-box">
                  <p><strong>Student:</strong> ${pupilName}</p>
                  <p><strong>Class:</strong> ${className}</p>
                  <p><strong>Term:</strong> ${termName}</p>
                </div>

                <h2 style="margin-top: 32px; text-align: center;">Outstanding Balance</h2>
                <p style="text-align: center;"><strong style="font-size: 20px; color: ${BRAND.error};">${currency} ${outstandingAmount}</strong></p>
                <p style="text-align: center; font-size: 13px; color: ${BRAND.textMuted};">Total Fees: ${currency} ${totalAmount} | Already Paid: ${currency} ${paidAmount}</p>

                <p style="margin-top: 24px;">We kindly request that you arrange payment at your earliest convenience to ensure there are no disruptions to your child's education and access to school records.</p>

                <div class="info-box">
                  <p><strong>Payment Methods:</strong></p>
                  <p>Please contact the school office for available payment options and bank account details. We accept bank transfers, mobile money, and cheques.</p>
                </div>

                <div class="button-container">
                  <a href="https://schoolbase.live/parent/invoices" class="button">View Full Invoice Details</a>
                </div>

                <div class="warning-box">
                  <p><strong>✓ Already paid?</strong> If you've recently made this payment, please disregard this reminder. Your payment may still be processing. Thank you for your support!</p>
                </div>

                <p>If you have any questions, concerns, or need to discuss a payment plan, please don't hesitate to contact the school office directly. We're here to support you.</p>

                <p>Best regards,<br><strong>${schoolName} Finance Team</strong></p>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
                <p class="footer-text">Questions? <a href="mailto:support@schoolbase.live">Contact ${schoolName}</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log('Fee reminder email sent to:', email);
    return true;
  } catch (error) {
    console.error('Failed to send fee reminder email:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 5: FEE PAYMENT RECEIPT EMAIL
// ═══════════════════════════════════════════════════════════════════════

export async function sendFeePaymentReceiptEmail(
  email: string,
  guardianName: string,
  pupilName: string,
  className: string,
  currency: string,
  amountPaid: string,
  totalPaid: string,
  balance: string,
  schoolName: string,
  schoolLogo?: string,
  itemBreakdown?: string,
) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const schoolLogoInline = await fetchInlineLogo(schoolLogo);
    const attachments = schoolLogoInline?.attachment ? [schoolLogoInline.attachment] : undefined;
    const itemSection = itemBreakdown ? `\n\nFee item balances:\n${itemBreakdown}` : '';
    const textBody = `School Fee Payment Receipt - ${schoolName}\n\nHello ${guardianName},\n\nWe have received a payment of ${currency} ${amountPaid} for ${pupilName}.\n\nStudent: ${pupilName}\nClass: ${className}\nAmount Paid: ${currency} ${amountPaid}\nTotal Paid: ${currency} ${totalPaid}\nBalance: ${currency} ${balance}${itemSection}\n\nThank you for your prompt payment. If you have questions, please contact the school office.`;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: `Payment Receipt - ${schoolName}`,
      text: textBody,
      ...(attachments ? { attachments } : {}),
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                ${schoolLogoInline ? `<img src="${schoolLogoInline.src}" alt="${schoolName}" class="logo" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover;">` : `<img src="${DEFAULT_EMAIL_LOGO}" alt="SchoolBase Logo" class="logo" />`}
                <h1>${schoolName}</h1>
                <p class="header-subtitle">Payment Receipt</p>
              </div>
              <div class="content">
                <p>Hello ${guardianName},</p>
                <p>Thank you! We have received your payment for <strong>${pupilName}</strong>.</p>
                <div class="info-box">
                  <p><strong>Student:</strong> ${pupilName}</p>
                  <p><strong>Class:</strong> ${className}</p>
                  <p><strong>Amount Paid:</strong> ${currency} ${amountPaid}</p>
                  <p><strong>Total Paid:</strong> ${currency} ${totalPaid}</p>
                  <p><strong>Balance:</strong> ${currency} ${balance}</p>
                </div>
                ${itemBreakdown ? `<div class="info-box"><p><strong>Fee item balances:</strong></p><p style="white-space: pre-line;">${itemBreakdown}</p></div>` : ''}
                <p>If you have any questions about this payment, please contact the school office.</p>
                <div class="button-container">
                  <a href="https://schoolbase.live/parent/invoices" class="button">View Invoice Details</a>
                </div>
                <p>Best regards,<br><strong>${schoolName} Finance Team</strong></p>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 ${schoolName}. All rights reserved.</p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log('Fee payment receipt email sent to:', email);
    return true;
  } catch (error) {
    console.error('Failed to send fee payment receipt email:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 5: TEACHER WELCOME EMAIL
// ═══════════════════════════════════════════════════════════════════════════════

export async function sendTeacherWelcomeEmail(
  email: string,
  teacherName: string,
  schoolName: string,
  temporaryPassword?: string,
  loginUrl: string = 'https://www.schoolbase.live/login',
  schoolLogo?: string,
) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const schoolLogoInline = await fetchInlineLogo(schoolLogo);
    const attachments = schoolLogoInline?.attachment ? [schoolLogoInline.attachment] : undefined;
    const textBody = `Welcome to ${schoolName} on SchoolBase\n\nHello ${teacherName},\n\nWelcome to the ${schoolName} teacher portal on SchoolBase! Your account has been created and you're ready to get started.\n\nEmail: ${email}${temporaryPassword ? `\nTemporary Password: ${temporaryPassword}` : ''}\n\nPlease change your temporary password immediately after your first login. Login at ${loginUrl}.\n\nWhat you can do on SchoolBase:\n- View your class roster and student list\n- Record attendance quickly\n- Enter marks and auto-calculate grades\n- Publish results to parents\n- Write comments and observations\n- View class broadsheet\n\nNeed help? Visit https://schoolbase.live/teacher-guide or https://schoolbase.live/help.\n\nBest regards,\nThe SchoolBase Team`;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: `Welcome to ${schoolName} on SchoolBase`,
      text: textBody,
      ...(attachments ? { attachments } : {}),
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                ${schoolLogoInline ? `<img src="${schoolLogoInline.src}" alt="${schoolName}" class="logo" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover;">` : `<img src="${DEFAULT_EMAIL_LOGO}" alt="SchoolBase Logo" class="logo" />`}
                <h1>${schoolName}</h1>
                <p class="header-subtitle">Welcome to your teacher portal</p>
              </div>
              <div class="content">
                <p>Hello ${teacherName},</p>
                <p>Welcome to the <strong>${schoolName}</strong> teacher portal on SchoolBase! Your account has been created by your school administration, and you're ready to get started.</p>
                <p>SchoolBase makes it easy to manage your classes, track student progress, and communicate with parents—all from one place.</p>

                <h2 style="font-size: 16px; margin-top: 24px;">Your Login Details:</h2>
                <div class="info-box">
                  <p><strong>Email:</strong> ${email}</p>
                  ${temporaryPassword ? `<p><strong>Temporary Password:</strong> ${temporaryPassword}</p>` : ''}
                </div>

                <div class="warning-box">
                  <p><strong>🔒 Important:</strong> Please change your temporary password immediately after your first login. Use a strong, unique password that only you know.</p>
                </div>

                <h2 style="font-size: 16px; margin-top: 24px;">What You Can Do on SchoolBase:</h2>
                <div class="list-item">View your class roster and student list with complete details</div>
                <div class="list-item">Record attendance in 30 seconds (mark entire class at once)</div>
                <div class="list-item">Enter marks and auto-calculate grades automatically</div>
                <div class="list-item">Publish results instantly to parents via WhatsApp</div>
                <div class="list-item">Write student comments and observations per student</div>
                <div class="list-item">View class broadsheet (all students' marks in one table)</div>
                <div class="list-item">Send school announcements to all parents in your class</div>
                <div class="list-item">Track student performance trends across terms</div>
                <div class="list-item">Access school announcements and resources</div>
                <div class="list-item">Manage your teacher profile and settings</div>

                <div class="button-container">
                  <a href="${loginUrl}" class="button">Log In to Your Portal</a>
                </div>

                <p><strong>Need Help?</strong> Check out our <a href="https://schoolbase.live/teacher-guide" style="color: ${BRAND.primary};">Teacher's Guide</a> and video tutorials. Most teachers are comfortable with the system within their first day!</p>

                <p>Our support team is here if you have any questions. Just reply to this email or <a href="https://schoolbase.live/help" style="color: ${BRAND.primary};">visit our Help Center</a>.</p>

                <p style="margin-top: 32px;">Welcome to the team! We're excited to help you focus on what matters most—your students' success.</p>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
                <p class="footer-text">Support: <a href="mailto:support@schoolbase.live">support@schoolbase.live</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log('Teacher welcome email sent to:', email);
    return true;
  } catch (error) {
    console.error('Failed to send teacher welcome email:', error);
    throw error;
  }
}

export function buildAdmissionApplicantEmailContent(input: {
  schoolName: string;
  subject: string;
  body: string;
  logoSrc: string;
}) {
  const escapeHtml = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const bodyHtml = input.body
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.trim())
    .map((paragraph) => {
      const escaped = escapeHtml(paragraph).replace(/\n/g, '<br>');
      const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color: ${BRAND.primary};">$1</a>');
      return `<p>${linked}</p>`;
    })
    .join('');

  return {
    text: `${input.body}\n\nWarm regards,\n${input.schoolName} Admissions Team\n\nQuestions? Contact support@schoolbase.live`,
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>${EMAIL_STYLES}</style>
        </head>
        <body>
          <div class="email-container">
            <div class="header">
              <img src="${input.logoSrc}" alt="${escapeHtml(input.schoolName)}" class="logo" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover;">
              <h1>${escapeHtml(input.schoolName)}</h1>
              <p class="header-subtitle">${escapeHtml(input.subject)}</p>
            </div>
            <div class="content">
              ${bodyHtml}
              <p style="margin-top: 32px;">Warm regards,<br><strong>${escapeHtml(input.schoolName)} Admissions Team</strong></p>
              <p>Questions? Contact <a href="mailto:support@schoolbase.live" style="color: ${BRAND.primary};">SchoolBase Support</a>.</p>
            </div>
            <div class="footer">
              <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
              <p class="footer-text">Support: <a href="mailto:support@schoolbase.live">support@schoolbase.live</a></p>
            </div>
          </div>
        </body>
      </html>
    `,
  };
}

export async function sendAdmissionApplicantEmail(
  email: string,
  schoolName: string,
  subject: string,
  body: string,
  schoolLogo?: string | null,
) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const schoolLogoInline = await fetchInlineLogo(schoolLogo);
    const attachments = schoolLogoInline?.attachment ? [schoolLogoInline.attachment] : undefined;
    const content = buildAdmissionApplicantEmailContent({
      schoolName,
      subject,
      body,
      logoSrc: schoolLogoInline?.src ?? DEFAULT_EMAIL_LOGO,
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject,
      text: content.text,
      ...(attachments ? { attachments } : {}),
      html: content.html,
    });

    console.log('Branded admission applicant email sent to:', email);
    return true;
  } catch (error) {
    console.error('Failed to send branded admission applicant email:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE 6: ATTENDANCE NOTIFICATION EMAIL
// ═══════════════════════════════════════════════════════════════════════════════

export async function sendAttendanceNotificationEmail(
  email: string,
  guardianName: string,
  pupilName: string,
  className: string,
  date: string,
  status: 'present' | 'absent' | 'late',
  schoolName: string,
  customMessage?: string,
  schoolLogo?: string,
) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const statusColors: Record<string, { bg: string; text: string; label: string }> = {
      present: { bg: '#E8F5E9', text: BRAND.success, label: 'PRESENT ✓' },
      absent: { bg: '#FFEBEE', text: BRAND.error, label: 'ABSENT ✗' },
      late: { bg: '#FFF3E0', text: BRAND.warning, label: 'LATE ⏰' },
    };

    const statusColor = statusColors[status] || statusColors.present;

    const schoolLogoInline = await fetchInlineLogo(schoolLogo);
    const attachments = schoolLogoInline?.attachment ? [schoolLogoInline.attachment] : undefined;

    const textBody = `Attendance Update - ${pupilName}\n\nHello ${guardianName},\n\nHere's the latest attendance update for ${pupilName}:\nStatus: ${statusColor.label}\nClass: ${className}\nDate: ${date}\n\n${customMessage ? `Note from teacher: ${customMessage}\n\n` : ''}View the full attendance record at https://schoolbase.live/parent/attendance.\n\nBest regards,\n${schoolName} Administration`;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: `Attendance Update - ${pupilName}`,
      text: textBody,
      ...(attachments ? { attachments } : {}),
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                ${schoolLogoInline ? `<img src="${schoolLogoInline.src}" alt="${schoolName}" class="logo" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover;">` : `<img src="${DEFAULT_EMAIL_LOGO}" alt="SchoolBase Logo" class="logo" />`}
                <h1>${schoolName}</h1>
                <p class="header-subtitle">Attendance Update</p>
              </div>
              <div class="content">
                <p>Hello ${guardianName},</p>
                <p>Here's the latest attendance update for <strong>${pupilName}</strong>:</p>

                <div style="text-align: center; margin: 24px 0;">
                  <div class="status-badge status-${status}" style="background-color: ${statusColor.bg}; color: ${statusColor.text}; padding: 12px 20px; font-size: 16px; font-weight: 700;">
                    ${statusColor.label}
                  </div>
                </div>

                <div class="info-box">
                  <p><strong>Student:</strong> ${pupilName}</p>
                  <p><strong>Class:</strong> ${className}</p>
                  <p><strong>Date:</strong> ${date}</p>
                </div>

                ${customMessage ? `<div style="background-color: ${BRAND.background}; padding: 16px; border-radius: 4px; margin: 20px 0;"><p><strong>Note from teacher:</strong></p><p>${customMessage}</p></div>` : ''}

                <p style="margin-top: 24px;">We keep you informed with daily attendance updates so you're always aware of your child's school presence. If you have any concerns or questions, please reach out to the school.</p>

                <div class="button-container">
                  <a href="https://schoolbase.live/parent/attendance" class="button">View Full Attendance Record</a>
                </div>

                <p>Best regards,<br><strong>${schoolName} Administration</strong></p>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
                <p class="footer-text">Questions? Contact <a href="mailto:support@schoolbase.live">${schoolName}</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log('Attendance notification email sent to:', email);
    return true;
  } catch (error) {
    console.error('Failed to send attendance notification email:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// TEMPLATE 7: STUDENT ADMISSION NOTIFICATION EMAIL
// ═══════════════════════════════════════════════════════════════════════

export async function sendAnnouncementEmail(
  email: string,
  guardianName: string,
  announcementTitle: string,
  announcementBody: string,
  schoolName: string,
  schoolLogo?: string,
) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const schoolLogoInline = await fetchInlineLogo(schoolLogo);
    const attachments = schoolLogoInline?.attachment ? [schoolLogoInline.attachment] : undefined;

    const textBody = `${announcementTitle}\n\nHello ${guardianName},\n\n${announcementBody}\n\nVisit the parent portal for more information and updates.\n\nBest regards,\n${schoolName} Administration`;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: announcementTitle,
      text: textBody,
      ...(attachments ? { attachments } : {}),
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                ${schoolLogoInline ? `<img src="${schoolLogoInline.src}" alt="${schoolName}" class="logo" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover;">` : `<img src="${DEFAULT_EMAIL_LOGO}" alt="SchoolBase Logo" class="logo" />`}
                <h1>${schoolName}</h1>
                <p class="header-subtitle">School Announcement</p>
              </div>
              <div class="content">
                <p>Hello ${guardianName},</p>
                <p><strong>${announcementTitle}</strong></p>
                <div class="info-box">
                  <p>${announcementBody}</p>
                </div>
                <div class="button-container">
                  <a href="https://schoolbase.live/parent/announcements" class="button">View Announcement</a>
                </div>
                <p>Best regards,<br><strong>${schoolName} Administration</strong></p>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 ${schoolName}. All rights reserved.</p>
                <p class="footer-text"><a href="https://schoolbase.live">Visit SchoolBase</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log('Announcement email sent to:', email);
    return true;
  } catch (error) {
    console.error('Failed to send announcement email:', error);
    throw error;
  }
}

export function buildResultsPublishedWhatsAppMessage(input: {
  guardianName: string;
  pupilName: string;
  assessmentName: string;
  termName?: string;
  schoolName: string;
  resultsUrl: string;
}) {
  return [
    `Hello ${input.guardianName} 👋`,
    `Results for ${input.pupilName} have been published at ${input.schoolName}.`,
    `Assessment: ${input.assessmentName}`,
    `Term: ${input.termName || 'Current Term'}`,
    `View them here: ${input.resultsUrl}`,
  ].join('\n');
}

export function buildResultsPublishedEmailContent(input: {
  guardianName: string;
  pupilName: string;
  assessmentName: string;
  termName?: string;
  schoolName: string;
  resultsUrl: string;
}) {
  const subject = `Results Published - ${input.pupilName}`;
  const text = `Results Published - ${input.schoolName}\n\nHello ${input.guardianName},\n\nNew results for ${input.pupilName} have been published.\n\nAssessment: ${input.assessmentName}\nTerm: ${input.termName || 'Current Term'}\n\nYou can view the latest results here: ${input.resultsUrl}\n\nBest regards,\n${input.schoolName} Administration`;
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>${EMAIL_STYLES}</style>
      </head>
      <body>
        <div class="email-container">
          <div class="header">
            <h1>${input.schoolName}</h1>
            <p class="header-subtitle">Results Published</p>
          </div>
          <div class="content">
            <p>Hello ${input.guardianName},</p>
            <p>New results for <strong>${input.pupilName}</strong> have been published.</p>
            <div class="info-box">
              <p><strong>Assessment:</strong> ${input.assessmentName}</p>
              <p><strong>Term:</strong> ${input.termName || 'Current Term'}</p>
            </div>
            <div class="button-container">
              <a href="${input.resultsUrl}" class="button">View Results</a>
            </div>
            <p>Best regards,<br><strong>${input.schoolName} Administration</strong></p>
          </div>
          <div class="footer">
            <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
            <p class="footer-text"><a href="https://schoolbase.live">Visit SchoolBase</a></p>
          </div>
        </div>
      </body>
    </html>
  `;

  return { subject, text, html };
}

export function buildPinDeliveryWhatsAppMessage(input: {
  guardianName: string;
  pupilName: string;
  pin: string;
  schoolName: string;
  schoolCode?: string;
  admissionNumber?: string;
  sessionName?: string;
  termName?: string;
  resultsUrl: string;
}) {
  return [
    `Hello ${input.guardianName} 👋`,
    `Your result access PIN for ${input.pupilName} is ready at ${input.schoolName}.`,
    `School code: ${input.schoolCode || '—'}`,
    `Student: ${input.pupilName}`,
    `Admission number: ${input.admissionNumber || '—'}`,
    `Session: ${input.sessionName || '—'}`,
    `Term: ${input.termName || '—'}`,
    `PIN: ${input.pin}`,
    `How to access the result/check: ${input.resultsUrl}`,
    `Please keep this information secure and use the PIN when checking results.`,
  ].join('\n');
}

export function buildPinDeliveryEmailContent(input: {
  guardianName: string;
  pupilName: string;
  pin: string;
  schoolName: string;
  schoolCode?: string;
  admissionNumber?: string;
  sessionName?: string;
  termName?: string;
  resultsUrl: string;
}) {
  const subject = `Result PIN Ready - ${input.pupilName}`;
  const text = [
    `Result PIN Ready - ${input.schoolName}`,
    '',
    `Hello ${input.guardianName},`,
    '',
    `Your result access PIN for ${input.pupilName} is ready.`,
    '',
    `School code: ${input.schoolCode || '—'}`,
    `Student: ${input.pupilName}`,
    `Admission number: ${input.admissionNumber || '—'}`,
    `Session: ${input.sessionName || '—'}`,
    `Term: ${input.termName || '—'}`,
    '',
    `PIN: ${input.pin}`,
    '',
    `How to access the result/check: ${input.resultsUrl}`,
    '',
    'Please keep this information secure and use the PIN when checking results.',
    '',
    `Best regards,`,
    `${input.schoolName} Administration`,
  ].join('\n');
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>${EMAIL_STYLES}</style>
      </head>
      <body>
        <div class="email-container">
          <div class="header">
            <h1>${input.schoolName}</h1>
            <p class="header-subtitle">Result PIN Ready</p>
          </div>
          <div class="content">
            <p>Hello ${input.guardianName},</p>
            <p>Your result access PIN for <strong>${input.pupilName}</strong> is ready.</p>
            <div class="info-box">
              <p><strong>School code:</strong> ${input.schoolCode || '—'}</p>
              <p><strong>Student:</strong> ${input.pupilName}</p>
              <p><strong>Admission number:</strong> ${input.admissionNumber || '—'}</p>
              <p><strong>Session:</strong> ${input.sessionName || '—'}</p>
              <p><strong>Term:</strong> ${input.termName || '—'}</p>
            </div>
            <div class="otp-code">${input.pin}</div>
            <div class="button-container">
              <a href="${input.resultsUrl}" class="button">Check Results</a>
            </div>
            <p style="font-size: 13px; color: ${BRAND.textMuted};">How to access the result/check: <a href="${input.resultsUrl}" style="color: ${BRAND.primary};">${input.resultsUrl}</a></p>
            <p style="margin-top: 16px;">Please keep this information secure and use the PIN when checking results.</p>
            <p>Best regards,<br><strong>${input.schoolName} Administration</strong></p>
          </div>
          <div class="footer">
            <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
            <p class="footer-text"><a href="https://schoolbase.live">Visit SchoolBase</a></p>
          </div>
        </div>
      </body>
    </html>
  `;

  return { subject, text, html };
}

export async function sendResultsPublishedEmail(
  email: string,
  guardianName: string,
  pupilName: string,
  assessmentName: string,
  termName: string,
  schoolName: string,
  schoolLogo?: string,
  resultsUrl?: string,
) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const schoolLogoInline = await fetchInlineLogo(schoolLogo);
    const attachments = schoolLogoInline?.attachment ? [schoolLogoInline.attachment] : undefined;
    const resolvedResultsUrl = resolvePublicResultsUrl(resultsUrl);
    const content = buildResultsPublishedEmailContent({
      guardianName,
      pupilName,
      assessmentName,
      termName,
      schoolName,
      resultsUrl: resolvedResultsUrl,
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: content.subject,
      text: content.text,
      ...(attachments ? { attachments } : {}),
      html: content.html.replace(/<h1>[^<]+<\/h1>/, `<h1>${schoolName}</h1>`),
    });

    console.log('Results published email sent to:', email);
    return true;
  } catch (error) {
    console.error('Failed to send results published email:', error);
    throw error;
  }
}

export async function sendPinDeliveryEmail(
  email: string,
  guardianName: string,
  pupilName: string,
  pin: string,
  schoolName: string,
  schoolLogo?: string,
  resultsUrl?: string,
  schoolCode?: string,
  admissionNumber?: string,
  sessionName?: string,
  termName?: string,
) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const schoolLogoInline = await fetchInlineLogo(schoolLogo);
    const attachments = schoolLogoInline?.attachment ? [schoolLogoInline.attachment] : undefined;
    const resolvedResultsUrl = resolvePublicResultsUrl(resultsUrl);
    const content = buildPinDeliveryEmailContent({
      guardianName,
      pupilName,
      pin,
      schoolName,
      schoolCode,
      admissionNumber,
      sessionName,
      termName,
      resultsUrl: resolvedResultsUrl,
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: content.subject,
      text: content.text,
      ...(attachments ? { attachments } : {}),
      html: content.html
        .replace(/<h1>[^<]+<\/h1>/, `<h1>${schoolName}</h1>`)
        .replace(/<div class="header">/, `<div class="header">${schoolLogoInline ? `<img src="${schoolLogoInline.src}" alt="${schoolName}" class="logo" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover;">` : `<img src="${DEFAULT_EMAIL_LOGO}" alt="SchoolBase Logo" class="logo" />`}`),
    });

    console.log('PIN delivery email sent to:', email);
    return true;
  } catch (error) {
    console.error('Failed to send PIN delivery email:', error);
    throw error;
  }
}

export async function sendAdmissionNotificationEmail(
  email: string,
  guardianName: string,
  pupilName: string,
  className: string,
  admissionNo: string,
  schoolName: string,
  schoolLogo?: string,
) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const schoolLogoInline = await fetchInlineLogo(schoolLogo);
    const attachments = schoolLogoInline?.attachment ? [schoolLogoInline.attachment] : undefined;
    const parentPortalUrl = `${(process.env.FRONTEND_URL || 'https://www.schoolbase.live').replace(/\/$/, '')}/parent/login`;
    const textBody = `Student Registration\n\nHello ${guardianName},\n\nWelcome to ${schoolName} on SchoolBase. ${pupilName} has been successfully registered for ${className}.\n\nAdmission number: ${admissionNo}\n\nParent portal login: ${parentPortalUrl}\n\nHow to use it:\n1. Open the parent portal link.\n2. Enter the phone number registered with the school.\n3. Enter your child's admission number.\n4. Sign in to view fees, results, attendance, notices, and other school updates.\n\nNo password is required. Please contact the school office if you need help.`;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: `${pupilName} has been registered at ${schoolName}`,
      text: textBody,
      ...(attachments ? { attachments } : {}),
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                ${schoolLogoInline ? `<img src="${schoolLogoInline.src}" alt="${schoolName}" class="logo" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover;">` : `<img src="${DEFAULT_EMAIL_LOGO}" alt="SchoolBase Logo" class="logo" />`}
                <h1>${schoolName}</h1>
                <p class="header-subtitle">Student Registration</p>
              </div>
              <div class="content">
                <p>Hello ${guardianName},</p>
                <p>We’re pleased to let you know that <strong>${pupilName}</strong> has been successfully registered for <strong>${className}</strong> at <strong>${schoolName}</strong>.</p>
                <div class="info-box">
                  <p><strong>Student Name:</strong> ${pupilName}</p>
                  <p><strong>Admission Number:</strong> ${admissionNo}</p>
                  <p><strong>Class:</strong> ${className}</p>
                </div>
                <p><strong>How to sign in:</strong> Open the parent portal, enter the phone number registered with the school and your child&apos;s admission number, then tap <strong>Sign in</strong>. No password is required.</p>
                <p>From the parent portal, you can view fees, results, attendance, notices, and other school updates. Please contact the school office if you need help.</p>
                <div class="button-container">
                  <a href="${parentPortalUrl}" class="button">Open Parent Portal</a>
                </div>
                <p>Thank you for choosing SchoolBase to support your child’s education.</p>
                <p>Warm regards,<br><strong>The ${schoolName} Team</strong></p>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
                <p class="footer-text"><a href="https://schoolbase.live/help">Help Center</a> | <a href="mailto:support@schoolbase.live">Contact Support</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log('Admission notification email sent to:', email);
    return true;
  } catch (error) {
    console.error('Failed to send admission notification email:', error);
    throw error;
  }
}

export async function sendAdmissionApplicantStatusEmail({
  email,
  applicantName,
  schoolName,
  status,
  requestedInformation,
  statusUrl,
  schoolLogo,
}: {
  email: string;
  applicantName: string;
  schoolName: string;
  status: 'APPROVED' | 'REJECTED' | 'NEEDS_INFORMATION' | string;
  requestedInformation?: string | null;
  statusUrl?: string | null;
  schoolLogo?: string | null;
}) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const normalizedStatus = String(status || 'UPDATE').toUpperCase();
    const title = normalizedStatus === 'APPROVED'
      ? 'Application Approved'
      : normalizedStatus === 'REJECTED'
        ? 'Application Update'
        : normalizedStatus === 'NEEDS_INFORMATION'
          ? 'Additional Information Needed'
          : 'Application Update';

    const introText = normalizedStatus === 'APPROVED'
      ? `Your application to <strong>${schoolName}</strong> has been approved. The admissions team will contact you with the next steps shortly.`
      : normalizedStatus === 'REJECTED'
        ? `Your application to <strong>${schoolName}</strong> has been reviewed. Please contact the school if you would like further information about the decision.`
        : normalizedStatus === 'NEEDS_INFORMATION'
          ? `The admissions team needs a little more information before they can complete your application review.`
          : `Your application to <strong>${schoolName}</strong> has been updated.`;

    const schoolLogoInline = await fetchInlineLogo(schoolLogo);
    const attachments = schoolLogoInline?.attachment ? [schoolLogoInline.attachment] : undefined;
    const textBody = [
      `${title} - ${schoolName}`,
      '',
      `Hello ${applicantName},`,
      '',
      normalizedStatus === 'APPROVED'
        ? `Your application to ${schoolName} has been approved. The admissions team will contact you with next steps.`
        : normalizedStatus === 'REJECTED'
          ? `Your application to ${schoolName} has been reviewed. Please contact the school if you need further information.`
          : normalizedStatus === 'NEEDS_INFORMATION'
            ? `${requestedInformation || 'The admissions team needs more information to continue reviewing your application.'}`
            : `Your application to ${schoolName} has an update.`,
      '',
      statusUrl ? `Check your application status here: ${statusUrl}` : '',
      '',
      `Best regards,`,
      `${schoolName} Admissions Team`,
    ].join('\n');

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: `${title} - ${schoolName}`,
      text: textBody,
      ...(attachments ? { attachments } : {}),
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                ${schoolLogoInline ? `<img src="${schoolLogoInline.src}" alt="${schoolName}" class="logo" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover;">` : `<img src="${DEFAULT_EMAIL_LOGO}" alt="SchoolBase Logo" class="logo" />`}
                <h1>${schoolName}</h1>
                <p class="header-subtitle">${title}</p>
              </div>
              <div class="content">
                <p>Hello ${applicantName},</p>
                <p>${introText}</p>

                ${normalizedStatus === 'NEEDS_INFORMATION' && requestedInformation ? `
                  <div class="info-box">
                    <p><strong>Required information:</strong></p>
                    <p>${requestedInformation}</p>
                  </div>
                ` : ''}

                ${normalizedStatus === 'NEEDS_INFORMATION' || statusUrl ? `
                  <div class="button-container">
                    <a href="${statusUrl || 'https://schoolbase.live'}" class="button">${normalizedStatus === 'NEEDS_INFORMATION' ? 'Review Your Application' : 'View Status'}</a>
                  </div>
                ` : ''}

                ${statusUrl ? `<p>Need to check progress or respond securely? Visit: <a href="${statusUrl}" style="color: ${BRAND.primary};">${statusUrl}</a></p>` : ''}

                <p>Thank you for choosing ${schoolName}. We look forward to supporting your child’s education journey.</p>
                <p>Warm regards,<br><strong>${schoolName} Admissions Team</strong></p>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
                <p class="footer-text">Questions? Contact <a href="mailto:support@schoolbase.live">support@schoolbase.live</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log(`Admission applicant status email sent to: ${email} (${normalizedStatus})`);
    return true;
  } catch (error) {
    console.error('Failed to send admission applicant status email:', error);
    throw error;
  }
}

export async function sendStudentAccessReminderEmail(
  email: string,
  guardianName: string,
  pupilName: string,
  className: string,
  admissionNo: string,
  schoolName: string,
  schoolLogo?: string,
) {
  if (!isValidEmail(email)) {
    throw new Error(`Invalid email address: ${email}`);
  }

  const parentPortalUrl = `${(process.env.FRONTEND_URL || 'https://www.schoolbase.live').replace(/\/$/, '')}/parent/login`;
  const textBody = `Parent portal access reminder\n\nHello ${guardianName},\n\nYou can access ${pupilName}'s school information on the ${schoolName} parent portal.\n\nAdmission number: ${admissionNo}\nClass: ${className}\n\nOpen ${parentPortalUrl} and enter the registered phone number and admission number to sign in. No password is required.`;
  const schoolLogoInline = await fetchInlineLogo(schoolLogo);
  const attachments = schoolLogoInline?.attachment ? [schoolLogoInline.attachment] : undefined;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
    to: email,
    subject: `Parent portal access for ${pupilName}`,
    text: textBody,
    ...(attachments ? { attachments } : {}),
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${EMAIL_STYLES}</style></head><body><div class="email-container"><div class="header">${schoolLogoInline ? `<img src="${schoolLogoInline.src}" alt="${schoolName}" class="logo" style="width:60px;height:60px;border-radius:50%;object-fit:cover;">` : ''}<h1>${schoolName}</h1><p class="header-subtitle">Parent portal access reminder</p></div><div class="content"><p>Hello ${guardianName},</p><p>Your parent portal access for <strong>${pupilName}</strong> is ready.</p><div class="info-box"><p><strong>Student:</strong> ${pupilName}</p><p><strong>Admission number:</strong> ${admissionNo}</p><p><strong>Class:</strong> ${className}</p></div><p>Use the registered phone number and the admission number to sign in. No password is required.</p><div class="button-container"><a href="${parentPortalUrl}" class="button">Open Parent Portal</a></div><p>From the portal you can view fees, results, attendance, notices, and other school updates.</p></div><div class="footer"><p class="footer-text">This message was sent by ${schoolName}.</p></div></div></body></html>`,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// TEMPLATE 8: SETUP COMPLETION REMINDER EMAIL
// ═══════════════════════════════════════════════════════════════════════════════

export function buildSetupReminderTaskSections(
  completedItems: string[] = [],
  missingItems: string[] = [],
) {
  const completedHtml = completedItems.length > 0
    ? completedItems
        .map((item) => `<p style="margin: 8px 0; color: ${BRAND.text};"><strong>✓</strong> ${item}</p>`)
        .join('')
    : `<p style="margin: 8px 0; color: ${BRAND.textMuted};">No completed setup items were detected yet.</p>`;

  const missingHtml = missingItems.length > 0
    ? missingItems
        .map((item) => `<p style="margin: 8px 0; color: ${BRAND.text};"><strong>○</strong> ${item}</p>`)
        .join('')
    : `<p style="margin: 8px 0; color: ${BRAND.primary};">Everything looks complete so far.</p>`;

  return { completedHtml, missingHtml };
}

export async function sendSetupReminderEmail(
  email: string,
  adminName: string,
  schoolName: string,
  remainingTasks: string[] = [],
  completedItems: string[] = [],
  missingItems: string[] = [],
  completionPercentage?: number,
) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const defaultTasks = [
      { task: 'Add your school staff', time: '2 min' },
      { task: 'Register students', time: '5-10 min' },
      { task: 'Set up fee structures', time: '3 min' },
      { task: 'Invite parents to the portal', time: '5 min' },
    ];

    let taskSectionHtml = '';
    const hasChecklistData = completedItems.length > 0 || missingItems.length > 0;

    if (hasChecklistData) {
      const { completedHtml, missingHtml } = buildSetupReminderTaskSections(completedItems, missingItems);
      taskSectionHtml = `
        <div style="display: grid; gap: 12px; margin: 16px 0;">
          <div style="background-color: ${BRAND.primaryLight}; padding: 14px 16px; border-radius: 6px; border: 1px solid ${BRAND.primary};">
            <h3 style="font-size: 14px; margin-bottom: 6px; color: ${BRAND.primary};">Completed setup</h3>
            ${completedHtml}
          </div>
          <div style="background-color: ${BRAND.surface}; padding: 14px 16px; border-radius: 6px; border: 1px solid ${BRAND.border};">
            <h3 style="font-size: 14px; margin-bottom: 6px; color: ${BRAND.primary};">Still missing</h3>
            ${missingHtml}
          </div>
        </div>
      `;
    } else {
      let tasksList = defaultTasks;
      if (remainingTasks.length > 0) {
        tasksList = remainingTasks.map((task, i) => ({
          task,
          time: defaultTasks[i]?.time || 'few min',
        }));
      }

      taskSectionHtml = `
        <div style="background-color: ${BRAND.primaryLight}; padding: 16px; border-radius: 4px; margin: 16px 0;">
          ${tasksList
            .map(
              (item) =>
                `<p style="margin: 8px 0;"><strong>☐</strong> ${item.task} <span style="font-size: 12px; color: ${BRAND.textMuted};">(${item.time})</span></p>`,
            )
            .join('')}
        </div>
      `;
    }

    const progressLabel = typeof completionPercentage === 'number'
      ? `<p style="margin-top: 12px;"><strong>Current progress:</strong> ${completionPercentage}% complete</p>`
      : '';

    const checklistNote = `
      <p style="margin-top: 16px; color: ${BRAND.textMuted}; font-size: 13px;">
        This reminder tracks the full 15-step onboarding checklist. A school is considered ready when the required core setup is complete, even if some optional academic setup items are still being refined.
      </p>
    `;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: `Let's Complete Your SchoolBase Setup - ${schoolName}`,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <img src="https://schoolbase.live/logo.png" alt="SchoolBase Logo" class="logo" />
                <h1>SchoolBase Setup Reminder</h1>
                <p class="header-subtitle">You're Close to Getting Everything Live</p>
              </div>
              <div class="content">
                <p>Hi ${adminName},</p>
                <p>We noticed you created your SchoolBase workspace but haven't fully set it up yet. We're here to help make it super quick and easy!</p>

                ${progressLabel}
                ${checklistNote}
                <h2 style="font-size: 16px; margin-top: 24px;">Setup status</h2>
                ${taskSectionHtml}

                <p style="margin-top: 24px;">Most schools go live in under 30 minutes. Once your setup is complete, your team can start using the portal for announcements, results, attendance, and daily communication with parents.</p>

                <div class="button-container">
                  <a href="https://schoolbase.live/admin/setup" class="button">Continue Setup</a>
                </div>

                <h2 style="font-size: 16px; margin-top: 24px;">Need Help? We Have:</h2>
                <div class="list-item">Step-by-step setup guide</div>
                <div class="list-item">Video tutorials for each feature</div>
                <div class="list-item">Live chat support (9am-5pm)</div>
                <div class="list-item">Email support</div>

                <div class="warning-box" style="background-color: ${BRAND.primaryLight}; border-left-color: ${BRAND.primary};">
                  <p style="color: ${BRAND.primary};"><strong>Your 7-day free trial is counting down.</strong> Let's get you live!</p>
                </div>

                <p style="margin-top: 32px;">Warm regards,<br><strong>The SchoolBase Team</strong></p>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
                <p class="footer-text"><a href="https://schoolbase.live/help">Help Center</a> | <a href="mailto:support@schoolbase.live">Contact Support</a></p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log('Setup reminder email sent to:', email);
    return true;
  } catch (error) {
    console.error('Failed to send setup reminder email:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLATFORM COMMUNICATION EMAIL
// ═══════════════════════════════════════════════════════════════════════════════

export async function sendPlatformCommunicationEmail(
  email: string,
  recipientName: string,
  schoolName: string,
  emailType: string,
  subject: string,
  body: string,
) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    // Split body into paragraphs by double newlines
    const paragraphs = body.split('\n\n').filter(p => p.trim());
    const bodyHtml = paragraphs
      .map(p => `<p style="margin: 16px 0; line-height: 1.6;">${p.replace(/\n/g, '<br>')}</p>`)
      .join('');

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <div style="width: 70px; height: 70px; background-color: ${BRAND.surface}; border-radius: 50%; margin: 0 auto 12px; display: flex; align-items: center; justify-content: center;">
                  <img src="https://schoolbase.live/logo.png" alt="SchoolBase Logo" style="width: 50px; height: 50px; display: block; margin: auto;">
                </div>
                <h1 style="font-size: 24px; color: ${BRAND.surface};">SchoolBase</h1>
                <p class="header-subtitle">${subject}</p>
              </div>
              <div class="content">
                <p>Hello ${recipientName},</p>
                <p style="font-size: 14px; color: ${BRAND.textMuted};">For: <strong>${schoolName}</strong></p>
                ${bodyHtml}
                <div style="margin-top: 32px; border-top: 1px solid ${BRAND.border}; padding-top: 16px;">
                  <p>Best regards,<br><strong>The SchoolBase Team</strong></p>
                  <p style="font-size: 12px; color: ${BRAND.textMuted}; margin-top: 12px;"><a href="https://schoolbase.live" style="color: ${BRAND.primary}; text-decoration: none;">Visit SchoolBase</a></p>
                </div>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log('Platform communication email sent to:', email);
    return true;
  } catch (error) {
    console.error('Failed to send platform communication email:', error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION EMAIL TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send subscription payment success email
 */
export async function sendSubscriptionPaymentSuccessEmail(
  email: string,
  schoolName: string,
  adminName: string,
  plan: string,
  amount: string,
  expiryDate: string
) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const body = `Thank you for subscribing to SchoolBase! Your payment has been successfully processed and your subscription is now active.

Subscription Details
School: ${schoolName}
Plan: ${plan}
Amount Paid: ${amount}
Expires: ${expiryDate}

Your school now has full access to all SchoolBase features including Admissions, Student Records, Attendance, Fees, Payments, Results, Report Cards, Staff Management, and WhatsApp Communication.

Next Steps
1. Log into your SchoolBase dashboard to get started
2. Configure your school settings and branding
3. Add your staff and students
4. Set up fee schedules and publish results
5. Invite parents to the portal

Our support team is here to help. If you have any questions or need assistance, just reply to this email.`;

    const paragraphs = body.split('\n\n').filter(p => p.trim());
    const bodyHtml = paragraphs
      .map(p => `<p style="margin: 16px 0; line-height: 1.6;">${p.replace(/\n/g, '<br>')}</p>`)
      .join('');

    const textBody = `${body}\n\nBest regards,\nThe SchoolBase Team`;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: `Payment Confirmed – Your SchoolBase subscription is active`,
      text: textBody,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <div style="width: 70px; height: 70px; background-color: ${BRAND.surface}; border-radius: 50%; margin: 0 auto 12px; display: flex; align-items: center; justify-content: center;">
                  <img src="https://schoolbase.live/logo.png" alt="SchoolBase Logo" style="width: 50px; height: 50px; display: block; margin: auto;">
                </div>
                <h1 style="font-size: 24px; color: ${BRAND.surface};">SchoolBase</h1>
                <p class="header-subtitle">Payment Confirmed – Your subscription is active</p>
              </div>
              <div class="content">
                <p>Hello ${adminName},</p>
                <p style="font-size: 14px; color: ${BRAND.textMuted};">For: <strong>${schoolName}</strong></p>
                ${bodyHtml}
                <div style="margin-top: 32px; border-top: 1px solid ${BRAND.border}; padding-top: 16px;">
                  <p>Best regards,<br><strong>The SchoolBase Team</strong></p>
                  <p style="font-size: 12px; color: ${BRAND.textMuted}; margin-top: 12px;"><a href="https://schoolbase.live" style="color: ${BRAND.primary}; text-decoration: none;">Visit SchoolBase</a></p>
                </div>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log('Subscription payment success email sent to:', email);
    return true;
  } catch (error) {
    console.error('Failed to send subscription payment success email:', error);
    throw error;
  }
}

/**
 * Send subscription expiry warning email
 */
export async function sendSubscriptionExpiryWarningEmail(
  email: string,
  schoolName: string,
  adminName: string,
  daysRemaining: number,
  expiryDate: string,
  plan: string
) {
  try {
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${email}`);
    }

    const subject = daysRemaining === 1 
      ? `Urgent: Your SchoolBase subscription expires tomorrow`
      : `Reminder: Your SchoolBase subscription expires in ${daysRemaining} days`;

    const body = `This is a reminder that your SchoolBase ${plan} subscription for ${schoolName} will expire on ${expiryDate} (${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining).

To ensure uninterrupted access to all SchoolBase features, please renew your subscription immediately at https://schoolbase.live/admin/subscription

About Renewal
Renewing takes less than 2 minutes. Your access will continue immediately after payment. After renewal, your subscription will be extended for another month.

If you need assistance or have questions, our support team is available 24/7. Reply to this email or contact support@schoolbase.live`;

    const paragraphs = body.split('\n\n').filter(p => p.trim());
    const bodyHtml = paragraphs
      .map(p => `<p style="margin: 16px 0; line-height: 1.6;">${p.replace(/\n/g, '<br>')}</p>`)
      .join('');

    const textBody = `${body}\n\nBest regards,\nThe SchoolBase Team`;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@schoolbase.live',
      to: email,
      subject: subject,
      text: textBody,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
          </head>
          <body>
            <div class="email-container">
              <div class="header">
                <div style="width: 70px; height: 70px; background-color: ${BRAND.surface}; border-radius: 50%; margin: 0 auto 12px; display: flex; align-items: center; justify-content: center;">
                  <img src="https://schoolbase.live/logo.png" alt="SchoolBase Logo" style="width: 50px; height: 50px; display: block; margin: auto;">
                </div>
                <h1 style="font-size: 24px; color: ${BRAND.surface};">SchoolBase</h1>
                <p class="header-subtitle">${subject}</p>
              </div>
              <div class="content">
                <p>Hello ${adminName},</p>
                <p style="font-size: 14px; color: ${BRAND.textMuted};">For: <strong>${schoolName}</strong></p>
                ${bodyHtml}
                <div style="margin-top: 32px; border-top: 1px solid ${BRAND.border}; padding-top: 16px;">
                  <p>Best regards,<br><strong>The SchoolBase Team</strong></p>
                  <p style="font-size: 12px; color: ${BRAND.textMuted}; margin-top: 12px;"><a href="https://schoolbase.live" style="color: ${BRAND.primary}; text-decoration: none;">Visit SchoolBase</a></p>
                </div>
              </div>
              <div class="footer">
                <p class="footer-text">&copy; 2026 SchoolBase. All rights reserved.</p>
              </div>
            </div>
          </body>
        </html>
      `,
    });

    console.log(`Subscription expiry warning email sent to ${email} (${daysRemaining} days remaining)`);
    return true;
  } catch (error) {
    console.error('Failed to send subscription expiry warning email:', error);
    throw error;
  }
}
