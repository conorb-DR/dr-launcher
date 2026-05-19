/**
 * Build the rich instruction prompt that gets copied to clipboard.
 * This is what the IM pastes into Claude Desktop to set customer context.
 */
function buildInstruction(account) {
  return [
    `Customer context (paste into Claude Desktop):`,
    `- Server: ${account.serverKey}`,
    `- Account: ${account.email}`,
    `- UI: ${account.serverHost}`,
    `- Org Domain: ${account.orgDomain}`,
    ``,
    `For every dr command, include:`,
    `--server ${account.serverKey} --account ${account.email}`,
    ``,
    `Never rely on the default dr account for this task.`,
  ].join("\n");
}

module.exports = { buildInstruction };
