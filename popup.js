const statusEl = document.getElementById("status");
const outputEl = document.getElementById("output");

const previewBtn = document.getElementById("previewBtn");
const applyBtn = document.getElementById("applyBtn");

function setStatus(msg) {
  statusEl.textContent = msg;
}

function safeUrlToHostname(url) {
  try {
    const u = new URL(url);
    return u.hostname || "";
  } catch {
    return "";
  }
}

// Very simple “merge subdomains” rule:
// keep last 2 labels (example.com) except common multi-part TLDs.
// This is not perfect like a Public Suffix List, but good enough for most use.
function mergeSubdomains(hostname) {
  if (!hostname) return hostname;
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return hostname;

  const last2 = parts.slice(-2).join(".");
  const last3 = parts.slice(-3).join(".");

  // Small helpful list for common multi-part TLDs
  const multiTLD = new Set([
    "co.uk", "org.uk", "ac.uk",
    "com.au", "net.au", "org.au",
    "co.jp", "ne.jp", "or.jp",
    "co.kr", "or.kr",
    "co.nz", "org.nz"
  ]);

  const tail2 = parts.slice(-2).join(".");
  const tail3 = parts.slice(-3).join(".");

  // If last2 is multi-TLD like "co.uk", use last3 like "example.co.uk"
  if (multiTLD.has(tail2) && parts.length >= 3) return tail3;

  return last2;
}

function getDomainForBookmark(url, shouldMerge) {
  const host = safeUrlToHostname(url);
  if (!host) return "other";
  return shouldMerge ? mergeSubdomains(host) : host;
}

function walkBookmarks(node, pathParts, out) {
  const nextPath = node.title ? [...pathParts, node.title] : [...pathParts];

  if (node.url) {
    out.push({
      id: node.id,
      title: node.title || "(no title)",
      url: node.url,
      path: pathParts.join(" / ")
    });
  }

  if (node.children && node.children.length) {
    for (const child of node.children) {
      walkBookmarks(child, nextPath, out);
    }
  }
}

async function getAllBookmarksFlat() {
  const tree = await chrome.bookmarks.getTree();
  const flat = [];
  for (const root of tree) {
    walkBookmarks(root, [], flat);
  }
  return flat;
}

function groupBookmarks(flat, opts) {
  const groups = new Map(); // domain -> array of bookmarks
  for (const b of flat) {
    const domain = getDomainForBookmark(b.url, opts.mergeSubdomains);
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(b);
  }

  // sort domains alphabetically, and bookmarks by title inside each
  const domains = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

  const grouped = domains.map((d) => {
    const items = groups.get(d).slice().sort((x, y) => x.title.localeCompare(y.title));
    return { domain: d, items };
  });

  return grouped;
}

function makePreviewText(grouped, opts, maxDomains = 25, maxItemsPerDomain = 10) {
  const lines = [];
  lines.push(`Domains found: ${grouped.length}`);
  lines.push(`Showing up to ${maxDomains} domains, ${maxItemsPerDomain} items each`);
  lines.push("");

  for (const g of grouped.slice(0, maxDomains)) {
    lines.push(`• ${g.domain} (${g.items.length})`);
    for (const item of g.items.slice(0, maxItemsPerDomain)) {
      const path = opts.includeFolderPath && item.path ? `  [${item.path}]` : "";
      lines.push(`   - ${item.title}${path}`);
    }
    if (g.items.length > maxItemsPerDomain) {
      lines.push(`   … +${g.items.length - maxItemsPerDomain} more`);
    }
    lines.push("");
  }

  if (grouped.length > maxDomains) {
    lines.push(`… +${grouped.length - maxDomains} more domains`);
  }

  return lines.join("\n");
}

async function findOrCreateFolder(parentId, title) {
  const children = await chrome.bookmarks.getChildren(parentId);
  const existing = children.find((c) => !c.url && c.title === title);
  if (existing) return existing.id;
  const created = await chrome.bookmarks.create({ parentId, title });
  return created.id;
}

async function clearFolderChildren(folderId) {
  const kids = await chrome.bookmarks.getChildren(folderId);
  for (const k of kids) {
    await chrome.bookmarks.removeTree(k.id);
  }
}

async function applyGrouping(grouped) {
  // Put everything under "Other Bookmarks" if possible, otherwise under the first root child.
  // In Chrome bookmark tree:
  // 0 root
  // usually children include "Bookmarks bar" and "Other bookmarks" etc.
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0];

  // Try to locate "Other bookmarks" by id "2" (common), otherwise fallback
  let targetParent = root.children?.find((n) => n.title === "Other bookmarks")?.id
    || root.children?.[1]?.id
    || root.children?.[0]?.id
    || root.id;

  // Create or reuse main folder
  const mainFolderId = await findOrCreateFolder(targetParent, "Sorted by Website");

  // Clear it so re-applying is idempotent
  await clearFolderChildren(mainFolderId);

  // Create domain folders + add bookmarks
  for (const g of grouped) {
    const domainFolderId = await chrome.bookmarks.create({
      parentId: mainFolderId,
      title: g.domain
    });

    for (const item of g.items) {
      await chrome.bookmarks.create({
        parentId: domainFolderId.id,
        title: item.title,
        url: item.url
      });
    }
  }

  return mainFolderId;
}

previewBtn.addEventListener("click", async () => {
  try {
    setStatus("Scanning bookmarks…");
    outputEl.textContent = "";

    const opts = {
      mergeSubdomains: document.getElementById("mergeSubdomains").checked,
      includeFolderPath: document.getElementById("includeFolderPath").checked
    };

    const flat = await getAllBookmarksFlat();
    const grouped = groupBookmarks(flat, opts);

    outputEl.textContent = makePreviewText(grouped, opts);
    setStatus("Preview ready.");
  } catch (e) {
    console.error(e);
    setStatus("Error while previewing. Check console.");
  }
});

applyBtn.addEventListener("click", async () => {
  try {
    setStatus("Building new sorted folder…");
    outputEl.textContent = "";

    const opts = {
      mergeSubdomains: document.getElementById("mergeSubdomains").checked,
      includeFolderPath: false
    };

    const flat = await getAllBookmarksFlat();
    const grouped = groupBookmarks(flat, opts);

    const folderId = await applyGrouping(grouped);
    setStatus(`Done! Created/updated “Sorted by Website”. (folder id: ${folderId})`);
  } catch (e) {
    console.error(e);
    setStatus("Error while applying. Check console.");
  }
});
