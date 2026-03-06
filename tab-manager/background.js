// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Listen for messages from the side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    getTabs: () => getAllTabs(),
    getAnalysis: () => analyzeTabs(),
    closeTab: () => chrome.tabs.remove(message.tabId).then(() => ({ success: true })),
    closeTabs: () => chrome.tabs.remove(message.tabIds).then(() => ({ success: true })),
    focusTab: () => chrome.tabs.update(message.tabId, { active: true })
      .then(() => chrome.windows.update(message.windowId, { focused: true }))
      .then(() => ({ success: true })),
    snoozeTab: () => snoozeTab(message.tabId, message.url, message.title, message.minutes),
    queueAction: () => queueAction(message.tab, message.priority, message.note),
    getActions: () => chrome.storage.local.get('actionQueue').then(d => d.actionQueue || []),
    getSnoozed: () => chrome.storage.local.get('snoozedTabs').then(d => d.snoozedTabs || []),
    updateAction: () => updateAction(message.actionId, message.updates),
    removeAction: () => removeAction(message.actionId),
    removeSnoozed: () => removeSnoozed(message.alarmName),
    getPageInfo: () => getPageInfo(message.tabId),
    // AI features
    aiSummarizeTab: () => aiSummarizeTab(message.tabId, message.apiKey),
    aiAnalyze: () => aiAnalyzeTabs(message.apiKey),
    saveApiKey: () => saveApiKey(message.apiKey),
    getApiKey: () => chrome.storage.local.get('claudeApiKey').then(d => ({ apiKey: d.claudeApiKey || '' })),
    // Category rules & grouping
    getCategoryRules: () => chrome.storage.local.get('categoryRules').then(d => d.categoryRules || {}),
    saveCategoryRule: () => saveCategoryRule(message.domainKey, message.category, message.source),
    saveCategoryRules: () => saveCategoryRulesBatch(message.rules),
    groupTabsInBrowser: () => groupTabsInBrowser(message.groups),
    // Action tracking
    trackAction: () => trackUserAction(message.actionType, message.count),
    // Analytics
    getAnalytics: () => getTabAnalytics(),
    recordSnapshot: () => recordTabSnapshot(),
    // Tab target
    getTabTarget: () => chrome.storage.local.get('tabTarget').then(d => ({ target: d.tabTarget || null })),
    saveTabTarget: () => chrome.storage.local.set({ tabTarget: message.target }).then(() => ({ success: true })),
    // Window snooze
    snoozeWindow: () => snoozeWindow(message.windowId, message.minutes),
  };

  const handler = handlers[message.action];
  if (handler) {
    handler()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function getAllTabs() {
  const tabs = await chrome.tabs.query({});
  const windows = new Set(tabs.map(t => t.windowId));
  return {
    tabs: tabs.map(t => ({
      id: t.id,
      windowId: t.windowId,
      title: t.title || 'Untitled',
      url: t.url || '',
      favIconUrl: t.favIconUrl || '',
      active: t.active,
      pinned: t.pinned,
      groupId: t.groupId || -1
    })),
    windowCount: windows.size
  };
}

// Analyze tabs for duplicates
async function analyzeTabs() {
  const { tabs } = await getAllTabs();
  const userTabs = tabs.filter(t => !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));

  // Find duplicates (same URL)
  const urlMap = {};
  userTabs.forEach(t => {
    const normalizedUrl = normalizeUrl(t.url);
    if (!urlMap[normalizedUrl]) urlMap[normalizedUrl] = [];
    urlMap[normalizedUrl].push(t);
  });
  const duplicates = Object.entries(urlMap)
    .filter(([, tabs]) => tabs.length > 1)
    .map(([url, tabs]) => ({ url, tabs, count: tabs.length }));

  const duplicateTabCount = duplicates.reduce((sum, d) => sum + d.count - 1, 0);

  return {
    totalTabs: userTabs.length,
    duplicates,
    duplicateTabCount,
  };
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/$/, '') + u.search;
  } catch {
    return url;
  }
}

async function queueAction(tab, priority, note) {
  const data = await chrome.storage.local.get('actionQueue');
  const queue = data.actionQueue || [];
  queue.push({
    id: `action-${Date.now()}`,
    url: tab.url,
    title: tab.title,
    favicon: tab.favIconUrl,
    priority,
    note: note || '',
    createdAt: Date.now(),
    done: false
  });
  await chrome.storage.local.set({ actionQueue: queue });
  return { success: true };
}

async function updateAction(actionId, updates) {
  const data = await chrome.storage.local.get('actionQueue');
  const queue = (data.actionQueue || []).map(a =>
    a.id === actionId ? { ...a, ...updates } : a
  );
  await chrome.storage.local.set({ actionQueue: queue });
  return { success: true };
}

async function removeAction(actionId) {
  const data = await chrome.storage.local.get('actionQueue');
  const queue = (data.actionQueue || []).filter(a => a.id !== actionId);
  await chrome.storage.local.set({ actionQueue: queue });
  return { success: true };
}

async function removeSnoozed(alarmName) {
  chrome.alarms.clear(alarmName);
  const data = await chrome.storage.local.get('snoozedTabs');
  const snoozed = (data.snoozedTabs || []).filter(t => t.alarmName !== alarmName);
  await chrome.storage.local.set({ snoozedTabs: snoozed });
  return { success: true };
}

async function snoozeTab(tabId, url, title, minutes) {
  const wakeAt = Date.now() + minutes * 60 * 1000;
  const alarmName = `snooze-${Date.now()}`;

  const data = await chrome.storage.local.get('snoozedTabs');
  const snoozed = data.snoozedTabs || [];
  snoozed.push({ url, title, wakeAt, alarmName });
  await chrome.storage.local.set({ snoozedTabs: snoozed });

  chrome.alarms.create(alarmName, { when: wakeAt });
  await chrome.tabs.remove(tabId);
  return { success: true };
}

async function snoozeWindow(windowId, minutes) {
  const tabs = await chrome.tabs.query({ windowId });
  const userTabs = tabs.filter(t =>
    !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  );
  if (userTabs.length === 0) return { success: false, error: 'No tabs to snooze' };

  const wakeAt = Date.now() + minutes * 60 * 1000;
  const alarmName = `snooze-window-${Date.now()}`;

  const data = await chrome.storage.local.get('snoozedTabs');
  const snoozed = data.snoozedTabs || [];
  snoozed.push({
    isWindow: true,
    tabs: userTabs.map(t => ({ url: t.url, title: t.title })),
    title: `Window (${userTabs.length} tabs)`,
    wakeAt,
    alarmName
  });
  await chrome.storage.local.set({ snoozedTabs: snoozed });

  chrome.alarms.create(alarmName, { when: wakeAt });
  // Close all tabs in window (which closes the window)
  await chrome.tabs.remove(userTabs.map(t => t.id));
  return { success: true, count: userTabs.length };
}

// --- Category Rules (Learning) ---

async function saveCategoryRule(domainKey, category, source = 'user') {
  const data = await chrome.storage.local.get('categoryRules');
  const rules = data.categoryRules || {};
  rules[domainKey] = { category, source, updatedAt: Date.now() };
  await chrome.storage.local.set({ categoryRules: rules });
  return { success: true };
}

async function saveCategoryRulesBatch(ruleEntries) {
  const data = await chrome.storage.local.get('categoryRules');
  const rules = data.categoryRules || {};
  for (const { domainKey, category, source } of ruleEntries) {
    // User rules never get overwritten by AI
    if (rules[domainKey]?.source === 'user' && source === 'ai') continue;
    rules[domainKey] = { category, source: source || 'ai', updatedAt: Date.now() };
  }
  await chrome.storage.local.set({ categoryRules: rules });
  return { success: true };
}

// --- Chrome Tab Groups ---

const CATEGORY_COLORS = {
  'job-search': 'blue', work: 'green', productivity: 'cyan',
  reference: 'grey', learning: 'yellow', social: 'pink',
  shopping: 'orange', entertainment: 'purple', email: 'red',
  news: 'grey', finance: 'green', other: 'grey'
};

const CATEGORY_TITLES = {
  'job-search': 'Job Search', work: 'Work', productivity: 'Productivity',
  reference: 'Reference', learning: 'Learning', social: 'Social',
  shopping: 'Shopping', entertainment: 'Entertainment', email: 'Email',
  news: 'News', finance: 'Finance', other: 'Other'
};

async function groupTabsInBrowser(groups) {
  for (const group of groups) {
    if (!group.tabIds || group.tabIds.length === 0) continue;
    try {
      // Verify tabs still exist
      const validIds = [];
      for (const id of group.tabIds) {
        try { await chrome.tabs.get(id); validIds.push(id); } catch {}
      }
      if (validIds.length === 0) continue;

      const groupId = await chrome.tabs.group({
        tabIds: validIds,
        ...(group.windowId ? { createProperties: { windowId: group.windowId } } : {})
      });
      await chrome.tabGroups.update(groupId, {
        title: CATEGORY_TITLES[group.category] || group.category,
        color: CATEGORY_COLORS[group.category] || 'grey',
        collapsed: false
      });
    } catch (err) {
      console.error('Failed to group tabs:', err);
    }
  }
  return { success: true };
}

// --- Action Tracking ---

async function trackUserAction(actionType, count = 1) {
  const data = await chrome.storage.local.get('actionStats');
  const stats = data.actionStats || { closed: 0, snoozed: 0, actioned: 0, deduped: 0 };
  if (stats[actionType] !== undefined) {
    stats[actionType] += count;
  } else {
    stats[actionType] = count;
  }
  await chrome.storage.local.set({ actionStats: stats });
  return { success: true };
}

// Extract page info via scripting API
async function getPageInfo(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const metaDesc = document.querySelector('meta[name="description"]')?.content
          || document.querySelector('meta[property="og:description"]')?.content
          || '';

        const ogType = document.querySelector('meta[property="og:type"]')?.content || '';

        let firstParagraph = '';
        if (!metaDesc) {
          const paragraphs = document.querySelectorAll('p');
          for (const p of paragraphs) {
            const text = p.textContent.trim();
            if (text.length > 40) {
              firstParagraph = text.slice(0, 200);
              break;
            }
          }
        }

        let pageType = '';
        const ldJson = document.querySelector('script[type="application/ld+json"]');
        if (ldJson) {
          try {
            const data = JSON.parse(ldJson.textContent);
            pageType = data['@type'] || (Array.isArray(data) ? data[0]?.['@type'] : '') || '';
          } catch {}
        }

        const isJobPosting = pageType === 'JobPosting'
          || document.querySelector('[data-job-id], .job-posting, .jobs-description')
          || /\b(apply now|job description|requirements|qualifications)\b/i.test(document.body?.innerText?.slice(0, 3000) || '');

        return {
          description: metaDesc || firstParagraph || '',
          ogType,
          pageType,
          isJobPosting: !!isJobPosting,
        };
      }
    });
    return results?.[0]?.result || { description: '', pageType: '', isJobPosting: false };
  } catch {
    return { description: '', pageType: '', isJobPosting: false };
  }
}

// --- Per-tab AI Summary (Haiku, with cache) ---

// In-memory cache for tab summaries (survives within service worker lifetime)
const summaryCache = new Map();

async function aiSummarizeTab(tabId, apiKey) {
  if (!apiKey) {
    return { summary: '', suggestedAction: '', actionLabel: '', cached: false };
  }

  // Get basic page info first
  const pageInfo = await getPageInfo(tabId);

  // Get tab details
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { summary: '', suggestedAction: '', actionLabel: '', cached: false };
  }

  const cacheKey = normalizeUrl(tab.url);

  // Check cache
  if (summaryCache.has(cacheKey)) {
    return { ...summaryCache.get(cacheKey), cached: true };
  }

  // Build context for Claude
  const context = [
    `Title: ${tab.title}`,
    `URL: ${tab.url}`,
    pageInfo.description ? `Description: ${pageInfo.description}` : '',
    pageInfo.isJobPosting ? 'Detected: Job Posting' : '',
    pageInfo.ogType ? `Page type: ${pageInfo.ogType}` : '',
    pageInfo.pageType ? `Structured type: ${pageInfo.pageType}` : '',
  ].filter(Boolean).join('\n');

  const prompt = `You are a browser tab assistant. Analyze this tab and respond with ONLY a JSON object (no markdown, no code block):

${context}

Return:
{
  "summary": "1-2 sentence plain-language description of what this page is and why someone might have it open",
  "suggestedAction": one of "close" | "action" | "claude" | "snooze" | "keep",
  "actionLabel": "short imperative label for the action, e.g. 'Apply to this job' or 'Safe to close — old search results'"
}

Guidelines for suggestedAction:
- "action": needs follow-up (job applications, forms, emails to respond to, tasks)
- "close": stale, already-read, generic homepage, easily re-found
- "claude": complex page that needs deeper AI analysis or summarization
- "snooze": interesting but not urgent (articles to read, videos to watch)
- "keep": actively useful and should stay open (docs you're working in, tools)`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      return { summary: pageInfo.description || '', suggestedAction: '', actionLabel: '', cached: false };
    }

    const result = await response.json();
    const text = result.content?.[0]?.text || '';

    // Parse JSON (handle possible markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { summary: pageInfo.description || '', suggestedAction: '', actionLabel: '', cached: false };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const summaryResult = {
      summary: parsed.summary || '',
      suggestedAction: parsed.suggestedAction || '',
      actionLabel: parsed.actionLabel || '',
    };

    // Cache it
    summaryCache.set(cacheKey, summaryResult);

    return { ...summaryResult, cached: false };
  } catch {
    return { summary: pageInfo.description || '', suggestedAction: '', actionLabel: '', cached: false };
  }
}

// --- AI Batch Analysis via Claude API ---

async function saveApiKey(apiKey) {
  await chrome.storage.local.set({ claudeApiKey: apiKey });
  return { success: true };
}

async function aiAnalyzeTabs(apiKey) {
  if (!apiKey) {
    throw new Error('No API key provided');
  }

  const { tabs } = await getAllTabs();
  const userTabs = tabs.filter(t =>
    !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  );

  // Build compact tab list for the prompt
  const tabList = userTabs.map((t, i) => `${i + 1}. "${t.title}" — ${t.url}`).join('\n');

  const prompt = `You are a browser tab organization assistant. I have ${userTabs.length} tabs open and need help sorting through them quickly.

Analyze each tab and classify it. For each tab, return a JSON object with:
- "index": the tab number (1-based)
- "category": one of ["job-search", "work", "productivity", "reference", "learning", "social", "shopping", "entertainment", "email", "news", "finance", "other"]
- "action": one of ["close" (stale/not needed), "keep" (actively useful), "action" (needs follow-up), "snooze" (come back later)]
- "reason": brief 3-8 word reason for your recommendation
- "priority": "high", "medium", or "low" (how important is acting on this tab)

Be aggressive about recommending "close" for:
- Tabs that look stale or completed (old search results, already-read articles, finished tasks)
- Duplicate content across different URLs
- Generic homepages that can easily be re-found

Recommend "action" for tabs that clearly need follow-up (job applications, unanswered emails, pending forms).

Return ONLY a JSON array, no other text. Example:
[{"index":1,"category":"job-search","action":"action","reason":"Pending job application","priority":"high"}]

Here are my tabs:
${tabList}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    if (response.status === 401) throw new Error('Invalid API key. Please check your key in settings.');
    if (response.status === 429) throw new Error('Rate limited. Please wait a moment and try again.');
    // Parse Anthropic error messages for a clean display
    try {
      const errJson = JSON.parse(errBody);
      const errMsg = errJson?.error?.message || errBody.slice(0, 200);
      throw new Error(errMsg);
    } catch (parseErr) {
      if (parseErr.message && !parseErr.message.startsWith('Unexpected')) throw parseErr;
      throw new Error(`API error (${response.status}): ${errBody.slice(0, 200)}`);
    }
  }

  const result = await response.json();
  const text = result.content?.[0]?.text || '';

  // Parse JSON from response (handle markdown code blocks)
  let classifications;
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in response');
    classifications = JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    throw new Error('Failed to parse AI response. Please try again.');
  }

  // Merge classifications with tab data
  const analyzed = userTabs.map((tab, i) => {
    const classification = classifications.find(c => c.index === i + 1) || {
      category: 'other',
      action: 'keep',
      reason: 'Not classified',
      priority: 'low'
    };
    return {
      ...tab,
      ai: classification
    };
  });

  // Build summary stats
  const summary = {
    total: analyzed.length,
    close: analyzed.filter(t => t.ai.action === 'close').length,
    keep: analyzed.filter(t => t.ai.action === 'keep').length,
    action: analyzed.filter(t => t.ai.action === 'action').length,
    snooze: analyzed.filter(t => t.ai.action === 'snooze').length,
  };

  // Group by category
  const byCategory = {};
  analyzed.forEach(tab => {
    const cat = tab.ai.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(tab);
  });

  // Record analytics snapshot
  await recordTabSnapshot(analyzed);

  // Save AI-inferred category rules for learning
  const aiRules = analyzed.map(tab => ({
    domainKey: getSmartDomainKey(tab.url),
    category: tab.ai.category,
    source: 'ai'
  })).filter(r => r.domainKey && r.category);
  await saveCategoryRulesBatch(aiRules);

  return { analyzed, summary, byCategory };
}

// --- Tab Analytics ---

async function recordTabSnapshot(analyzedTabs) {
  const data = await chrome.storage.local.get(['tabAnalytics', 'actionStats']);
  const analytics = data.tabAnalytics || { snapshots: [] };
  const actionStats = data.actionStats || { closed: 0, snoozed: 0, actioned: 0 };

  const { tabs } = analyzedTabs ? { tabs: analyzedTabs } : await getAllTabs();
  const userTabs = analyzedTabs || tabs.filter(t =>
    !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  );

  // Extract domain breakdown using smart domain keys
  const domains = {};
  userTabs.forEach(t => {
    try {
      const domain = getSmartDomainKey(t.url);
      domains[domain] = (domains[domain] || 0) + 1;
    } catch {}
  });

  const topDomains = Object.entries(domains)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([domain, count]) => ({ domain, count }));

  // Category breakdown (if AI analysis was run)
  const categories = {};
  if (analyzedTabs) {
    analyzedTabs.forEach(t => {
      if (t.ai?.category) {
        categories[t.ai.category] = (categories[t.ai.category] || 0) + 1;
      }
    });
  }

  // Count current duplicates
  const urlCounts = {};
  userTabs.forEach(t => {
    try {
      const u = new URL(t.url);
      const key = u.origin + u.pathname.replace(/\/$/, '') + u.search;
      urlCounts[key] = (urlCounts[key] || 0) + 1;
    } catch {}
  });
  const duplicateCount = Object.values(urlCounts).reduce((s, c) => s + Math.max(c - 1, 0), 0);

  const snapshot = {
    timestamp: Date.now(),
    tabCount: userTabs.length,
    windowCount: new Set(userTabs.map(t => t.windowId)).size,
    duplicateCount,
    topDomains,
    categories: Object.keys(categories).length > 0 ? categories : null,
    actions: { ...actionStats },
  };

  analytics.snapshots.push(snapshot);

  // Keep last 720 snapshots (30 days of hourly data)
  if (analytics.snapshots.length > 720) {
    analytics.snapshots = analytics.snapshots.slice(-720);
  }

  // Reset action stats after recording
  await chrome.storage.local.set({
    tabAnalytics: analytics,
    actionStats: { closed: 0, snoozed: 0, actioned: 0 }
  });
  return { success: true };
}

// Smart domain key for analytics (mirrors sidepanel.js logic)
function getSmartDomainKey(urlString) {
  try {
    const u = new URL(urlString);
    // Google Workspace
    if (u.hostname === 'docs.google.com') {
      if (u.pathname.startsWith('/document')) return 'Google Docs';
      if (u.pathname.startsWith('/spreadsheets')) return 'Google Sheets';
      if (u.pathname.startsWith('/presentation')) return 'Google Slides';
      if (u.pathname.startsWith('/forms')) return 'Google Forms';
      return 'Google Docs';
    }
    if (u.hostname === 'drive.google.com') return 'Google Drive';
    if (u.hostname === 'mail.google.com') return 'Gmail';
    if (u.hostname === 'calendar.google.com') return 'Google Calendar';
    if (u.hostname === 'meet.google.com') return 'Google Meet';
    // GitHub
    if (u.hostname === 'github.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      return parts.length >= 2 ? `GitHub: ${parts[0]}/${parts[1]}` : 'GitHub';
    }
    if (u.hostname.includes('linkedin.com')) return 'LinkedIn';
    if (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') return 'YouTube';
    return u.hostname.replace(/^www\./, '');
  } catch {
    return 'other';
  }
}

async function getTabAnalytics() {
  const data = await chrome.storage.local.get('tabAnalytics');
  return data.tabAnalytics || { snapshots: [] };
}

// Handle snooze alarms — reopen tab(s)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('snooze-')) return;

  const data = await chrome.storage.local.get('snoozedTabs');
  const snoozed = data.snoozedTabs || [];
  const entry = snoozed.find(t => t.alarmName === alarm.name);

  if (entry) {
    if (entry.isWindow && entry.tabs) {
      // Window snooze: reopen all tabs in a new window
      const urls = entry.tabs.map(t => t.url);
      chrome.windows.create({ url: urls });
    } else {
      // Single tab snooze
      chrome.tabs.create({ url: entry.url });
    }
    const remaining = snoozed.filter(t => t.alarmName !== alarm.name);
    await chrome.storage.local.set({ snoozedTabs: remaining });
  }
});

// Record a snapshot every hour for analytics
chrome.alarms.create('analytics-snapshot', { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'analytics-snapshot') {
    await recordTabSnapshot();
  }
});
