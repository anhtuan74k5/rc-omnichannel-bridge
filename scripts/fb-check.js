/**
 * Kiểm tra cấu hình Facebook trong .env mà không in ra giá trị bí mật.
 *   npm run fb:check
 */
require('dotenv').config();

const GRAPH = 'https://graph.facebook.com/v25.0';
const token = process.env.FB_PAGE_ACCESS_TOKEN || '';
const headers = { Authorization: `Bearer ${token}` };

function report(ok, label, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  return ok;
}

async function main() {
  let allOk = true;
  const present = (name) => report(Boolean(process.env[name]), `${name} đã được đặt`);
  for (const name of ['FB_PAGE_ACCESS_TOKEN', 'FB_PAGE_ID', 'FB_VERIFY_TOKEN', 'FB_APP_SECRET']) {
    allOk = present(name) && allOk;
  }
  if (!token) process.exit(1);

  const meRes = await fetch(`${GRAPH}/me?fields=id,name`, { headers });
  const me = await meRes.json();
  if (me.error) {
    report(false, 'Page token hợp lệ', me.error.message);
    process.exit(1);
  }
  report(true, 'Page token hợp lệ', `Page "${me.name}" (${me.id})`);
  allOk = report(me.id === process.env.FB_PAGE_ID, 'FB_PAGE_ID khớp với token') && allOk;

  const dbgRes = await fetch(`${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}`, { headers });
  const dbg = ((await dbgRes.json()).data) || {};
  allOk = report(dbg.type === 'PAGE', 'Loại token', dbg.type) && allOk;
  allOk = report(
    dbg.expires_at === 0,
    'Token không hết hạn',
    dbg.expires_at ? `hết hạn ${new Date(dbg.expires_at * 1000).toISOString()}` : 'expires_at = 0'
  ) && allOk;
  allOk = report(
    (dbg.scopes || []).includes('pages_messaging'),
    'Có quyền pages_messaging',
    (dbg.scopes || []).join(', ')
  ) && allOk;

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL', err.message);
  process.exit(1);
});
