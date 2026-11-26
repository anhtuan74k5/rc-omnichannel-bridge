/**
 * deliveryErrors.js
 * -----------------
 * Classifies a failed send to Facebook/Telegram so the bridge knows whether a
 * retry can help:
 *   transient - network, 5xx, rate limit: retry with backoff
 *   permanent - blocked user, closed 24h window, rejected content: retrying is
 *               pointless, tell the agent instead
 *   auth      - token revoked/expired: needs operator action (retried, but loud)
 *
 * @returns {{kind: 'transient'|'permanent'|'auth', reason: string}}
 */

const FACEBOOK_RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const FACEBOOK_TRANSIENT_CODES = new Set([1, 2]);
const TELEGRAM_UNREACHABLE = /chat not found|user is deactivated|bot was blocked|bot can't initiate|forbidden|have no rights/i;

function classifyFacebook(error) {
  const code = Number(error.code);
  const subcode = Number(error.subcode);
  const status = Number(error.status);

  if (code === 190) {
    return { kind: 'auth', reason: 'Page token Facebook hết hạn hoặc bị thu hồi (cần tạo token mới)' };
  }
  if (code === 10 || subcode === 2018278) {
    return { kind: 'permanent', reason: 'ngoài cửa sổ 24 giờ của Messenger, khách cần nhắn trước' };
  }
  if (code === 551 || subcode === 1545041) {
    return { kind: 'permanent', reason: 'khách không nhận được tin (đã chặn Page hoặc không khả dụng)' };
  }
  if (FACEBOOK_RATE_LIMIT_CODES.has(code)) return { kind: 'transient', reason: 'Facebook giới hạn tốc độ' };
  if (FACEBOOK_TRANSIENT_CODES.has(code) || status >= 500 || status === 429) {
    return { kind: 'transient', reason: 'Facebook tạm thời lỗi' };
  }
  if (status >= 400) {
    return { kind: 'permanent', reason: `Facebook từ chối nội dung (mã ${Number.isFinite(code) ? code : status})` };
  }
  return { kind: 'transient', reason: 'lỗi mạng khi gọi Facebook' };
}

function classifyTelegram(error) {
  const status = Number(error.status);
  const description = String(error.description || error.message || '');

  if (status === 401) return { kind: 'auth', reason: 'Telegram bot token không hợp lệ' };
  if (status === 403 || TELEGRAM_UNREACHABLE.test(description)) {
    return { kind: 'permanent', reason: 'khách đã chặn bot hoặc chat không còn tồn tại' };
  }
  if (status === 429 || status >= 500) return { kind: 'transient', reason: 'Telegram tạm thời lỗi hoặc giới hạn tốc độ' };
  if (status >= 400) return { kind: 'permanent', reason: 'Telegram từ chối nội dung' };
  return { kind: 'transient', reason: 'lỗi mạng khi gọi Telegram' };
}

// From Zalo's OA documentation; not verified against a real account.
const ZALO_AUTH_CODES = new Set([-124, -216]);
const ZALO_RATE_LIMIT_CODES = new Set([-32]);

function classifyZalo(error) {
  const code = Number(error.code);
  const status = Number(error.status);

  if (ZALO_AUTH_CODES.has(code)) return { kind: 'auth', reason: 'access token Zalo OA hết hạn hoặc không hợp lệ' };
  if (code === -230) return { kind: 'permanent', reason: 'khách không tương tác trong 7 ngày, cần khách nhắn trước' };
  if (code === -213) return { kind: 'permanent', reason: 'khách chưa quan tâm hoặc đã bỏ quan tâm OA' };
  if (ZALO_RATE_LIMIT_CODES.has(code) || status === 429 || status >= 500) {
    return { kind: 'transient', reason: 'Zalo tạm thời lỗi hoặc giới hạn tốc độ' };
  }
  if (code < 0 || status >= 400) {
    return { kind: 'permanent', reason: `Zalo từ chối nội dung (mã ${Number.isFinite(code) ? code : status})` };
  }
  return { kind: 'transient', reason: 'lỗi mạng khi gọi Zalo' };
}

function classifyDeliveryError(platform, error) {
  const err = error || {};
  if (platform === 'facebook') return classifyFacebook(err);
  if (platform === 'zalo') return classifyZalo(err);
  return classifyTelegram(err);
}

module.exports = { classifyDeliveryError };
