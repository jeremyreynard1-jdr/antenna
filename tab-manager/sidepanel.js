let allTabs = [];
let currentWindowId = null;
let selectedPriority = 'urgent';
let triageMode = 'this'; // 'this' or 'all'

// AI state
let aiResults = null;
let aiFilter = 'all';

// Analytics state
let analyticsRange = '7d';
let tabTarget = null;
let snoozeScope = 'tab'; // 'tab' or 'window'

// --- Smart Domain Rules ---
const SMART_DOMAIN_RULES = [
  // Google Workspace
  { match: (u) => u.hostname === 'docs.google.com' && u.pathname.startsWith('/document'), name: 'Google Docs', emoji: '\uD83D\uDCC4' },
  { match: (u) => u.hostname === 'docs.google.com' && u.pathname.startsWith('/spreadsheets'), name: 'Google Sheets', emoji: '\uD83D\uDCCA' },
  { match: (u) => u.hostname === 'docs.google.com' && u.pathname.startsWith('/presentation'), name: 'Google Slides', emoji: '\uD83D\uDCFD\uFE0F' },
  { match: (u) => u.hostname === 'docs.google.com' && u.pathname.startsWith('/forms'), name: 'Google Forms', emoji: '\uD83D\uDCCB' },
  { match: (u) => u.hostname === 'docs.google.com', name: 'Google Docs', emoji: '\uD83D\uDCC4' },
  { match: (u) => u.hostname === 'drive.google.com', name: 'Google Drive', emoji: '\uD83D\uDCC1' },
  { match: (u) => u.hostname === 'mail.google.com', name: 'Gmail', emoji: '\u2709\uFE0F' },
  { match: (u) => u.hostname === 'calendar.google.com', name: 'Google Calendar', emoji: '\uD83D\uDCC5' },
  { match: (u) => u.hostname === 'meet.google.com', name: 'Google Meet', emoji: '\uD83C\uDFA5' },
  // GitHub — group by org/repo
  { match: (u) => u.hostname === 'github.com' && u.pathname.split('/').filter(Boolean).length >= 2,
    name: (u) => { const p = u.pathname.split('/').filter(Boolean); return `GitHub: ${p[0]}/${p[1]}`; }, emoji: '\uD83D\uDC19' },
  { match: (u) => u.hostname === 'github.com', name: 'GitHub', emoji: '\uD83D\uDC19' },
  // Microsoft
  { match: (u) => u.hostname.includes('sharepoint.com'), name: 'SharePoint', emoji: '\uD83D\uDCE6' },
  { match: (u) => u.hostname === 'outlook.live.com' || u.hostname === 'outlook.office.com', name: 'Outlook', emoji: '\uD83D\uDCE7' },
  // Notion
  { match: (u) => u.hostname === 'www.notion.so' || u.hostname === 'notion.so', name: 'Notion', emoji: '\uD83D\uDCD3' },
  // Slack
  { match: (u) => u.hostname.endsWith('.slack.com') || u.hostname === 'app.slack.com', name: 'Slack', emoji: '\uD83D\uDCAC' },
  // LinkedIn
  { match: (u) => u.hostname.includes('linkedin.com'), name: 'LinkedIn', emoji: '\uD83D\uDCBC' },
  // YouTube
  { match: (u) => u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com', name: 'YouTube', emoji: '\uD83C\uDFA5' },
  // Twitter/X
  { match: (u) => u.hostname === 'twitter.com' || u.hostname === 'x.com', name: 'X (Twitter)', emoji: '\uD83D\uDCAD' },
];

function getSmartDomain(urlString) {
  try {
    const u = new URL(urlString);
    for (const rule of SMART_DOMAIN_RULES) {
      if (rule.match(u)) {
        const name = typeof rule.name === 'function' ? rule.name(u) : rule.name;
        return { key: name.toLowerCase().replace(/[^a-z0-9\/\-]/g, '-').replace(/-+/g, '-'), name, emoji: rule.emoji };
      }
    }
    const hostname = u.hostname.replace(/^www\./, '');
    return { key: hostname, name: hostname, emoji: null };
  } catch {
    return { key: 'other', name: 'Other', emoji: null };
  }
}

// DOM refs
const card = document.getElementById('current-card');
const emptyState = document.getElementById('empty-state');
const tabCount = document.getElementById('tab-count');
const windowCount = document.getElementById('window-count');
const cardTitle = card?.querySelector('.card-title');
const cardUrl = card?.querySelector('.card-url');
const faviconEl = card?.querySelector('.favicon');
const windowBadge = card?.querySelector('.card-window-badge');
const snoozeModal = document.getElementById('snooze-modal');
const actionModal = document.getElementById('action-modal');
const settingsModal = document.getElementById('settings-modal');
const analysisBanner = document.getElementById('analysis-banner');
const duplicateAlert = document.getElementById('duplicate-alert');
const suggestedAction = document.getElementById('suggested-action');
const thisTabView = document.getElementById('this-tab-view');
const allTabsView = document.getElementById('all-tabs-view');

// State
let analysis = null;
let activeTabId = null;
let currentSuggestedAction = null;

init();

async function init() {
  const [activeTab] = await new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, resolve);
  });
  if (activeTab) {
    currentWindowId = activeTab.windowId;
    activeTabId = activeTab.id;
  }

  await loadTabs();
  await runAnalysis();
  setupListeners();
  showActiveTab();

  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    activeTabId = tabId;
    currentWindowId = windowId;
    if (triageMode === 'this') {
      await refreshAndShowActiveTab();
    }
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (tabId === activeTabId && changeInfo.status === 'complete' && triageMode === 'this') {
      await refreshAndShowActiveTab();
    }
  });
}

async function refreshAndShowActiveTab() {
  const response = await msg({ action: 'getTabs' });
  if (!response || !response.tabs) return;
  allTabs = response.tabs.filter(t =>
    !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  );
  updateStats(response);
  showActiveTab();
}

async function loadTabs() {
  const response = await msg({ action: 'getTabs' });
  if (!response || !response.tabs) return;
  allTabs = response.tabs.filter(t =>
    !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  );
  updateStats(response);
}

function updateStats(response) {
  const count = (response && response.tabs) ? response.tabs.filter(t =>
    !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  ).length : allTabs.length;
  if (tabCount) tabCount.textContent = `${count} tabs`;
  if (windowCount && response) windowCount.textContent = `${response.windowCount} windows`;
}

async function runAnalysis() {
  analysis = await msg({ action: 'getAnalysis' });
  if (!analysis) return;

  if (analysis.duplicateTabCount > 0 && duplicateAlert && analysisBanner) {
    duplicateAlert.classList.remove('hidden');
    const dupCountEl = document.getElementById('dup-count');
    if (dupCountEl) dupCountEl.textContent = analysis.duplicateTabCount;
    analysisBanner.classList.remove('hidden');

    const dupList = document.getElementById('duplicate-list');
    if (dupList) {
      dupList.innerHTML = '';
      analysis.duplicates.forEach(dup => {
        const group = document.createElement('div');
        group.className = 'dup-group';
        const displayUrl = cleanUrl(dup.url);
        const titles = dup.tabs.map(t => t.title).filter((v, i, a) => a.indexOf(v) === i);
        group.innerHTML = `
          <div class="dup-url" title="${escapeHtml(dup.url)}">${escapeHtml(displayUrl)}</div>
          <div class="dup-count"><strong>${dup.count} copies</strong> open${titles.length === 1 ? ` — ${escapeHtml(titles[0])}` : ''}</div>
        `;
        dupList.appendChild(group);
      });
    }
  }
}

// --- THIS TAB view ---

function showActiveTab() {
  if (!card || triageMode !== 'this') return;

  const tab = allTabs.find(t => t.id === activeTabId);
  if (!tab) {
    card.classList.add('hidden');
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }

  card.classList.remove('hidden');
  if (emptyState) emptyState.classList.add('hidden');

  if (cardTitle) cardTitle.textContent = tab.title;
  if (cardUrl) cardUrl.textContent = cleanUrl(tab.url);

  if (faviconEl) {
    if (tab.favIconUrl) {
      faviconEl.src = tab.favIconUrl;
      faviconEl.style.display = 'block';
    } else {
      faviconEl.src = '';
      faviconEl.style.background = '#2e2e3e';
    }
  }

  const windowIds = [...new Set(allTabs.map(t => t.windowId))].sort();
  const windowNum = windowIds.indexOf(tab.windowId) + 1;
  if (windowBadge) windowBadge.textContent = `Window ${windowNum}${tab.pinned ? ' · Pinned' : ''}`;

  if (suggestedAction) suggestedAction.classList.add('hidden');
  currentSuggestedAction = null;

  loadPreview(tab);
}

async function loadPreview(tab) {
  const previewText = document.getElementById('preview-text');
  const previewLoading = document.getElementById('preview-loading');
  if (!previewText || !previewLoading) return;

  previewText.innerHTML = '';
  previewLoading.classList.remove('hidden');
  previewLoading.textContent = 'Reading page...';

  const pageInfo = await msg({ action: 'getPageInfo', tabId: tab.id });
  previewLoading.classList.add('hidden');

  if (!pageInfo) {
    previewText.innerHTML = '<span style="color:#52525b">No preview available</span>';
    return;
  }

  let html = '';
  if (pageInfo.isJobPosting) {
    html += '<span class="preview-badge job">Job Posting</span> ';
  } else if (pageInfo.ogType === 'article') {
    html += '<span class="preview-badge article">Article</span> ';
  }

  if (pageInfo.description) {
    html += escapeHtml(pageInfo.description);
  } else {
    html += '<span style="color:#52525b">No preview available</span>';
  }

  previewText.innerHTML = html;
}

// Summarize button: call AI for a rich summary + suggested action
async function summarizeCurrentTab() {
  const tab = allTabs.find(t => t.id === activeTabId);
  if (!tab) return;

  const keyData = await msg({ action: 'getApiKey' });
  if (!keyData || !keyData.apiKey) {
    showSettingsModal();
    return;
  }

  const previewText = document.getElementById('preview-text');
  const previewLoading = document.getElementById('preview-loading');
  if (previewLoading) {
    previewLoading.textContent = 'AI is analyzing...';
    previewLoading.classList.remove('hidden');
  }

  const aiSummary = await msg({ action: 'aiSummarizeTab', tabId: tab.id, apiKey: keyData.apiKey });

  if (tab.id !== activeTabId) return; // Tab changed

  if (previewLoading) previewLoading.classList.add('hidden');

  if (!aiSummary) return;

  if (aiSummary.summary && previewText) {
    previewText.innerHTML = escapeHtml(aiSummary.summary);
  }

  // Show suggested action chip
  if (aiSummary.suggestedAction && suggestedAction) {
    currentSuggestedAction = aiSummary.suggestedAction;
    const iconEl = suggestedAction.querySelector('.suggested-icon');
    const labelEl = suggestedAction.querySelector('.suggested-label');

    const actionConfig = {
      close:  { icon: '&#x2715;', label: aiSummary.actionLabel || 'Close this tab', color: 'close' },
      action: { icon: '!', label: aiSummary.actionLabel || 'Add to action queue', color: 'action' },
      claude: { icon: '&#x2728;', label: aiSummary.actionLabel || 'Needs deeper analysis', color: 'claude' },
      snooze: { icon: '&#x25F7;', label: aiSummary.actionLabel || 'Snooze for later', color: 'snooze' },
      keep:   { icon: '&#x2713;', label: aiSummary.actionLabel || 'Keep this tab open', color: 'keep' },
    };

    const config = actionConfig[aiSummary.suggestedAction] || actionConfig.keep;
    if (iconEl) iconEl.innerHTML = config.icon;
    if (labelEl) labelEl.textContent = config.label;
    suggestedAction.className = `suggested-action ${config.color}`;
    suggestedAction.classList.remove('hidden');
  }
}

// --- ALL TABS view (domain-grouped) ---

async function renderAllTabs() {
  const container = document.getElementById('domain-groups');
  if (!container) return;
  container.innerHTML = '';

  // Load category rules
  let categoryRules = {};
  try { categoryRules = await msg({ action: 'getCategoryRules' }) || {}; } catch {}

  // 1. Group tabs by smart domain
  const domainMap = {};
  allTabs.forEach(tab => {
    const smart = getSmartDomain(tab.url);
    if (!domainMap[smart.key]) domainMap[smart.key] = { name: smart.name, emoji: smart.emoji, tabs: [] };
    domainMap[smart.key].tabs.push(tab);
  });

  // 2. Compute global duplicate count for the toolbar button
  const globalUrlCounts = {};
  allTabs.forEach(t => { const k = cleanUrl(t.url); globalUrlCounts[k] = (globalUrlCounts[k] || 0) + 1; });
  const globalDupCount = Object.values(globalUrlCounts).reduce((s, c) => s + Math.max(c - 1, 0), 0);
  const dedupAllBtn = document.getElementById('dedup-all-btn');
  const dedupAllCount = document.getElementById('dedup-all-count');
  if (dedupAllBtn) {
    dedupAllBtn.style.display = globalDupCount > 0 ? '' : 'none';
    if (dedupAllCount) dedupAllCount.textContent = globalDupCount > 0 ? `(${globalDupCount})` : '';
  }

  // 3. Group domains by category
  const CATEGORY_ORDER = ['work', 'job-search', 'productivity', 'learning', 'finance', 'social', 'email', 'news', 'entertainment', 'shopping', 'reference', 'other'];
  const CATEGORY_EMOJIS = {
    'work': '\uD83D\uDCBC', 'job-search': '\uD83D\uDD0D', 'productivity': '\u26A1',
    'learning': '\uD83D\uDCDA', 'finance': '\uD83D\uDCB0', 'social': '\uD83D\uDC65',
    'email': '\u2709\uFE0F', 'news': '\uD83D\uDCF0', 'entertainment': '\uD83C\uDFAC',
    'shopping': '\uD83D\uDED2', 'reference': '\uD83D\uDCD6', 'other': '\uD83D\uDCCC'
  };

  const catGroups = {}; // { category: [{domainKey, name, emoji, tabs}] }
  Object.entries(domainMap).forEach(([domainKey, entry]) => {
    const rule = categoryRules[domainKey];
    const cat = rule?.category || 'unsorted';
    if (!catGroups[cat]) catGroups[cat] = [];
    catGroups[cat].push({ domainKey, ...entry });
  });

  // 4. Render each category section
  const orderedCats = CATEGORY_ORDER.filter(c => catGroups[c]);
  // Add unsorted at the end
  if (catGroups['unsorted']) orderedCats.push('unsorted');

  orderedCats.forEach(cat => {
    const domains = catGroups[cat];
    const catTabCount = domains.reduce((s, d) => s + d.tabs.length, 0);
    const catEmoji = CATEGORY_EMOJIS[cat] || '\uD83D\uDCC1';
    const catLabel = cat === 'unsorted' ? 'Unsorted' : formatCategory(cat);

    const section = document.createElement('div');
    section.className = 'cat-section expanded';
    section.dataset.category = cat;

    // Category header — acts as a drop zone for dragged domains
    const catHeader = document.createElement('div');
    catHeader.className = `cat-header cat-${cat}`;
    catHeader.innerHTML = `
      <span class="cat-chevron">\u25BC</span>
      <span class="cat-emoji">${catEmoji}</span>
      <span class="cat-label">${catLabel}</span>
      <span class="cat-count">${catTabCount}</span>
    `;
    catHeader.addEventListener('click', () => section.classList.toggle('expanded'));

    // Make category header a drop target for domain drags
    catHeader.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; catHeader.classList.add('cat-drop-active'); });
    catHeader.addEventListener('dragleave', () => catHeader.classList.remove('cat-drop-active'));
    catHeader.addEventListener('drop', async (e) => {
      e.preventDefault();
      catHeader.classList.remove('cat-drop-active');
      let data;
      try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (cat === 'unsorted') return; // Can't assign to unsorted
      await msg({ action: 'saveCategoryRule', domainKey: data.domainKey, category: cat, source: 'user' });
      // Also create Chrome tab group
      const tabIds = data.tabIds || (data.tabId ? [data.tabId] : []);
      if (tabIds.length > 0) {
        const byWindow = {};
        allTabs.filter(t => tabIds.includes(t.id)).forEach(t => {
          if (!byWindow[t.windowId]) byWindow[t.windowId] = { category: cat, windowId: t.windowId, tabIds: [] };
          byWindow[t.windowId].tabIds.push(t.id);
        });
        await msg({ action: 'groupTabsInBrowser', groups: Object.values(byWindow) });
      }
      catHeader.classList.add('cat-drop-success');
      setTimeout(() => catHeader.classList.remove('cat-drop-success'), 600);
      renderAllTabs();
    });

    const catBody = document.createElement('div');
    catBody.className = 'cat-body';

    // Sort domains within category by tab count
    domains.sort((a, b) => b.tabs.length - a.tabs.length);

    domains.forEach(({ domainKey, name, emoji, tabs }) => {
      const group = document.createElement('div');
      group.className = 'domain-group';
      group.dataset.domainKey = domainKey;

      const firstFavicon = tabs.find(t => t.favIconUrl)?.favIconUrl || '';

      // Detect duplicates within this domain
      const urlCounts = {};
      tabs.forEach(t => { const nUrl = cleanUrl(t.url); urlCounts[nUrl] = (urlCounts[nUrl] || 0) + 1; });
      const dupCount = Object.values(urlCounts).reduce((s, c) => s + Math.max(c - 1, 0), 0);

      const header = document.createElement('div');
      header.className = 'domain-header';
      header.setAttribute('draggable', 'true');
      header.innerHTML = `
        <span class="domain-chevron">&#x25B6;</span>
        ${firstFavicon ? `<img class="domain-favicon" src="${firstFavicon}" alt="">` : '<div class="domain-favicon"></div>'}
        <span class="domain-name">${emoji ? emoji + ' ' : ''}${escapeHtml(name)}</span>
        <span class="domain-count">${tabs.length}</span>
        ${dupCount > 0 ? `<button class="domain-dedup" title="Show ${dupCount} duplicate${dupCount > 1 ? 's' : ''}">Dupes ${dupCount}</button>` : ''}
        <button class="domain-close-all" title="Close all">Close all</button>
      `;

      // Toggle expand/collapse
      header.addEventListener('click', (e) => {
        if (e.target.closest('.domain-close-all') || e.target.closest('.domain-dedup')) return;
        group.classList.toggle('expanded');
      });

      // Domain drag — to reassign to a different category
      header.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'group', domainKey, tabIds: tabs.map(t => t.id) }));
        e.dataTransfer.effectAllowed = 'move';
        header.classList.add('dragging');
      });
      header.addEventListener('dragend', () => header.classList.remove('dragging'));

      // Close all
      header.querySelector('.domain-close-all').addEventListener('click', async (e) => {
        e.stopPropagation();
        const tabIds = tabs.map(t => t.id);
        await msg({ action: 'closeTabs', tabIds });
        await msg({ action: 'trackAction', actionType: 'closed', count: tabIds.length });
        allTabs = allTabs.filter(t => !tabIds.includes(t.id));
        group.remove();
        updateDomainGroupCounts();
      });

      // Dedup: SHOW duplicates first, then allow closing
      const dedupBtn = header.querySelector('.domain-dedup');
      if (dedupBtn) {
        dedupBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          // Expand the group and highlight duplicates
          group.classList.add('expanded');
          showDuplicatesInGroup(group, tabs);
        });
      }

      const tabsContainer = document.createElement('div');
      tabsContainer.className = 'domain-tabs';

      tabs.forEach(tab => {
        const isDup = urlCounts[cleanUrl(tab.url)] > 1;
        const tabEl = document.createElement('div');
        tabEl.className = 'domain-tab' + (isDup ? ' is-duplicate' : '');
        tabEl.setAttribute('draggable', 'true');
        tabEl.dataset.tabId = tab.id;
        tabEl.dataset.domainKey = domainKey;
        tabEl.innerHTML = `
          <span class="domain-tab-title" title="${escapeHtml(tab.title)}">${escapeHtml(tab.title)}</span>
          ${isDup ? '<span class="dup-tag">Duplicate</span>' : ''}
          <div class="domain-tab-actions">
            <button class="domain-tab-btn dt-action" title="Add to actions">!</button>
            <button class="domain-tab-btn dt-close" title="Close">&#x2715;</button>
          </div>
        `;

        tabEl.addEventListener('dragstart', (e) => {
          e.stopPropagation();
          e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'tab', tabId: tab.id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl, domainKey }));
          e.dataTransfer.effectAllowed = 'move';
          tabEl.classList.add('dragging');
        });
        tabEl.addEventListener('dragend', () => tabEl.classList.remove('dragging'));

        tabEl.querySelector('.domain-tab-title').addEventListener('click', () => {
          msg({ action: 'focusTab', tabId: tab.id, windowId: tab.windowId });
        });

        tabEl.querySelector('.dt-close').addEventListener('click', async () => {
          await msg({ action: 'closeTab', tabId: tab.id });
          await msg({ action: 'trackAction', actionType: 'closed' });
          allTabs = allTabs.filter(t => t.id !== tab.id);
          tabEl.remove();
          const remaining = tabsContainer.querySelectorAll('.domain-tab').length;
          header.querySelector('.domain-count').textContent = remaining;
          if (remaining === 0) group.remove();
          updateDomainGroupCounts();
        });

        tabEl.querySelector('.dt-action').addEventListener('click', async () => {
          await msg({ action: 'queueAction', tab: { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl }, priority: 'this-week', note: '' });
          await msg({ action: 'trackAction', actionType: 'actioned' });
          const btn = tabEl.querySelector('.dt-action');
          btn.textContent = '\u2713';
          btn.style.color = '#22c55e';
        });

        tabsContainer.appendChild(tabEl);
      });

      group.appendChild(header);
      group.appendChild(tabsContainer);
      catBody.appendChild(group);
    });

    section.appendChild(catHeader);
    section.appendChild(catBody);
    container.appendChild(section);
  });
}

function showDuplicatesInGroup(group, tabs) {
  // Remove any existing dedup banner
  const existing = group.querySelector('.dedup-banner');
  if (existing) { existing.remove(); return; }

  // Find which URLs are duplicated
  const urlCounts = {};
  tabs.forEach(t => { const k = cleanUrl(t.url); urlCounts[k] = (urlCounts[k] || 0) + 1; });
  const dupUrls = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const idsToClose = [];
  const seen = {};
  tabs.forEach(t => {
    const k = cleanUrl(t.url);
    if (urlCounts[k] > 1) {
      if (seen[k]) idsToClose.push(t.id);
      else seen[k] = true;
    }
  });

  const banner = document.createElement('div');
  banner.className = 'dedup-banner';
  banner.innerHTML = `
    <div class="dedup-info">
      <strong>${idsToClose.length} duplicate${idsToClose.length !== 1 ? 's' : ''}</strong> across ${dupUrls.length} URL${dupUrls.length !== 1 ? 's' : ''}
    </div>
    <div class="dedup-actions">
      <button class="dedup-close-btn">Close ${idsToClose.length} extras</button>
      <button class="dedup-dismiss-btn">Dismiss</button>
    </div>
  `;

  // Highlight duplicates
  group.querySelectorAll('.domain-tab').forEach(el => {
    if (idsToClose.includes(parseInt(el.dataset.tabId))) {
      el.classList.add('dup-highlight');
    }
  });

  banner.querySelector('.dedup-close-btn').addEventListener('click', async () => {
    await msg({ action: 'closeTabs', tabIds: idsToClose });
    await msg({ action: 'trackAction', actionType: 'closed', count: idsToClose.length });
    allTabs = allTabs.filter(t => !idsToClose.includes(t.id));
    updateDomainGroupCounts();
    renderAllTabs();
  });

  banner.querySelector('.dedup-dismiss-btn').addEventListener('click', () => {
    banner.remove();
    group.querySelectorAll('.dup-highlight').forEach(el => el.classList.remove('dup-highlight'));
  });

  // Insert banner after header, before tabs
  const tabsContainer = group.querySelector('.domain-tabs');
  if (tabsContainer) group.insertBefore(banner, tabsContainer);
}

function updateDomainGroupCounts() {
  if (tabCount) tabCount.textContent = `${allTabs.length} tabs`;
  // Update category section counts
  document.querySelectorAll('.cat-section').forEach(section => {
    const count = section.querySelectorAll('.domain-tab').length;
    const countEl = section.querySelector('.cat-count');
    if (countEl) countEl.textContent = count;
    if (count === 0) section.remove();
  });
}

// --- Global dedup ---

async function dedupAllTabs() {
  const seen = {};
  const idsToClose = [];
  allTabs.forEach(t => {
    const k = cleanUrl(t.url);
    if (seen[k]) idsToClose.push(t.id);
    else seen[k] = true;
  });
  if (idsToClose.length === 0) return;
  await msg({ action: 'closeTabs', tabIds: idsToClose });
  await msg({ action: 'trackAction', actionType: 'closed', count: idsToClose.length });
  // Track duplicate closes specifically
  await msg({ action: 'trackAction', actionType: 'deduped', count: idsToClose.length });
  allTabs = allTabs.filter(t => !idsToClose.includes(t.id));
  updateDomainGroupCounts();
  renderAllTabs();
}

// --- Group in Browser ---

async function groupInBrowser() {
  const rules = await msg({ action: 'getCategoryRules' }) || {};
  const groups = {};
  allTabs.forEach(tab => {
    const dk = getSmartDomain(tab.url).key;
    const rule = rules[dk];
    const category = rule?.category || 'other';
    if (!groups[category]) groups[category] = [];
    groups[category].push({ id: tab.id, windowId: tab.windowId });
  });
  // Partition by window (Chrome requires same-window grouping)
  const byWindow = {};
  Object.entries(groups).forEach(([category, tabs]) => {
    tabs.forEach(t => {
      const wKey = `${t.windowId}-${category}`;
      if (!byWindow[wKey]) byWindow[wKey] = { category, windowId: t.windowId, tabIds: [] };
      byWindow[wKey].tabIds.push(t.id);
    });
  });
  await msg({ action: 'groupTabsInBrowser', groups: Object.values(byWindow) });
}

// --- Mode switching ---

function switchMode(mode) {
  triageMode = mode;
  if (thisTabView) thisTabView.classList.toggle('hidden', mode !== 'this');
  if (allTabsView) allTabsView.classList.toggle('hidden', mode !== 'all');

  if (mode === 'this') {
    showActiveTab();
  } else {
    renderAllTabs();
  }
}

// --- Actions on current tab ---

function closeTab() {
  const tab = allTabs.find(t => t.id === activeTabId);
  if (!tab) return;
  animateCard('left', async () => {
    await msg({ action: 'closeTab', tabId: tab.id });
    msg({ action: 'trackAction', actionType: 'closed' });
    allTabs = allTabs.filter(t => t.id !== tab.id);
    if (tabCount) tabCount.textContent = `${allTabs.length} tabs`;
  });
}

function showActionModal() {
  if (actionModal) actionModal.classList.remove('hidden');
  const noteField = document.getElementById('action-note');
  if (noteField) { noteField.value = ''; noteField.focus(); }
}

function confirmAction() {
  if (actionModal) actionModal.classList.add('hidden');
  const tab = allTabs.find(t => t.id === activeTabId);
  if (!tab) return;
  const note = document.getElementById('action-note')?.value || '';

  animateCard('up', async () => {
    await msg({
      action: 'queueAction',
      tab: { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl },
      priority: selectedPriority,
      note
    });
    msg({ action: 'trackAction', actionType: 'actioned' });
    showActiveTab();
  });
}

function showSnoozeModal() {
  // Reset scope to "tab" each time modal opens
  snoozeScope = 'tab';
  document.querySelectorAll('.scope-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.scope === 'tab');
  });
  if (snoozeModal) snoozeModal.classList.remove('hidden');
}

function snoozeTab(minutes) {
  if (snoozeModal) snoozeModal.classList.add('hidden');

  if (snoozeScope === 'window') {
    // Window snooze
    snoozeCurrentWindow(minutes);
    return;
  }

  const tab = allTabs.find(t => t.id === activeTabId);
  if (!tab) return;
  animateCard('up', async () => {
    await msg({ action: 'snoozeTab', tabId: tab.id, url: tab.url, title: tab.title, minutes });
    msg({ action: 'trackAction', actionType: 'snoozed' });
    allTabs = allTabs.filter(t => t.id !== tab.id);
    if (tabCount) tabCount.textContent = `${allTabs.length} tabs`;
  });
}

async function snoozeCurrentWindow(minutes) {
  if (!currentWindowId) return;
  const result = await msg({ action: 'snoozeWindow', windowId: currentWindowId, minutes });
  if (result && result.success) {
    msg({ action: 'trackAction', actionType: 'snoozed', count: result.count });
    // Reload tabs since window was closed
    await loadTabs();
    showActiveTab();
  }
}

function executeSuggestedAction() {
  if (!currentSuggestedAction) return;
  switch (currentSuggestedAction) {
    case 'close': closeTab(); break;
    case 'action': showActionModal(); break;
    case 'snooze': showSnoozeModal(); break;
    case 'keep': break;
    case 'claude': summarizeCurrentTab(); break;
  }
}

function animateCard(direction, callback) {
  if (!card) { callback(); return; }
  card.classList.add(`swipe-${direction}`);
  setTimeout(() => {
    card.classList.remove(`swipe-${direction}`);
    callback();
  }, 280);
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
}

// --- Analysis actions ---

async function closeDuplicates() {
  if (!analysis) return;
  const idsToClose = [];
  analysis.duplicates.forEach(dup => {
    dup.tabs.slice(1).forEach(t => idsToClose.push(t.id));
  });
  if (idsToClose.length === 0) return;

  await msg({ action: 'closeTabs', tabIds: idsToClose });
  allTabs = allTabs.filter(t => !idsToClose.includes(t.id));
  if (duplicateAlert) duplicateAlert.classList.add('hidden');
  if (analysisBanner) analysisBanner.classList.add('hidden');
  if (tabCount) tabCount.textContent = `${allTabs.length} tabs`;
  showActiveTab();
}

// --- AI Sort ---

async function runAiAnalysis() {
  const aiStart = document.getElementById('ai-start');
  const aiLoading = document.getElementById('ai-loading');
  const aiError = document.getElementById('ai-error');
  const aiResultsDiv = document.getElementById('ai-results');

  const keyData = await msg({ action: 'getApiKey' });
  if (!keyData || !keyData.apiKey) {
    showSettingsModal();
    return;
  }

  if (aiStart) aiStart.classList.add('hidden');
  if (aiError) aiError.classList.add('hidden');
  if (aiResultsDiv) aiResultsDiv.classList.add('hidden');
  if (aiLoading) aiLoading.classList.remove('hidden');

  try {
    aiResults = await msg({ action: 'aiAnalyze', apiKey: keyData.apiKey });
    if (aiResults.error) throw new Error(aiResults.error);
    if (aiLoading) aiLoading.classList.add('hidden');
    renderAiResults();
  } catch (err) {
    if (aiLoading) aiLoading.classList.add('hidden');
    if (aiError) aiError.classList.remove('hidden');
    const errorText = document.getElementById('ai-error-text');
    if (errorText) errorText.textContent = err.message || 'Something went wrong';
  }
}

function renderAiResults() {
  const aiResultsDiv = document.getElementById('ai-results');
  if (!aiResultsDiv || !aiResults) return;
  aiResultsDiv.classList.remove('hidden');

  const { summary } = aiResults;
  const setStatNum = (id, val) => {
    const el = document.querySelector(`#${id} .ai-stat-num`);
    if (el) el.textContent = val;
  };
  setStatNum('ai-stat-close', summary.close);
  setStatNum('ai-stat-keep', summary.keep);
  setStatNum('ai-stat-action', summary.action);
  setStatNum('ai-stat-snooze', summary.snooze);

  const batchCount = document.querySelector('#ai-close-all .batch-count');
  if (batchCount) batchCount.textContent = summary.close;

  renderAiTabList();
}

function renderAiTabList() {
  const list = document.getElementById('ai-tab-list');
  if (!list || !aiResults) return;
  list.innerHTML = '';

  let tabs = aiResults.analyzed;
  if (aiFilter !== 'all') {
    tabs = tabs.filter(t => t.ai.action === aiFilter);
  }

  const actionOrder = { action: 0, close: 1, snooze: 2, keep: 3 };
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  tabs.sort((a, b) => {
    const ao = actionOrder[a.ai.action] ?? 9;
    const bo = actionOrder[b.ai.action] ?? 9;
    if (ao !== bo) return ao - bo;
    return (priorityOrder[a.ai.priority] ?? 9) - (priorityOrder[b.ai.priority] ?? 9);
  });

  if (tabs.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:24px;color:#52525b">No tabs in this category</div>';
    return;
  }

  tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = `ai-tab-item${tab._closed ? ' closed' : ''}`;
    const catLabel = formatCategory(tab.ai.category);

    el.innerHTML = `
      <img class="ai-tab-favicon" src="${tab.favIconUrl || ''}" alt="">
      <div class="ai-tab-info">
        <div class="ai-tab-title" title="${escapeHtml(tab.title)}">${escapeHtml(tab.title)}</div>
        <div class="ai-tab-meta">
          <span class="ai-action-badge ${tab.ai.action}">${tab.ai.action}</span>
          <span class="ai-category-badge">${catLabel}</span>
          <span class="ai-tab-reason">${escapeHtml(tab.ai.reason)}</span>
        </div>
      </div>
      <div class="ai-tab-actions">
        <button class="ai-tab-action-btn focus-one" title="Go to tab">&#8599;</button>
        <button class="ai-tab-action-btn close-one" title="Close tab">&#x2715;</button>
      </div>
    `;

    el.querySelector('.focus-one').addEventListener('click', (e) => {
      e.stopPropagation();
      msg({ action: 'focusTab', tabId: tab.id, windowId: tab.windowId });
    });

    el.querySelector('.close-one').addEventListener('click', async (e) => {
      e.stopPropagation();
      await msg({ action: 'closeTab', tabId: tab.id });
      el.classList.add('closed');
      tab._closed = true;
      updateBatchCount();
      updateHeaderTabCount();
    });

    el.querySelector('.ai-tab-title').addEventListener('click', () => {
      msg({ action: 'focusTab', tabId: tab.id, windowId: tab.windowId });
    });

    list.appendChild(el);
  });
}

function updateBatchCount() {
  if (!aiResults) return;
  const toClose = aiResults.analyzed.filter(t => t.ai.action === 'close' && !t._closed);
  const batchCount = document.querySelector('#ai-close-all .batch-count');
  if (batchCount) batchCount.textContent = toClose.length;
}

async function updateHeaderTabCount() {
  const response = await msg({ action: 'getTabs' });
  if (response) updateStats(response);
}

async function closeAllAiSuggested() {
  if (!aiResults) return;
  const toClose = aiResults.analyzed.filter(t => t.ai.action === 'close' && !t._closed);
  if (toClose.length === 0) return;
  await msg({ action: 'closeTabs', tabIds: toClose.map(t => t.id) });
  toClose.forEach(t => t._closed = true);
  renderAiTabList();
  updateBatchCount();
  updateHeaderTabCount();
}

function formatCategory(cat) {
  const map = {
    'job-search': 'Job Search', 'work': 'Work', 'productivity': 'Productivity',
    'reference': 'Reference', 'learning': 'Learning', 'social': 'Social',
    'shopping': 'Shopping', 'entertainment': 'Entertainment', 'email': 'Email',
    'news': 'News', 'finance': 'Finance', 'other': 'Other'
  };
  return map[cat] || cat;
}

// --- Analytics Dashboard ---

async function renderAnalyticsDashboard(range) {
  if (range) analyticsRange = range;
  const [analytics, targetData] = await Promise.all([
    msg({ action: 'getAnalytics' }),
    msg({ action: 'getTabTarget' })
  ]);
  if (!analytics) return;
  tabTarget = targetData?.target || null;
  const snapshots = filterByRange(analytics.snapshots || [], analyticsRange);

  // Summary cards — "less is more" framing
  const currentTabs = allTabs.length;
  const bestTabs = snapshots.length > 0 ? Math.min(...snapshots.map(s => s.tabCount)) : currentTabs;
  const avgTabs = snapshots.length > 0 ? Math.round(snapshots.reduce((s, snap) => s + snap.tabCount, 0) / snapshots.length) : currentTabs;
  const totalClosed = snapshots.reduce((sum, s) => sum + (s.actions?.closed || 0), 0);

  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setVal('a-current-tabs', currentTabs);
  setVal('a-best-tabs', Math.min(bestTabs, currentTabs));
  setVal('a-avg-tabs', avgTabs);
  setVal('a-total-closed', totalClosed);

  // Color-code current card based on target
  const currentCard = document.getElementById('card-current');
  if (currentCard) {
    currentCard.classList.remove('under', 'near', 'over');
    if (tabTarget) {
      if (currentTabs <= tabTarget) currentCard.classList.add('under');
      else if (currentTabs <= tabTarget * 1.25) currentCard.classList.add('near');
      else currentCard.classList.add('over');
    }
  }

  // Streak + Target hero
  renderStreakHero(snapshots, currentTabs);

  // Tab count line chart — with target line
  drawLineChart('chart-tab-count', snapshots.map(s => ({ t: s.timestamp, v: s.tabCount })), {
    color: '#8b5cf6', label: 'Tabs', currentValue: currentTabs,
    targetLine: tabTarget
  });

  // Window count line chart
  drawLineChart('chart-window-count', snapshots.map(s => ({ t: s.timestamp, v: s.windowCount || 0 })), {
    color: '#3b82f6', label: 'Windows'
  });

  // Category donut
  const latestWithCats = [...snapshots].reverse().find(s => s.categories);
  if (latestWithCats?.categories) {
    drawDonutChart('chart-categories', latestWithCats.categories);
  } else {
    const canvas = document.getElementById('chart-categories');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#52525b';
      ctx.font = '13px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Run AI Sort to see categories', canvas.width / 2, canvas.height / 2);
    }
  }

  // Top domains bar chart
  renderDomainBars(snapshots);

  // Actions stacked bar
  drawActionsChart('chart-actions', snapshots);

  // Duplicates line chart
  drawLineChart('chart-duplicates', snapshots.filter(s => s.duplicateCount !== undefined).map(s => ({ t: s.timestamp, v: s.duplicateCount })), {
    color: '#f59e0b', label: 'Duplicates',
    currentValue: globalDuplicateCount()
  });
}

function renderStreakHero(snapshots, currentTabs) {
  const streakNum = document.getElementById('streak-number');
  const streakLabel = document.getElementById('streak-label');
  const streakDisplay = document.getElementById('streak-display');
  const statusText = document.getElementById('target-status-text');
  const barFill = document.getElementById('target-bar-fill');
  const barMarker = document.getElementById('target-bar-marker');
  const targetCurrent = document.getElementById('target-current');
  const targetGoal = document.getElementById('target-goal');
  const editBtn = document.getElementById('edit-target-btn');
  const barWrap = document.getElementById('target-bar-wrap');

  if (!tabTarget) {
    // No target set
    if (streakNum) streakNum.textContent = '-';
    if (streakLabel) streakLabel.textContent = 'no goal set';
    if (streakDisplay) streakDisplay.classList.add('no-streak');
    if (statusText) { statusText.textContent = 'Set a tab goal to start'; statusText.className = ''; }
    if (barWrap) barWrap.style.display = 'none';
    if (targetCurrent) targetCurrent.textContent = currentTabs;
    if (targetGoal) targetGoal.parentElement.style.display = 'none';
    if (editBtn) editBtn.textContent = 'Set goal';
    return;
  }

  if (barWrap) barWrap.style.display = '';
  if (targetGoal) { targetGoal.textContent = tabTarget; targetGoal.parentElement.style.display = ''; }
  if (targetCurrent) targetCurrent.textContent = currentTabs;
  if (editBtn) editBtn.textContent = 'Edit goal';

  // Compute streak: consecutive days where min tab count was under target
  const streak = computeStreak(snapshots, tabTarget, currentTabs);
  if (streakNum) streakNum.textContent = streak;
  if (streakDisplay) streakDisplay.classList.toggle('no-streak', streak === 0);

  if (streak === 1) {
    if (streakLabel) streakLabel.textContent = 'day streak';
  } else {
    if (streakLabel) streakLabel.textContent = streak === 0 ? 'no streak' : 'day streak';
  }

  // Target status
  const pct = Math.min((currentTabs / tabTarget) * 100, 150);
  const diff = currentTabs - tabTarget;
  let status, cls;
  if (diff <= 0) {
    status = diff === 0 ? 'Right at your goal!' : `${Math.abs(diff)} under your goal`;
    cls = 'under';
  } else if (diff <= tabTarget * 0.25) {
    status = `${diff} over — almost there!`;
    cls = 'near';
  } else {
    status = `${diff} over your goal`;
    cls = 'over';
  }

  if (statusText) { statusText.textContent = status; statusText.className = cls; }
  if (barFill) {
    barFill.style.width = `${Math.min(pct, 100)}%`;
    barFill.className = cls;
  }
  if (barMarker) barMarker.style.left = `${Math.min(100, (tabTarget / Math.max(currentTabs, tabTarget)) * 100)}%`;
}

function computeStreak(snapshots, target, currentTabs) {
  if (!target) return 0;

  // Group snapshots by day, find min tab count per day
  const dayMins = {};
  snapshots.forEach(s => {
    const day = new Date(s.timestamp).toISOString().slice(0, 10);
    if (!dayMins[day] || s.tabCount < dayMins[day]) dayMins[day] = s.tabCount;
  });

  // Include today based on current count
  const today = new Date().toISOString().slice(0, 10);
  if (!dayMins[today] || currentTabs < dayMins[today]) dayMins[today] = currentTabs;

  // Walk backwards from today counting consecutive days under target
  let streak = 0;
  const d = new Date();
  for (let i = 0; i < 365; i++) {
    const dayStr = d.toISOString().slice(0, 10);
    const minCount = dayMins[dayStr];
    if (minCount !== undefined && minCount <= target) {
      streak++;
    } else if (minCount !== undefined && minCount > target) {
      break;
    } else {
      // No data for this day — break if not today
      if (i > 0) break;
    }
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function globalDuplicateCount() {
  const urlCounts = {};
  allTabs.forEach(t => { const k = cleanUrl(t.url); urlCounts[k] = (urlCounts[k] || 0) + 1; });
  return Object.values(urlCounts).reduce((s, c) => s + Math.max(c - 1, 0), 0);
}

function filterByRange(snapshots, range) {
  const now = Date.now();
  const ranges = { '7d': 7 * 86400000, '30d': 30 * 86400000, 'all': Infinity };
  const cutoff = now - (ranges[range] || ranges['7d']);
  return snapshots.filter(s => s.timestamp >= cutoff);
}

function drawLineChart(canvasId, data, opts) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 300;
  const H = canvas.clientHeight || 120;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // If we have a current value, append it
  const points = [...data];
  if (opts.currentValue !== undefined) {
    points.push({ t: Date.now(), v: opts.currentValue });
  }

  if (points.length < 2) {
    ctx.fillStyle = '#52525b';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Collecting data...', W / 2, H / 2);
    return;
  }

  const PAD = { top: 12, right: 8, bottom: 24, left: 36 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const maxV = Math.max(...points.map(p => p.v), 1);
  const minV = Math.min(...points.map(p => p.v), 0);
  const range = maxV - minV || 1;

  // Downsample if too many points
  const sampled = points.length > 60 ? downsample(points, 60) : points;

  const getX = (i) => PAD.left + (i / (sampled.length - 1)) * plotW;
  const getY = (v) => PAD.top + plotH - ((v - minV) / range) * plotH;

  // Grid lines
  ctx.strokeStyle = '#1e1e2e';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + (plotH / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
  }

  // Y-axis labels
  ctx.fillStyle = '#52525b';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = Math.round(minV + (range / 4) * (4 - i));
    const y = PAD.top + (plotH / 4) * i;
    ctx.fillText(v, PAD.left - 4, y + 3);
  }

  // X-axis time labels
  ctx.textAlign = 'center';
  const firstT = sampled[0].t;
  const lastT = sampled[sampled.length - 1].t;
  const labels = 4;
  for (let i = 0; i <= labels; i++) {
    const t = firstT + ((lastT - firstT) / labels) * i;
    const x = PAD.left + (plotW / labels) * i;
    const d = new Date(t);
    ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, x, H - 4);
  }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + plotH);
  grad.addColorStop(0, opts.color + '33');
  grad.addColorStop(1, opts.color + '05');
  ctx.beginPath();
  ctx.moveTo(getX(0), PAD.top + plotH);
  sampled.forEach((p, i) => ctx.lineTo(getX(i), getY(p.v)));
  ctx.lineTo(getX(sampled.length - 1), PAD.top + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = opts.color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  sampled.forEach((p, i) => { i === 0 ? ctx.moveTo(getX(i), getY(p.v)) : ctx.lineTo(getX(i), getY(p.v)); });
  ctx.stroke();

  // Target line (dashed)
  if (opts.targetLine && opts.targetLine >= minV && opts.targetLine <= maxV * 1.1) {
    const targetY = getY(opts.targetLine);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#22c55e88';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAD.left, targetY);
    ctx.lineTo(W - PAD.right, targetY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#22c55e';
    ctx.font = 'bold 9px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`Goal: ${opts.targetLine}`, W - PAD.right, targetY - 4);
    ctx.restore();
  }

  // Dots at start and end
  [0, sampled.length - 1].forEach(i => {
    ctx.beginPath();
    ctx.arc(getX(i), getY(sampled[i].v), 3, 0, Math.PI * 2);
    ctx.fillStyle = opts.color;
    ctx.fill();
  });

  // Current value label
  const lastPt = sampled[sampled.length - 1];
  ctx.fillStyle = '#e4e4e7';
  ctx.font = 'bold 10px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(lastPt.v, getX(sampled.length - 1) + 6, getY(lastPt.v) + 3);
}

function drawDonutChart(canvasId, categories) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 300;
  const H = canvas.clientHeight || 160;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const entries = Object.entries(categories).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, e) => s + e[1], 0);
  if (total === 0) return;

  const colors = {
    'job-search': '#3b82f6', work: '#22c55e', productivity: '#06b6d4',
    reference: '#6b7280', learning: '#eab308', social: '#ec4899',
    shopping: '#f97316', entertainment: '#8b5cf6', email: '#ef4444',
    news: '#6b7280', finance: '#10b981', other: '#52525b'
  };

  const cx = W * 0.3, cy = H / 2, R = Math.min(cx - 10, cy - 10), r = R * 0.55;
  let angle = -Math.PI / 2;

  entries.forEach(([cat, count]) => {
    const sweep = (count / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, angle, angle + sweep);
    ctx.arc(cx, cy, r, angle + sweep, angle, true);
    ctx.closePath();
    ctx.fillStyle = colors[cat] || '#52525b';
    ctx.fill();
    angle += sweep;
  });

  // Center text
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 18px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(total, cx, cy + 2);
  ctx.fillStyle = '#71717a';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.fillText('TABS', cx, cy + 14);

  // Legend
  const legendX = W * 0.6;
  let legendY = 10;
  ctx.textAlign = 'left';
  entries.slice(0, 8).forEach(([cat, count]) => {
    ctx.fillStyle = colors[cat] || '#52525b';
    ctx.beginPath();
    ctx.roundRect(legendX, legendY, 8, 8, 2);
    ctx.fill();
    ctx.fillStyle = '#a1a1aa';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillText(`${formatCategory(cat)} (${count})`, legendX + 13, legendY + 8);
    legendY += 16;
  });
}

function drawActionsChart(canvasId, snapshots) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 300;
  const H = canvas.clientHeight || 120;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // Aggregate by day
  const dayMap = {};
  snapshots.forEach(s => {
    if (!s.actions) return;
    const day = new Date(s.timestamp).toLocaleDateString();
    if (!dayMap[day]) dayMap[day] = { closed: 0, snoozed: 0, actioned: 0 };
    dayMap[day].closed += s.actions.closed || 0;
    dayMap[day].snoozed += s.actions.snoozed || 0;
    dayMap[day].actioned += s.actions.actioned || 0;
  });

  const days = Object.entries(dayMap);
  if (days.length === 0) {
    ctx.fillStyle = '#52525b';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No action data yet', W / 2, H / 2);
    return;
  }

  const PAD = { top: 12, right: 8, bottom: 24, left: 36 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const maxDay = Math.max(...days.map(([, d]) => d.closed + d.snoozed + d.actioned), 1);
  const barW = Math.min(plotW / days.length - 2, 20);

  days.forEach(([day, d], i) => {
    const x = PAD.left + (i / days.length) * plotW + (plotW / days.length - barW) / 2;
    const total = d.closed + d.snoozed + d.actioned;
    let y = PAD.top + plotH;

    // Stacked: closed (red), snoozed (purple), actioned (yellow)
    const segments = [
      { v: d.closed, color: '#ef4444' },
      { v: d.snoozed, color: '#8b5cf6' },
      { v: d.actioned, color: '#f59e0b' },
    ];
    segments.forEach(seg => {
      const h = (seg.v / maxDay) * plotH;
      y -= h;
      ctx.fillStyle = seg.color;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, h, 2);
      ctx.fill();
    });

    // Day label
    ctx.fillStyle = '#52525b';
    ctx.font = '8px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    const parts = day.split('/');
    ctx.fillText(`${parts[0]}/${parts[1]}`, x + barW / 2, H - 4);
  });

  // Legend
  ctx.textAlign = 'left';
  const legendItems = [{ label: 'Closed', color: '#ef4444' }, { label: 'Snoozed', color: '#8b5cf6' }, { label: 'Actioned', color: '#f59e0b' }];
  let lx = PAD.left;
  legendItems.forEach(item => {
    ctx.fillStyle = item.color;
    ctx.beginPath(); ctx.roundRect(lx, 1, 6, 6, 1); ctx.fill();
    ctx.fillStyle = '#71717a';
    ctx.font = '8px -apple-system, sans-serif';
    ctx.fillText(item.label, lx + 9, 7);
    lx += ctx.measureText(item.label).width + 18;
  });
}

function renderDomainBars(snapshots) {
  const container = document.getElementById('chart-domains');
  if (!container) return;
  container.innerHTML = '';

  // Use latest snapshot or current tabs
  const domainMap = {};
  allTabs.forEach(t => {
    const smart = getSmartDomain(t.url);
    domainMap[smart.name] = (domainMap[smart.name] || 0) + 1;
  });

  const topDomains = Object.entries(domainMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (topDomains.length === 0) return;
  const maxCount = topDomains[0][1];

  topDomains.forEach(([domain, count]) => {
    const row = document.createElement('div');
    row.className = 'analytics-bar-row';
    row.innerHTML = `
      <div class="analytics-bar-label">${escapeHtml(domain)}</div>
      <div class="analytics-bar-track"><div class="analytics-bar-fill" style="width: ${(count / maxCount) * 100}%"></div></div>
      <div class="analytics-bar-value">${count}</div>
    `;
    container.appendChild(row);
  });
}

function downsample(data, targetLen) {
  if (data.length <= targetLen) return data;
  const step = data.length / targetLen;
  const result = [];
  for (let i = 0; i < targetLen; i++) {
    result.push(data[Math.floor(i * step)]);
  }
  if (result[result.length - 1] !== data[data.length - 1]) result.push(data[data.length - 1]);
  return result;
}

// --- Settings ---

function showSettingsModal() {
  if (settingsModal) settingsModal.classList.remove('hidden');
  msg({ action: 'getApiKey' }).then(data => {
    const input = document.getElementById('api-key-input');
    if (input && data && data.apiKey) input.value = data.apiKey;
  });
}

async function saveApiKey() {
  const input = document.getElementById('api-key-input');
  const status = document.getElementById('key-status');
  if (!input) return;
  const key = input.value.trim();
  if (!key) {
    if (status) { status.className = 'error'; status.textContent = 'Please enter an API key'; status.classList.remove('hidden'); }
    return;
  }
  await msg({ action: 'saveApiKey', apiKey: key });
  if (status) { status.className = 'success'; status.textContent = 'API key saved!'; status.classList.remove('hidden'); }
  setTimeout(() => {
    if (settingsModal) settingsModal.classList.add('hidden');
    if (status) status.classList.add('hidden');
  }, 1000);
}

// --- Actions view ---

async function renderActions(filterPriority = 'all') {
  const actions = await msg({ action: 'getActions' });
  const actionList = document.getElementById('action-list');
  const actionEmpty = document.getElementById('action-empty');
  const exportBtn = document.getElementById('export-sheets');

  const filtered = filterPriority === 'all' ? actions : actions.filter(a => a.priority === filterPriority);
  if (actionList) actionList.innerHTML = '';

  if (filtered.length === 0) {
    if (actionEmpty) actionEmpty.classList.remove('hidden');
    if (exportBtn) exportBtn.classList.add('hidden');
    return;
  }

  if (actionEmpty) actionEmpty.classList.add('hidden');
  if (exportBtn) exportBtn.classList.remove('hidden');

  const priorityOrder = { urgent: 0, 'this-week': 1, someday: 2 };
  filtered.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (priorityOrder[a.priority] || 0) - (priorityOrder[b.priority] || 0);
  });

  filtered.forEach(action => {
    const el = document.createElement('div');
    el.className = `list-item${action.done ? ' done' : ''}`;
    el.innerHTML = `
      <img class="favicon" src="${action.favicon || ''}" alt="">
      <div class="list-item-content">
        <div class="list-item-title">${escapeHtml(action.title)}</div>
        <div class="list-item-meta">
          <span class="priority-badge ${action.priority}">${formatPriority(action.priority)}</span>
          <span class="list-item-time">${timeAgo(action.createdAt)}</span>
        </div>
        ${action.note ? `<div class="list-item-note">${escapeHtml(action.note)}</div>` : ''}
      </div>
      <div class="list-item-actions">
        <button class="item-action-btn done-btn" title="${action.done ? 'Undo' : 'Mark done'}">${action.done ? '↩' : '✓'}</button>
        <button class="item-action-btn delete-btn" title="Remove">✕</button>
      </div>
    `;
    el.querySelector('.list-item-title').addEventListener('click', () => chrome.tabs.create({ url: action.url }));
    el.querySelector('.done-btn').addEventListener('click', async () => {
      await msg({ action: 'updateAction', actionId: action.id, updates: { done: !action.done } });
      renderActions(filterPriority);
    });
    el.querySelector('.delete-btn').addEventListener('click', async () => {
      await msg({ action: 'removeAction', actionId: action.id });
      renderActions(filterPriority);
    });
    if (actionList) actionList.appendChild(el);
  });
}

// --- Snoozed view ---

async function renderSnoozed() {
  const snoozed = await msg({ action: 'getSnoozed' });
  const list = document.getElementById('snoozed-list');
  const empty = document.getElementById('snoozed-empty');
  if (list) list.innerHTML = '';
  if (!snoozed || snoozed.length === 0) { if (empty) empty.classList.remove('hidden'); return; }
  if (empty) empty.classList.add('hidden');
  snoozed.sort((a, b) => a.wakeAt - b.wakeAt);

  snoozed.forEach(item => {
    const el = document.createElement('div');
    el.className = 'list-item' + (item.isWindow ? ' window-snooze' : '');
    const title = item.isWindow
      ? `\uD83D\uDDD7 ${item.title}`
      : escapeHtml(item.title);
    const subtitle = item.isWindow
      ? item.tabs.map(t => escapeHtml(t.title)).slice(0, 3).join(', ') + (item.tabs.length > 3 ? ` +${item.tabs.length - 3} more` : '')
      : '';
    el.innerHTML = `
      <div class="list-item-content">
        <div class="list-item-title">${title}</div>
        ${subtitle ? `<div class="list-item-subtitle">${subtitle}</div>` : ''}
        <div class="list-item-meta"><span class="list-item-time">Opens ${formatFutureTime(item.wakeAt)}</span></div>
      </div>
      <div class="list-item-actions"><button class="item-action-btn delete-btn" title="Cancel snooze">\u2715</button></div>
    `;
    el.querySelector('.list-item-title').addEventListener('click', () => {
      if (item.isWindow) {
        // Reopen all tabs in a new window
        chrome.windows.create({ url: item.tabs.map(t => t.url) });
      } else {
        chrome.tabs.create({ url: item.url });
      }
      msg({ action: 'removeSnoozed', alarmName: item.alarmName });
      renderSnoozed();
    });
    el.querySelector('.delete-btn').addEventListener('click', async () => {
      await msg({ action: 'removeSnoozed', alarmName: item.alarmName });
      renderSnoozed();
    });
    if (list) list.appendChild(el);
  });
}

// --- Google Sheets export ---

function exportToSheets() {
  msg({ action: 'getActions' }).then(actions => {
    const active = actions.filter(a => !a.done);
    const tsv = 'Title\tURL\tPriority\tNote\tDate\n' + active.map(a =>
      `${a.title}\t${a.url}\t${formatPriority(a.priority)}\t${a.note || ''}\t${new Date(a.createdAt).toLocaleDateString()}`
    ).join('\n');
    navigator.clipboard.writeText(tsv).then(() => {
      const btn = document.getElementById('export-sheets');
      if (btn) { btn.textContent = 'Copied! Paste into Google Sheets'; setTimeout(() => { btn.textContent = 'Export to Google Sheets'; }, 3000); }
    });
  });
}

// --- Event listeners ---

function setupListeners() {
  // Card actions
  const closeBtn = card?.querySelector('.close-btn');
  const summarizeBtn = card?.querySelector('.summarize-btn');
  const actionQueueBtn = card?.querySelector('.action-queue-btn');
  const snoozeBtn = card?.querySelector('.snooze-btn');

  if (closeBtn) closeBtn.addEventListener('click', closeTab);
  if (summarizeBtn) summarizeBtn.addEventListener('click', summarizeCurrentTab);
  if (actionQueueBtn) actionQueueBtn.addEventListener('click', showActionModal);
  if (snoozeBtn) snoozeBtn.addEventListener('click', showSnoozeModal);

  // Suggested action chip
  if (suggestedAction) suggestedAction.addEventListener('click', executeSuggestedAction);

  // Analysis actions
  const closeDupBtn = document.getElementById('close-duplicates');
  const toggleDupBtn = document.getElementById('toggle-duplicates');
  if (closeDupBtn) closeDupBtn.addEventListener('click', closeDuplicates);
  if (toggleDupBtn) {
    toggleDupBtn.addEventListener('click', () => {
      const list = document.getElementById('duplicate-list');
      if (!list) return;
      list.classList.toggle('hidden');
      toggleDupBtn.textContent = list.classList.contains('hidden') ? 'View' : 'Hide';
    });
  }

  // Mode toggle (This Tab / All Tabs)
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const activeMode = document.querySelector('.mode-btn.active');
      if (activeMode) activeMode.classList.remove('active');
      btn.classList.add('active');
      switchMode(btn.dataset.mode);
    });
  });

  // Snooze modal
  if (snoozeModal) {
    snoozeModal.querySelectorAll('.snooze-option').forEach(btn => {
      btn.addEventListener('click', () => snoozeTab(parseInt(btn.dataset.minutes)));
    });
  }

  // Action modal
  if (actionModal) {
    actionModal.querySelectorAll('.priority-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        actionModal.querySelectorAll('.priority-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedPriority = btn.dataset.priority;
      });
    });
  }

  const confirmActionBtn = document.getElementById('confirm-action');
  if (confirmActionBtn) confirmActionBtn.addEventListener('click', confirmAction);
  const actionNoteField = document.getElementById('action-note');
  if (actionNoteField) actionNoteField.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmAction(); });

  // Cancel buttons for all modals
  document.querySelectorAll('.modal-cancel').forEach(btn => {
    btn.addEventListener('click', () => { const modal = btn.closest('.modal'); if (modal) modal.classList.add('hidden'); });
  });

  // View navigation
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const av = document.querySelector('.view-btn.active');
      if (av) av.classList.remove('active');
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
      const tv = document.getElementById(`${btn.dataset.view}-view`);
      if (tv) tv.classList.remove('hidden');
      if (btn.dataset.view === 'actions') renderActions();
      if (btn.dataset.view === 'snoozed') renderSnoozed();
      if (btn.dataset.view === 'analytics') renderAnalyticsDashboard();
    });
  });

  // Global dedup button
  const dedupAllBtnListener = document.getElementById('dedup-all-btn');
  if (dedupAllBtnListener) dedupAllBtnListener.addEventListener('click', dedupAllTabs);

  // Group in Browser buttons
  const groupBrowserBtn = document.getElementById('group-by-category');
  if (groupBrowserBtn) groupBrowserBtn.addEventListener('click', groupInBrowser);
  const aiGroupBtn = document.getElementById('ai-group-browser');
  if (aiGroupBtn) aiGroupBtn.addEventListener('click', groupInBrowser);

  // Analytics time range
  document.querySelectorAll('.timerange-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ab = document.querySelector('.timerange-btn.active');
      if (ab) ab.classList.remove('active');
      btn.classList.add('active');
      renderAnalyticsDashboard(btn.dataset.range);
    });
  });

  // Tab target modal
  const editTargetBtn = document.getElementById('edit-target-btn');
  const targetModal = document.getElementById('target-modal');
  if (editTargetBtn) editTargetBtn.addEventListener('click', () => {
    if (targetModal) {
      const input = document.getElementById('target-input');
      if (input && tabTarget) input.value = tabTarget;
      targetModal.classList.remove('hidden');
    }
  });
  const saveTargetBtn = document.getElementById('save-target');
  if (saveTargetBtn) saveTargetBtn.addEventListener('click', async () => {
    const input = document.getElementById('target-input');
    if (!input) return;
    const val = parseInt(input.value);
    if (val > 0) {
      await msg({ action: 'saveTabTarget', target: val });
      tabTarget = val;
      if (targetModal) targetModal.classList.add('hidden');
      renderAnalyticsDashboard();
    }
  });
  const clearTargetBtn = document.getElementById('clear-target');
  if (clearTargetBtn) clearTargetBtn.addEventListener('click', async () => {
    await msg({ action: 'saveTabTarget', target: null });
    tabTarget = null;
    if (targetModal) targetModal.classList.add('hidden');
    renderAnalyticsDashboard();
  });
  document.querySelectorAll('.target-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('target-input');
      if (input) input.value = btn.dataset.target;
    });
  });

  // Snooze scope toggle
  document.querySelectorAll('.scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.scope-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      snoozeScope = btn.dataset.scope;
    });
  });

  // Action priority filters
  document.querySelectorAll('.priority-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      const ap = document.querySelector('.priority-filter.active');
      if (ap) ap.classList.remove('active');
      btn.classList.add('active');
      renderActions(btn.dataset.priority);
    });
  });

  // Export
  const exportBtn = document.getElementById('export-sheets');
  if (exportBtn) exportBtn.addEventListener('click', exportToSheets);

  // Click title to focus
  if (cardTitle) cardTitle.addEventListener('click', () => {
    const tab = allTabs.find(t => t.id === activeTabId);
    if (tab) msg({ action: 'focusTab', tabId: tab.id, windowId: tab.windowId });
  });

  // AI Sort listeners
  const aiAnalyzeBtn = document.getElementById('ai-analyze-btn');
  if (aiAnalyzeBtn) aiAnalyzeBtn.addEventListener('click', runAiAnalysis);
  const aiSettingsBtn = document.getElementById('ai-settings-btn');
  if (aiSettingsBtn) aiSettingsBtn.addEventListener('click', showSettingsModal);
  const aiRetryBtn = document.getElementById('ai-retry-btn');
  if (aiRetryBtn) aiRetryBtn.addEventListener('click', runAiAnalysis);
  const aiCloseAllBtn = document.getElementById('ai-close-all');
  if (aiCloseAllBtn) aiCloseAllBtn.addEventListener('click', closeAllAiSuggested);
  const aiReanalyzeBtn = document.getElementById('ai-reanalyze');
  if (aiReanalyzeBtn) aiReanalyzeBtn.addEventListener('click', () => {
    aiResults = null;
    const s = document.getElementById('ai-start'), r = document.getElementById('ai-results');
    if (s) s.classList.remove('hidden'); if (r) r.classList.add('hidden');
    runAiAnalysis();
  });

  document.querySelectorAll('.ai-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      const af = document.querySelector('.ai-filter.active');
      if (af) af.classList.remove('active');
      btn.classList.add('active');
      aiFilter = btn.dataset.filter;
      renderAiTabList();
    });
  });

  document.querySelectorAll('.ai-stat').forEach(stat => {
    stat.addEventListener('click', () => {
      const fn = stat.classList.contains('close') ? 'close' : stat.classList.contains('keep') ? 'keep'
        : stat.classList.contains('action') ? 'action' : stat.classList.contains('snooze') ? 'snooze' : 'all';
      const af = document.querySelector('.ai-filter.active');
      if (af) af.classList.remove('active');
      const fb = document.querySelector(`.ai-filter[data-filter="${fn}"]`);
      if (fb) fb.classList.add('active');
      aiFilter = fn;
      renderAiTabList();
    });
  });

  const saveKeyBtn = document.getElementById('save-api-key');
  if (saveKeyBtn) saveKeyBtn.addEventListener('click', saveApiKey);
  const apiKeyInput = document.getElementById('api-key-input');
  if (apiKeyInput) apiKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveApiKey(); });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const targetModalEl = document.getElementById('target-modal');
    const modals = [snoozeModal, actionModal, settingsModal, targetModalEl];
    const anyOpen = modals.some(m => m && !m.classList.contains('hidden'));
    if (anyOpen) { if (e.key === 'Escape') modals.forEach(m => { if (m) m.classList.add('hidden'); }); return; }

    const tv = document.getElementById('triage-view');
    if (!tv || tv.classList.contains('hidden') || triageMode !== 'this') return;

    switch (e.key) {
      case 'x': closeTab(); break;
      case 's': summarizeCurrentTab(); break;
      case 'a': showActionModal(); break;
      case 'z': showSnoozeModal(); break;
      case 'Enter': executeSuggestedAction(); break;
    }
  });
}

// --- Helpers ---

function msg(data) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(data, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('Tab Triage msg error:', chrome.runtime.lastError.message);
        resolve(undefined);
      } else {
        resolve(response);
      }
    });
  });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatPriority(p) {
  const map = { urgent: 'Urgent', 'this-week': 'This Week', someday: 'Someday' };
  return map[p] || p;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatFutureTime(ts) {
  const diff = ts - Date.now();
  if (diff <= 0) return 'any moment';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}
