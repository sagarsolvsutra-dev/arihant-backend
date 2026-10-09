const crypto = require('crypto');

/**
 * Password reset by one-time code, emailed to the address on the account.
 *
 * The code is stored as a SHA-256 hash, never in the clear. A 6-digit code is only a million
 * possibilities, so the stored attempt counter matters as much as the expiry does: without it,
 * the ten-minute window is long enough to walk the whole space. Five wrong guesses burn the code
 * and the user has to request another.
 */

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

const hashOtp = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');

/**
 * crypto.randomInt, not Math.random: Math.random is seeded predictably enough that an attacker
 * who sees one code can narrow down the next.
 */
const createOtp = () => {
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  return {
    otp,
    otpHash: hashOtp(otp),
    expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
  };
};

/** Normalises an address the same way everywhere, so lookup and storage can never disagree. */
const normalizeEmail = (email) => String(email == null ? '' : email).toLowerCase().trim();

// Deliberately permissive: this rejects what is obviously not an address and nothing more. A
// stricter pattern turns away real addresses (plus-tags, long TLDs, apostrophes), and the only
// test that actually matters is whether the code sent to it arrives.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const isValidEmail = (email) => EMAIL_PATTERN.test(normalizeEmail(email));

/** Six digits, nothing else. Trimmed first, because people paste codes with spaces around them. */
const isValidOtp = (otp) => /^\d{6}$/.test(String(otp == null ? '' : otp).trim());

module.exports = {
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  hashOtp,
  createOtp,
  normalizeEmail,
  isValidEmail,
  isValidOtp,
  EMAIL_PATTERN,
};
