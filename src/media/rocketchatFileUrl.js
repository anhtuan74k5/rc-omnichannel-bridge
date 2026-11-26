/**
 * Where Rocket.Chat serves uploaded files. The bridge downloads agent files with
 * the agent's credentials, so only these paths on the configured Rocket.Chat are
 * ever requested: a link to any other place is not a file of ours.
 */

const FILE_PATH = /\/(?:file-upload|ufs)\//;

/**
 * The file's path (with query) on Rocket.Chat, or null when the link is not a
 * Rocket.Chat upload. The host of an absolute link is dropped on purpose:
 * Rocket.Chat writes its public ROOT_URL there, and the caller always requests
 * ROCKETCHAT_URL instead.
 */
function rocketChatFilePath(source) {
  const value = String(source || '');
  if (!value) return null;
  let url;
  try {
    url = /^https?:\/\//i.test(value)
      ? new URL(value)
      : new URL(`/${value.replace(/^[/\\]+/, '')}`, 'http://relative.invalid');
  } catch {
    return null;
  }
  const at = url.pathname.search(FILE_PATH);
  return at < 0 ? null : `${url.pathname.slice(at)}${url.search}`;
}

module.exports = { rocketChatFilePath };
