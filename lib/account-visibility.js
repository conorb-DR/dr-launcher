// Decide which discovered accounts the UI may show / launch.
//
// Policy: support accounts only by default (the sanctioned IM/SE identity); the
// advanced `showAll` toggle reveals customer-user accounts. A running session is
// NEVER hidden (keepAccountIds) — you can always see and close an active session
// even after turning the toggle back off.
//
// `a.isSupport` is the JWT `is_support` claim (a clean boolean, verified live).
// Missing/unknown isSupport is treated as non-support (hidden unless kept).
function filterByVisibility(accounts, { showAll = false, keepAccountIds } = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const keep = keepAccountIds instanceof Set ? keepAccountIds : new Set(keepAccountIds || []);
  if (showAll) return { accounts: list.slice(), hiddenNonSupport: 0 };

  const kept = [];
  let hiddenNonSupport = 0;
  for (const a of list) {
    if (a && (a.isSupport === true || keep.has(a.id))) kept.push(a);
    else hiddenNonSupport++;
  }
  return { accounts: kept, hiddenNonSupport };
}

module.exports = { filterByVisibility };
