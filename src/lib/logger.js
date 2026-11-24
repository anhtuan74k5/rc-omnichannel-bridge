const SECRET_KEY = /^(?:x-auth-token|authorization|password|.*token.*)$/i;

function maskString(value) {
  return value
    .replace(/(\/bot)[^/?\s]+(?=\/)/gi, '$1***')
    .replace(/([?&](?:token|access_token)=)[^&\s]+/gi, '$1***')
    .replace(/(\bvisitor_)[^&\s"',})]+/gi, '$1***')
    .replace(/((?:x-auth-token|authorization|password)\s*[:=]\s*)[^,\s;}"']+/gi, '$1***')
    .replace(/(https?:\/\/[^?\s]+[?&]access_token=)[^&\s]+/gi, '$1***');
}

function mask(value) {
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? '***' : mask(item),
      ])
    );
  }
  return value;
}

function write(method, args) {
  console[method](...args.map(mask));
}

const log = {
  info: (...args) => write('log', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
};

module.exports = { log, mask };
