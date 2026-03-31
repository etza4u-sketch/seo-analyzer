const express = require('express');
const cheerio = require('cheerio');
const { URL } = require('url');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ── Fetch with redirect support ── */
function fetchPage(targetUrl, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    const mod = targetUrl.startsWith('https') ? https : http;
    const req = mod.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
        'Accept-Encoding': 'identity',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).href;
        return fetchPage(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          html: Buffer.concat(chunks).toString('utf8'),
          finalUrl: targetUrl,
          statusCode: res.statusCode,
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

/* ── Analyze endpoint ── */
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'נדרשת כתובת URL' });

  try {
    const targetUrl = url.startsWith('http') ? url : `https://${url}`;
    new URL(targetUrl);

    const startTime = Date.now();
    const { html, finalUrl, statusCode, headers } = await fetchPage(targetUrl);
    const fetchTime = Date.now() - startTime;

    const analysis = analyzeHTML(html, finalUrl, statusCode, headers, fetchTime);
    res.json(analysis);
  } catch (err) {
    res.status(500).json({ error: `שגיאה בגישה לאתר: ${err.message}` });
  }
});

/* ── Main analysis ── */
function analyzeHTML(html, url, statusCode, headers, fetchTime) {
  const $ = cheerio.load(html);
  const parsedUrl = new URL(url);

  // Meta tags
  const title = $('title').text().trim();
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const metaKeywords = $('meta[name="keywords"]').attr('content') || '';
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  const robots = $('meta[name="robots"]').attr('content') || '';
  const viewport = $('meta[name="viewport"]').attr('content') || '';
  const charset = $('meta[charset]').attr('charset') || $('meta[http-equiv="Content-Type"]').attr('content') || '';
  const lang = $('html').attr('lang') || '';
  const favicon = $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || '';

  // Open Graph
  const og = {};
  $('meta[property^="og:"]').each((_, el) => {
    og[$(el).attr('property').replace('og:', '')] = $(el).attr('content') || '';
  });

  // Twitter Card
  const twitter = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    twitter[$(el).attr('name').replace('twitter:', '')] = $(el).attr('content') || '';
  });

  // Headings
  const headings = {};
  for (let i = 1; i <= 6; i++) {
    const tags = [];
    $(`h${i}`).each((_, el) => tags.push($(el).text().trim().substring(0, 120)));
    headings[`h${i}`] = { count: tags.length, samples: tags.slice(0, 5) };
  }

  // Images
  const images = { total: 0, withAlt: 0, withoutAlt: 0, lazy: 0, withoutDimensions: 0, samples: [] };
  $('img').each((_, el) => {
    images.total++;
    const alt = $(el).attr('alt');
    if (alt && alt.trim()) images.withAlt++;
    else {
      images.withoutAlt++;
      if (images.samples.length < 5) images.samples.push($(el).attr('src') || 'unknown');
    }
    if ($(el).attr('loading') === 'lazy') images.lazy++;
    if (!$(el).attr('width') && !$(el).attr('height')) images.withoutDimensions++;
  });

  // Links
  const links = { internal: 0, external: 0, nofollow: 0, broken: 0, total: 0, externalDomains: [] };
  $('a[href]').each((_, el) => {
    links.total++;
    const href = $(el).attr('href') || '';
    const rel = $(el).attr('rel') || '';
    if (rel.includes('nofollow')) links.nofollow++;
    if (href === '#' || href === '') { links.broken++; return; }
    try {
      const linkUrl = new URL(href, url);
      if (linkUrl.hostname === parsedUrl.hostname) {
        links.internal++;
      } else {
        links.external++;
        if (!links.externalDomains.includes(linkUrl.hostname) && links.externalDomains.length < 10) {
          links.externalDomains.push(linkUrl.hostname);
        }
      }
    } catch { links.internal++; }
  });

  // Structured Data
  const structuredData = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      structuredData.push({ type: data['@type'] || 'Unknown', raw: data });
    } catch { /* ignore */ }
  });

  // Content analysis
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText.split(/\s+/).filter(w => w.length > 1).length;
  const paragraphs = [];
  $('p').each((_, el) => {
    const t = $(el).text().trim();
    if (t.length > 10) paragraphs.push(t);
  });

  // Performance indicators
  const htmlSize = Buffer.byteLength(html, 'utf8');
  const scripts = { total: $('script').length, external: $('script[src]').length, inline: $('script:not([src])').length };
  const stylesheets = { external: $('link[rel="stylesheet"]').length, inline: $('style').length };
  const iframes = $('iframe').length;

  // Security
  const isHttps = url.startsWith('https');
  const hsts = headers['strict-transport-security'] || '';
  const csp = headers['content-security-policy'] || '';
  const xFrame = headers['x-frame-options'] || '';
  const xContent = headers['x-content-type-options'] || '';
  const referrer = headers['referrer-policy'] || '';

  // Accessibility basics
  const accessibility = analyzeAccessibility($);

  // AI Detection
  const aiSignals = detectAISignals($, bodyText, paragraphs);

  // Score
  const scores = computeScores({
    title, metaDescription, canonical, viewport, lang, isHttps,
    headings, images, links, structuredData, og, twitter,
    htmlSize, hsts, robots, charset, wordCount, accessibility,
  });

  return {
    url,
    statusCode,
    fetchTime,
    meta: { title, metaDescription, metaKeywords, canonical, robots, viewport, charset, lang, favicon },
    openGraph: og,
    twitterCard: twitter,
    headings,
    images,
    links,
    structuredData: structuredData.map(s => s.type),
    content: { wordCount, paragraphCount: paragraphs.length },
    performance: {
      htmlSizeKB: Math.round(htmlSize / 1024),
      scripts,
      stylesheets,
      iframes,
      fetchTimeMs: fetchTime,
    },
    security: { isHttps, hsts: !!hsts, csp: !!csp, xFrameOptions: xFrame, xContentType: !!xContent, referrerPolicy: referrer },
    accessibility,
    aiSignals,
    scores,
  };
}

/* ── Accessibility ── */
function analyzeAccessibility($) {
  const issues = [];
  let score = 100;

  // Form labels
  const inputs = $('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
  let unlabeled = 0;
  inputs.each((_, el) => {
    const id = $(el).attr('id');
    const ariaLabel = $(el).attr('aria-label');
    const hasLabel = id ? $(`label[for="${id}"]`).length > 0 : false;
    if (!hasLabel && !ariaLabel) unlabeled++;
  });
  if (unlabeled > 0) {
    issues.push({ text: `${unlabeled} שדות קלט ללא תוויות`, severity: 'warning' });
    score -= unlabeled * 5;
  }

  // Skip link
  const skipLink = $('a[href="#main"], a[href="#content"], a.skip-link, a.skip-to-content');
  if (!skipLink.length) {
    issues.push({ text: 'חסר קישור דילוג לתוכן ראשי', severity: 'info' });
    score -= 5;
  }

  // ARIA landmarks
  const landmarks = $('[role="main"], main, [role="navigation"], nav, [role="banner"], header, [role="contentinfo"], footer');
  if (landmarks.length < 2) {
    issues.push({ text: 'חסרים landmarks של ARIA', severity: 'info' });
    score -= 5;
  }

  // Color contrast cannot be checked server-side
  // Tab index abuse
  const badTabIndex = $('[tabindex]').filter((_, el) => parseInt($(el).attr('tabindex')) > 0);
  if (badTabIndex.length) {
    issues.push({ text: `${badTabIndex.length} אלמנטים עם tabindex חיובי (לא מומלץ)`, severity: 'warning' });
    score -= badTabIndex.length * 3;
  }

  return { score: Math.max(0, Math.min(100, score)), issues };
}

/* ── AI Detection ── */
function detectAISignals($, bodyText, paragraphs) {
  const signals = [];
  let aiScore = 0;

  // English AI patterns
  const enPatterns = [
    { pattern: /as an ai/gi, label: 'התייחסות עצמית של AI', weight: 8 },
    { pattern: /language model/gi, label: 'אזכור מודל שפה', weight: 8 },
    { pattern: /i cannot provide/gi, label: 'דפוס סירוב AI', weight: 8 },
    { pattern: /it'?s important to note that/gi, label: 'ניסוח שכיח של AI', weight: 5 },
    { pattern: /in conclusion,?\s/gi, label: 'דפוס סיכום נוסחתי', weight: 3 },
    { pattern: /comprehensive guide/gi, label: 'כותרת גנרית של AI', weight: 4 },
    { pattern: /delve into/gi, label: 'פועל שכיח ב-AI', weight: 4 },
    { pattern: /game.?changer/gi, label: 'באזוורד AI', weight: 3 },
    { pattern: /navigate the .* landscape/gi, label: 'קלישאת AI', weight: 5 },
    { pattern: /at the end of the day/gi, label: 'ביטוי מילוי', weight: 2 },
    { pattern: /unlock the (?:full )?potential/gi, label: 'ביטוי שיווקי AI', weight: 4 },
    { pattern: /in today'?s (?:digital |fast.paced |modern )/gi, label: 'פתיחה גנרית של AI', weight: 5 },
    { pattern: /whether you'?re a .* or a/gi, label: 'דפוס פנייה גנרית', weight: 4 },
    { pattern: /the (?:world|realm|landscape) of/gi, label: 'פתיחה כללית מדי', weight: 3 },
    { pattern: /seamless(?:ly)?/gi, label: 'מילת יתר AI', weight: 2 },
    { pattern: /leverage(?:d|s|ing)?/gi, label: 'מילת יתר AI', weight: 2 },
    { pattern: /harness(?:ing)? the power/gi, label: 'קלישאת AI', weight: 4 },
  ];

  // Hebrew AI patterns
  const hePatterns = [
    { pattern: /כבינה מלאכותית/gi, label: 'התייחסות עצמית AI בעברית', weight: 8 },
    { pattern: /מדריך מקיף/gi, label: 'כותרת גנרית AI בעברית', weight: 4 },
    { pattern: /חשוב לציין ש/gi, label: 'ניסוח שכיח AI בעברית', weight: 5 },
    { pattern: /לסיכום,?\s/gi, label: 'דפוס סיכום נוסחתי בעברית', weight: 3 },
    { pattern: /בעידן ה(?:דיגיטלי|מודרני|נוכחי)/gi, label: 'פתיחה גנרית AI בעברית', weight: 5 },
  ];

  for (const { pattern, label, weight } of [...enPatterns, ...hePatterns]) {
    const matches = bodyText.match(pattern);
    if (matches) {
      signals.push({ type: 'content', label, count: matches.length, severity: weight >= 5 ? 'warning' : 'info' });
      aiScore += matches.length * weight;
    }
  }

  // Paragraph uniformity
  if (paragraphs.length > 5) {
    const avgLen = paragraphs.reduce((s, p) => s + p.length, 0) / paragraphs.length;
    const variance = paragraphs.reduce((s, p) => s + Math.pow(p.length - avgLen, 2), 0) / paragraphs.length;
    const cv = Math.sqrt(variance) / (avgLen || 1);
    if (cv < 0.25) {
      signals.push({ type: 'structure', label: 'אורך פסקאות אחיד מאוד (סימן לתוכן AI)', count: null, severity: 'warning' });
      aiScore += 12;
    }
  }

  // Sentence starter repetition
  const sentences = bodyText.split(/[.!?]\s+/).filter(s => s.length > 20);
  if (sentences.length > 10) {
    const starters = {};
    sentences.forEach(s => {
      const first = s.trim().split(/\s+/).slice(0, 2).join(' ').toLowerCase();
      starters[first] = (starters[first] || 0) + 1;
    });
    const maxRepeat = Math.max(...Object.values(starters));
    const repeatRatio = maxRepeat / sentences.length;
    if (repeatRatio > 0.15 && maxRepeat >= 3) {
      signals.push({ type: 'structure', label: `חזרתיות גבוהה בפתיחות משפטים (${maxRepeat}/${sentences.length})`, count: maxRepeat, severity: 'warning' });
      aiScore += 10;
    }
  }

  // Generator meta
  const generator = $('meta[name="generator"]').attr('content') || '';
  if (/ai|gpt|claude|gemini|copilot|jasper|writesonic/i.test(generator)) {
    signals.push({ type: 'meta', label: `מחולל AI זוהה: ${generator}`, count: null, severity: 'warning' });
    aiScore += 15;
  }

  // AI widgets
  const chatSelectors = ['[class*="chatbot"]', '[id*="chatbot"]', '[class*="ai-chat"]', '[id*="ai-widget"]', '[class*="chat-widget"]'];
  for (const sel of chatSelectors) {
    if ($(sel).length) {
      signals.push({ type: 'widget', label: `ווידג\'ט צ\'אט AI: ${sel}`, count: null, severity: 'info' });
      aiScore += 3;
    }
  }

  // Excessive headings
  const h2Count = $('h2').length;
  if (h2Count > 10) {
    signals.push({ type: 'structure', label: `${h2Count} תגיות H2 — מספר מוגזם, שכיח בתוכן AI`, count: h2Count, severity: 'warning' });
    aiScore += 8;
  }

  // List heavy (AI loves lists)
  const lists = $('ul, ol').length;
  if (lists > 8 && paragraphs.length > 0 && lists / paragraphs.length > 0.5) {
    signals.push({ type: 'structure', label: `יחס רשימות/פסקאות גבוה (${lists}/${paragraphs.length})`, count: null, severity: 'info' });
    aiScore += 5;
  }

  aiScore = Math.min(aiScore, 100);

  return {
    score: aiScore,
    level: aiScore < 15 ? 'low' : aiScore < 40 ? 'medium' : 'high',
    signals,
    totalSignals: signals.length,
  };
}

/* ── Score computation ── */
function computeScores(data) {
  const checks = [];

  // Title
  if (!data.title) checks.push({ cat: 'meta', name: 'תגית כותרת', score: 0, max: 10, tip: 'הוסף תגית title לדף' });
  else if (data.title.length < 30) checks.push({ cat: 'meta', name: 'תגית כותרת', score: 5, max: 10, tip: `הכותרת קצרה מדי (${data.title.length} תווים, מומלץ 30-60)` });
  else if (data.title.length > 60) checks.push({ cat: 'meta', name: 'תגית כותרת', score: 7, max: 10, tip: `הכותרת ארוכה מדי (${data.title.length} תווים, מומלץ עד 60)` });
  else checks.push({ cat: 'meta', name: 'תגית כותרת', score: 10, max: 10, tip: `אורך כותרת תקין (${data.title.length} תווים)` });

  // Description
  if (!data.metaDescription) checks.push({ cat: 'meta', name: 'תיאור מטא', score: 0, max: 10, tip: 'הוסף meta description' });
  else if (data.metaDescription.length < 120) checks.push({ cat: 'meta', name: 'תיאור מטא', score: 5, max: 10, tip: `תיאור קצר מדי (${data.metaDescription.length} תווים, מומלץ 120-160)` });
  else if (data.metaDescription.length > 160) checks.push({ cat: 'meta', name: 'תיאור מטא', score: 7, max: 10, tip: `תיאור ארוך מדי (${data.metaDescription.length} תווים, מומלץ עד 160)` });
  else checks.push({ cat: 'meta', name: 'תיאור מטא', score: 10, max: 10, tip: `אורך תיאור תקין (${data.metaDescription.length} תווים)` });

  // Canonical
  checks.push({ cat: 'meta', name: 'כתובת קנונית', score: data.canonical ? 8 : 0, max: 8, tip: data.canonical ? 'Canonical URL מוגדר' : 'הוסף כתובת canonical' });

  // Viewport
  checks.push({ cat: 'technical', name: 'תגית Viewport', score: data.viewport ? 5 : 0, max: 5, tip: data.viewport ? 'Viewport מוגדר למובייל' : 'הוסף viewport meta למובייל' });

  // Language
  checks.push({ cat: 'technical', name: 'שפת הדף', score: data.lang ? 5 : 0, max: 5, tip: data.lang ? `שפה: ${data.lang}` : 'הוסף lang ב-<html>' });

  // HTTPS
  checks.push({ cat: 'security', name: 'HTTPS', score: data.isHttps ? 10 : 0, max: 10, tip: data.isHttps ? 'האתר משתמש ב-HTTPS' : 'העבר את האתר ל-HTTPS' });

  // H1
  const h1Count = data.headings.h1.count;
  if (h1Count === 1) checks.push({ cat: 'content', name: 'כותרת H1', score: 10, max: 10, tip: 'תגית H1 יחידה — מצוין' });
  else if (h1Count === 0) checks.push({ cat: 'content', name: 'כותרת H1', score: 0, max: 10, tip: 'לא נמצאה תגית H1' });
  else checks.push({ cat: 'content', name: 'כותרת H1', score: 5, max: 10, tip: `${h1Count} תגיות H1 — השתמש רק באחת` });

  // Images
  const imgScore = data.images.total === 0 ? 8 : Math.round((data.images.withAlt / data.images.total) * 8);
  checks.push({ cat: 'content', name: 'טקסט חלופי לתמונות', score: imgScore, max: 8,
    tip: data.images.total === 0 ? 'אין תמונות בדף' : data.images.withoutAlt > 0 ? `${data.images.withoutAlt} תמונות ללא alt` : 'כל התמונות עם טקסט חלופי' });

  // Structured data
  checks.push({ cat: 'technical', name: 'נתונים מובנים', score: data.structuredData.length > 0 ? 7 : 0, max: 7,
    tip: data.structuredData.length > 0 ? `נמצא: ${data.structuredData.map(s => s.type || s).join(', ')}` : 'הוסף נתונים מובנים (JSON-LD)' });

  // Open Graph
  const ogLen = Object.keys(data.og).length;
  const ogScore = ogLen >= 4 ? 7 : ogLen >= 2 ? 5 : ogLen > 0 ? 3 : 0;
  checks.push({ cat: 'social', name: 'תגיות Open Graph', score: ogScore, max: 7, tip: ogScore >= 7 ? 'כיסוי OG טוב' : 'הוסף תגיות Open Graph' });

  // Twitter
  const twLen = Object.keys(data.twitter).length;
  const twScore = twLen >= 3 ? 5 : twLen > 0 ? 3 : 0;
  checks.push({ cat: 'social', name: 'תגיות Twitter Card', score: twScore, max: 5, tip: twScore >= 5 ? 'Twitter Card תקין' : 'הוסף תגיות Twitter Card' });

  // HTML size
  const sizeScore = data.htmlSize < 100000 ? 5 : data.htmlSize < 500000 ? 3 : 0;
  checks.push({ cat: 'performance', name: 'גודל HTML', score: sizeScore, max: 5, tip: `${Math.round(data.htmlSize / 1024)} KB` });

  // Word count
  const wcScore = data.wordCount > 300 ? 5 : data.wordCount > 100 ? 3 : 0;
  checks.push({ cat: 'content', name: 'כמות תוכן', score: wcScore, max: 5, tip: `${data.wordCount} מילים` });

  // HSTS
  checks.push({ cat: 'security', name: 'HSTS', score: data.hsts ? 5 : 0, max: 5, tip: data.hsts ? 'HSTS מופעל' : 'הפעל HSTS' });

  // Accessibility
  const accScore = data.accessibility.score >= 80 ? 5 : data.accessibility.score >= 50 ? 3 : 1;
  checks.push({ cat: 'accessibility', name: 'נגישות בסיסית', score: accScore, max: 5, tip: `ציון נגישות: ${data.accessibility.score}` });

  const totalScore = checks.reduce((s, c) => s + c.score, 0);
  const maxScore = checks.reduce((s, c) => s + c.max, 0);
  const percentage = Math.round((totalScore / maxScore) * 100);

  // Category scores
  const categories = {};
  for (const c of checks) {
    if (!categories[c.cat]) categories[c.cat] = { score: 0, max: 0 };
    categories[c.cat].score += c.score;
    categories[c.cat].max += c.max;
  }

  return { total: totalScore, max: maxScore, percentage, checks, categories };
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`SEO AI Analyzer running at http://localhost:${PORT}`);
});
