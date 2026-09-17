// Bulk SMS/Email for admin's "Bulk SMS/Email" screen -- separate from the in-app
// Notification system (notification.service.js), which always fires regardless since
// it needs no configuration. Email goes through SMTP (nodemailer); SMS goes through
// Termii (a Nigerian SMS gateway, plain REST API, no SDK needed -- matches the
// existing fetch-based pattern in aiProvider.service.js). Both throw a typed
// *_NOT_CONFIGURED error when their env vars are missing, exactly like
// AI_NOT_CONFIGURED elsewhere, so routes can surface "not set up yet" instead of
// silently doing nothing or crashing.

let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }

function emailConfigured() {
  return !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function smsConfigured() {
  return !!(process.env.TERMII_API_KEY && process.env.TERMII_SENDER_ID);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendEmail(to, subject, text) {
  if (!emailConfigured()) {
    const err = new Error('Email is not configured yet (needs SMTP_HOST, SMTP_USER, SMTP_PASS).');
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }
  await getTransporter().sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
}

async function sendSms(to, message) {
  if (!smsConfigured()) {
    const err = new Error('SMS is not configured yet (needs TERMII_API_KEY, TERMII_SENDER_ID).');
    err.code = 'SMS_NOT_CONFIGURED';
    throw err;
  }
  const res = await fetch('https://api.ng.termii.com/api/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to, from: process.env.TERMII_SENDER_ID, sms: message, type: 'plain', channel: 'generic',
      api_key: process.env.TERMII_API_KEY,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'SMS send failed');
  return data;
}

module.exports = { emailConfigured, smsConfigured, sendEmail, sendSms };
