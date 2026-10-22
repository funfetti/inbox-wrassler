/**
 * Inbox Wrassler: a Gmail sidebar add-on.
 *
 * - Landing page (no email open): your top 20 sender domains in the inbox,
 *   when the numbers were last updated, and a Refresh button.
 * - Open an email: how many inbox conversations are from the sender's domain
 *   (subdomains included), the subdomains seen, and a button to show them.
 * - Every card ends with your favorite labels and how many of their
 *   conversations are still in your inbox.
 *
 * The slow counting happens in a snapshot that's saved once a day (and when
 * you press Refresh), so the sidebar mostly just reads saved numbers.
 * It only reads From headers and counts. It never reads message bodies and
 * never changes anything in Gmail.
 */

const SAMPLE_SIZE = 500;     // newest inbox emails read to find candidate domains
const CANDIDATES = 40;       // domains that get an exact count
const TOP_N = 20;            // domains shown on the landing page
const FETCH_BATCH = 50;      // Gmail requests sent at once
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';

// Gmail's inbox tabs, offered alongside your own labels.
const CATEGORIES = [
  { id: 'CATEGORY_PROMOTIONS', name: 'Promotions tab', search: 'category:promotions' },
  { id: 'CATEGORY_SOCIAL', name: 'Social tab', search: 'category:social' },
  { id: 'CATEGORY_UPDATES', name: 'Updates tab', search: 'category:updates' },
  { id: 'CATEGORY_FORUMS', name: 'Forums tab', search: 'category:forums' },
];

// ---------------------------------------------------------------- cards

// Shown when the sidebar is open but no email is open.
function onHomepage(e) {
  return buildHomeCard();
}

// Runs every time an email is opened.
function onGmailMessageOpen(e) {
  try {
    const senderDomain = getDomain(getFrom(e.gmail.messageId));
    if (!senderDomain) {
      return [messageCard('Couldn\'t read the sender\'s address.')];
    }
    const domain = getBaseDomain(senderDomain);
    const count = countThreads({ q: searchQuery(domain) });
    const snapshot = loadJson('snapshot');
    const subdomains = new Set((snapshot && snapshot.subs[domain]) || []);
    subdomains.add(senderDomain);
    return [buildEmailCard(domain, senderDomain, count, Array.from(subdomains).sort(), snapshot)];
  } catch (err) {
    console.error(err);
    return [messageCard('Something went wrong: ' + err.message)];
  }
}

function buildHomeCard() {
  const snapshot = loadJson('snapshot');
  const card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Inbox Wrassler'));

  const top = CardService.newCardSection().setHeader('Top senders in your inbox');
  if (snapshot && snapshot.top.length) {
    snapshot.top.forEach(d => {
      top.addWidget(CardService.newDecoratedText()
        .setText('<b>' + d.count + '</b>  ' + d.domain)
        .setOpenLink(searchLink(searchQuery(d.domain))));
    });
  } else {
    top.addWidget(CardService.newTextParagraph()
      .setText('No numbers yet. Press Refresh to count your inbox.'));
  }
  card.addSection(top);

  const controls = CardService.newCardSection();
  if (snapshot) {
    controls.addWidget(CardService.newTextParagraph()
      .setText('<i>Updated ' + timeAgo(snapshot.updated) + '</i>'));
  }
  controls.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton()
      .setText('Refresh')
      .setOnClickAction(CardService.newAction().setFunctionName('onRefresh')))
    .addButton(CardService.newTextButton()
      .setText('Pick favorites')
      .setOnClickAction(CardService.newAction().setFunctionName('onOpenSettings'))));
  card.addSection(controls);

  addFavoritesSection(card, snapshot);
  return card.build();
}

function buildEmailCard(domain, senderDomain, count, subdomains, snapshot) {
  const noun = count === 1 ? 'conversation' : 'conversations';
  const section = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph()
      .setText('<b>' + count + '</b> ' + noun + ' from <b>' + domain + '</b> in your inbox, including subdomains'))
    .addWidget(CardService.newTextButton()
      .setText('Show them')
      .setOpenLink(searchLink(searchQuery(domain))));

  if (senderDomain !== domain) {
    section.addWidget(CardService.newTextParagraph()
      .setText('This email came from ' + senderDomain + '.'));
  }

  const card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle(domain))
    .addSection(section)
    .addSection(CardService.newCardSection()
      .setHeader('Domains covered')
      .addWidget(CardService.newTextParagraph().setText(subdomains.join('<br>'))));

  addFavoritesSection(card, snapshot);
  return card.build();
}

// Adds "Favorites" to the bottom of a card, using the saved counts.
function addFavoritesSection(card, snapshot) {
  const favorites = loadJson('favorites') || [];
  if (!favorites.length) return;
  const counts = {};
  ((snapshot && snapshot.labels) || []).forEach(l => counts[l.id] = l.count);

  const section = CardService.newCardSection().setHeader('Favorites (in inbox)');
  favorites.forEach(f => {
    const count = f.id in counts ? counts[f.id] : '–';
    section.addWidget(CardService.newDecoratedText()
      .setText('<b>' + count + '</b>  ' + f.name)
      .setOpenLink(searchLink('in:inbox ' + labelSearch(f))));
  });
  card.addSection(section);
}

function buildSettingsCard() {
  const chosen = new Set((loadJson('favorites') || []).map(f => f.id));
  const input = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('favorites')
    .setTitle('Show these at the bottom of every card');
  allLabels().forEach(l => input.addItem(l.name, l.id, chosen.has(l.id)));

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Favorite labels'))
    .addSection(CardService.newCardSection()
      .addWidget(input)
      .addWidget(CardService.newTextButton()
        .setText('Save')
        .setOnClickAction(CardService.newAction().setFunctionName('onSaveSettings'))))
    .build();
}

function messageCard(text) {
  return CardService.newCardBuilder()
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(text)))
    .build();
}

// ---------------------------------------------------------------- buttons

function onRefresh(e) {
  buildSnapshot();
  return updateCard(buildHomeCard());
}

function onOpenSettings(e) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(buildSettingsCard()))
    .build();
}

function onSaveSettings(e) {
  const input = e.commonEventObject.formInputs && e.commonEventObject.formInputs.favorites;
  const ids = new Set(input ? input.stringInputs.value : []);
  saveJson('favorites', allLabels().filter(l => ids.has(l.id)));

  // Label counts are quick, so update just those instead of a full refresh.
  const snapshot = loadJson('snapshot');
  if (snapshot) {
    snapshot.labels = countFavoriteLabels();
    saveJson('snapshot', snapshot);
  }
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().popToRoot().updateCard(buildHomeCard()))
    .build();
}

function updateCard(card) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(card))
    .build();
}

// ---------------------------------------------------------------- snapshot

// Run this once from the script editor. It sets up the daily update (6am)
// and makes the first snapshot.
function setUpDailyUpdate() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyUpdate')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyUpdate').timeBased().everyDays(1).atHour(6).create();
  buildSnapshot();
  console.log('Daily update set for 6am. First snapshot saved.');
}

function dailyUpdate() {
  buildSnapshot();
}

// Finds the top domains in the inbox and saves them with subdomains and
// favorite label counts.
//  1. Read the senders of the newest inbox emails to find candidate domains.
//  2. Get an exact conversation count for the most common candidates.
function buildSnapshot() {
  const me = Gmail.Users.getProfile('me').emailAddress.toLowerCase();
  const messages = listInboxMessages(SAMPLE_SIZE);
  const responses = gmailFetchAll(messages.map(m =>
    'messages/' + m.id + '?format=metadata&metadataHeaders=From&fields=payload/headers'));

  const sample = {};   // base domain -> {threads: Set, subs: Set}
  responses.forEach((r, i) => {
    if (!r) return;
    const header = (r.payload.headers || []).find(h => h.name.toLowerCase() === 'from');
    const from = header ? header.value : '';
    if (from.toLowerCase().indexOf(me) !== -1) return;   // skip your own replies
    const sub = getDomain(from);
    if (!sub) return;
    const base = getBaseDomain(sub);
    sample[base] = sample[base] || { threads: new Set(), subs: new Set() };
    sample[base].threads.add(messages[i].threadId);
    sample[base].subs.add(sub);
  });

  const candidates = Object.keys(sample)
    .sort((a, b) => sample[b].threads.size - sample[a].threads.size)
    .slice(0, CANDIDATES);
  const counts = countThreadsMany(candidates.map(d => ({ q: searchQuery(d) })));
  const top = candidates
    .map((domain, i) => ({ domain: domain, count: counts[i] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N);

  const subs = {};
  Object.keys(sample).forEach(d => subs[d] = Array.from(sample[d].subs).sort());

  saveJson('snapshot', {
    updated: Date.now(),
    top: top,
    subs: subs,
    labels: countFavoriteLabels(),
  });
}

function countFavoriteLabels() {
  const favorites = loadJson('favorites') || [];
  const counts = countThreadsMany(favorites.map(f => ({ labelIds: ['INBOX', f.id] })));
  return favorites.map((f, i) => ({ id: f.id, count: counts[i] }));
}

// Newest inbox emails as [{id, threadId}].
function listInboxMessages(limit) {
  const messages = [];
  let pageToken;
  do {
    const page = Gmail.Users.Messages.list('me', {
      q: 'in:inbox',
      maxResults: Math.min(500, limit - messages.length),
      pageToken: pageToken,
      fields: 'messages(id,threadId),nextPageToken',
    });
    (page.messages || []).forEach(m => messages.push(m));
    pageToken = page.nextPageToken;
  } while (pageToken && messages.length < limit);
  return messages;
}

// ---------------------------------------------------------------- Gmail helpers

// Returns the From header of a message, e.g. "Target <deals@target.com>".
function getFrom(messageId) {
  const msg = Gmail.Users.Messages.get('me', messageId, {
    format: 'metadata',
    metadataHeaders: ['From'],
  });
  const header = (msg.payload.headers || []).find(h => h.name.toLowerCase() === 'from');
  return header ? header.value : '';
}

// Counts conversations matching {q} or {labelIds}, 500 at a time.
function countThreads(params) {
  return countThreadsMany([params])[0];
}

// Same as countThreads, but sends all the first requests at once.
function countThreadsMany(paramsList) {
  const paths = paramsList.map(threadListPath);
  const pages = gmailFetchAll(paths);
  return pages.map((page, i) => {
    let count = 0;
    while (page) {
      count += (page.threads || []).length;
      page = page.nextPageToken
        ? gmailFetchAll([paths[i] + '&pageToken=' + encodeURIComponent(page.nextPageToken)])[0]
        : null;
    }
    return count;
  });
}

function threadListPath(params) {
  let path = 'threads?maxResults=500&fields=' + encodeURIComponent('threads/id,nextPageToken');
  if (params.q) path += '&q=' + encodeURIComponent(params.q);
  (params.labelIds || []).forEach(id => path += '&labelIds=' + encodeURIComponent(id));
  return path;
}

// Sends Gmail API requests in parallel batches and returns the parsed
// responses in the same order (null for any that failed). Requests Gmail
// turns away for going too fast are retried after a short pause.
function gmailFetchAll(paths) {
  const token = ScriptApp.getOAuthToken();
  const results = new Array(paths.length).fill(null);
  let todo = paths.map((p, i) => i);
  for (let attempt = 0; attempt < 3 && todo.length; attempt++) {
    if (attempt) Utilities.sleep(1000 * attempt);
    const retry = [];
    for (let start = 0; start < todo.length; start += FETCH_BATCH) {
      const batch = todo.slice(start, start + FETCH_BATCH);
      const responses = UrlFetchApp.fetchAll(batch.map(i => ({
        url: API + paths[i],
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true,
      })));
      responses.forEach((r, k) => {
        const code = r.getResponseCode();
        if (code === 200) results[batch[k]] = JSON.parse(r.getContentText());
        else if (code === 429 || code >= 500) retry.push(batch[k]);
        else console.warn('Gmail request failed (' + code + '): ' + paths[batch[k]]);
      });
    }
    todo = retry;
  }
  return results;
}

// Your own labels plus the inbox tabs, as [{id, name}].
function allLabels() {
  const own = (Gmail.Users.Labels.list('me').labels || [])
    .filter(l => l.type === 'user')
    .map(l => ({ id: l.id, name: l.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return CATEGORIES.map(c => ({ id: c.id, name: c.name })).concat(own);
}

// Gmail search for a label: "Presale Codes" -> label:presale-codes
function labelSearch(label) {
  const category = CATEGORIES.find(c => c.id === label.id);
  if (category) return category.search;
  return 'label:' + label.name.toLowerCase().replace(/[\s\/]+/g, '-');
}

// ---------------------------------------------------------------- domains

// "Target <deals@target.com>" -> "target.com"
function getDomain(from) {
  const bracketed = from.match(/<([^>]+)>/);
  const address = (bracketed ? bracketed[1] : from).trim();
  const at = address.lastIndexOf('@');
  if (at === -1) return '';
  return address.slice(at + 1).trim().toLowerCase();
}

// Endings where the real domain is three parts, e.g. target.co.uk.
const TWO_PART_ENDINGS = [
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.kr', 'co.in',
  'com.br', 'com.mx', 'com.cn', 'com.sg', 'com.hk', 'co.za',
];

// "email.target.com" -> "target.com", "news.target.co.uk" -> "target.co.uk"
function getBaseDomain(domain) {
  const parts = domain.split('.');
  const lastTwo = parts.slice(-2).join('.');
  const keep = TWO_PART_ENDINGS.includes(lastTwo) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

// Without the @, Gmail matches the domain and any subdomain of it.
function searchQuery(domain) {
  return 'in:inbox from:' + domain;
}

// Opens a Gmail search in a new tab.
function searchLink(query) {
  return CardService.newOpenLink()
    .setUrl('https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(query))
    .setOpenAs(CardService.OpenAs.FULL_SIZE);
}

// ---------------------------------------------------------------- storage

// Built-in storage allows about 9 KB per entry, so longer values are split
// across several entries.
const CHUNK = 4000;

function saveJson(key, value) {
  const text = JSON.stringify(value);
  const parts = {};
  const n = Math.max(1, Math.ceil(text.length / CHUNK));
  for (let i = 0; i < n; i++) parts[key + '_' + i] = text.slice(i * CHUNK, (i + 1) * CHUNK);
  parts[key + '_n'] = String(n);
  PropertiesService.getUserProperties().setProperties(parts);
}

function loadJson(key) {
  const props = PropertiesService.getUserProperties().getProperties();
  const n = Number(props[key + '_n'] || 0);
  if (!n) return null;
  let text = '';
  for (let i = 0; i < n; i++) text += props[key + '_' + i] || '';
  return JSON.parse(text);
}

// 1700000000000 -> "3 hours ago"
function timeAgo(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hours / 24);
  return days + (days === 1 ? ' day ago' : ' days ago');
}
