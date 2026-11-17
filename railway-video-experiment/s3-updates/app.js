// sinning: chat + games. The pages live on Amazon S3, and Firebase stores accounts and messages.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  deleteUser, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy,
  limit, onSnapshot, serverTimestamp, writeBatch, increment, deleteField, Timestamp, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig, ADMIN_USER, VIDEOS_URL, VIDEO_PROXY_URL } from './config.js';

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

/* ---------- tiny helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ic');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayKey = (ts) => new Date(ts).toDateString();
function fmtDay(ts) {
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return 'Today';
  if (d.toDateString() === new Date(Date.now() - 864e5).toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
const fmtWhen = (ts) =>
  dayKey(ts) === dayKey(Date.now()) ? fmtTime(ts) : new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });

// turn Firebase's error codes into plain words
function niceError(err) {
  const code = (err && err.code) || '';
  const map = {
    'auth/invalid-credential': 'Wrong username or password.',
    'auth/wrong-password': 'Wrong password.',
    'auth/user-not-found': 'Wrong username or password.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/too-many-requests': 'Too many tries. Wait a minute and try again.',
    'auth/network-request-failed': 'No connection. Try again.',
    'auth/operation-not-allowed': 'Email/Password sign-in is not turned on in Firebase yet.',
    'permission-denied': 'Not allowed. (Did you paste the rules into Firebase?)',
    'unavailable': 'No connection. Try again.',
  };
  return map[code] || (err && err.userMessage) || (err && err.message) || 'Something went wrong.';
}
const fail = (msg) => Object.assign(new Error(msg), { userMessage: msg });

const prefs = { sound: true, notify: false };
try { Object.assign(prefs, JSON.parse(store.get('prefs') || '{}')); } catch {}
const savePrefs = () => store.set('prefs', JSON.stringify(prefs));

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function confirmBox(text, yesLabel) {
  return new Promise((resolve) => {
    $('#modal-text').textContent = text;
    $('#modal-yes').textContent = yesLabel || 'Confirm';
    $('#modal').classList.remove('hidden');
    const done = (v) => {
      $('#modal').classList.add('hidden');
      $('#modal-yes').onclick = $('#modal-no').onclick = $('#modal').onclick = null;
      resolve(v);
    };
    $('#modal-yes').onclick = () => done(true);
    $('#modal-no').onclick = () => done(false);
    $('#modal').onclick = (e) => e.target.id === 'modal' && done(false);
  });
}

// shrink a picture so it fits inside a Firestore document
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(fail('That image could not be opened.')); };
    img.src = url;
  });
}
const readAsDataURL = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(fail('That image could not be read.'));
  r.readAsDataURL(file);
});
async function shrink(file, maxDim, maxChars) {
  if (!file.type.startsWith('image/')) throw fail('Only pictures can be sent.');
  // small GIFs are kept as they are so they still move
  if (file.type === 'image/gif' && file.size * 1.37 < maxChars) return readAsDataURL(file);
  const img = await loadImage(file);
  let dim = maxDim;
  for (let i = 0; i < 8; i++) {
    const scale = Math.min(1, dim / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.82, 0.7, 0.55]) {
      const out = c.toDataURL('image/jpeg', q);
      if (out.length <= maxChars) return out;
    }
    dim = Math.round(dim * 0.75);
  }
  throw fail('That image is too big.');
}

/* ---------- state ---------- */
const NAME_RE = /^[a-z0-9_.]{3,20}$/;
const PAGE = 50;
const ONLINE_MS = 150_000;
let me = null; // { id, username, avatar, banner, created, newsRead, email }
let view = 'home';
let booted = false;
const users = new Map(); // uid -> public profile
const userSubs = new Map(); // uid -> unsubscribe
const chats = new Map(); // chat id -> chat
const reqIn = new Map(); // uid -> request doc
const reqOut = new Map();
let subs = []; // listeners to stop on log out
let activeId = null;
let msgs = [];
let msgUnsub = null;
let msgLimit = PAGE;
let hasMore = false;
let replyTo = null;
let editing = null;
let jumpCount = 0;
let unreadTotal = 0;

const QUICK = ['👍', '❤️', '😂', '🔥', '💀'];
const EMOJI = ('😀 😁 😂 🤣 😅 😊 😇 🙂 😉 😍 😘 😋 😜 🤪 😎 🤩 🥳 😏 😒 🙄 😬 😴 🤤 😷 🤒 🤕 🤢 🤮 🥵 🥶 😵 🤯 🤠 😢 😭 😤 😡 🤬 😱 😨 😰 😳 🥺 🤔 🤫 🤭 🫡 🫠 😈 👿 💀 👻 👽 🤖 💩 🤡 ' +
  '👍 👎 👏 🙌 🙏 🤝 👊 ✊ 🤞 ✌️ 🤘 👌 🤌 👀 🫶 💪 👋 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💯 💢 💥 💫 💤 🔥 ✨ ⭐ 🌙 ⚡ ☠️ 🎉 🎁 🎮 🎧 🎵 🏆 💰 💸 🍕 🍔 🍟 ☕ 🚀 ✅ ❌ ❓ ❗').split(' ');

const isAdmin = () => !!me && me.username === ADMIN_USER;
const chatRef = (id) => doc(db, 'chats', id);
const msgCol = (id) => collection(db, 'chats', id, 'messages');
const dmId = (a, b) => [a, b].sort().join('_');
const otherOf = (c) => (c.members || []).find((x) => x !== me.id);
const isOnline = (u) => !!u && Date.now() - (u.lastSeen || 0) < ONLINE_MS;

/* ---------- auth ---------- */
let mode = 'login';
document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    mode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#auth-submit').textContent = mode === 'login' ? 'Enter' : 'Create account';
    $('#auth-error').textContent = '';
  })
);

let signingUp = false;
async function register(username, password) {
  if (!NAME_RE.test(username)) throw fail('Username must be 3-20 characters: letters, numbers, _ or .');
  if (password.length < 6) throw fail('Password must be at least 6 characters.');
  if ((await getDoc(doc(db, 'usernames', username))).exists()) throw fail('That username is taken.');
  const email = username.replace(/\./g, '-') + '-' + Math.random().toString(36).slice(2, 8) + '@users.sinning.chat';
  signingUp = true;
  let cred;
  try {
    cred = await createUserWithEmailAndPassword(auth, email, password);
  } catch (err) {
    signingUp = false;
    throw err;
  }
  const profile = { username, created: Date.now(), lastSeen: Date.now(), avatar: null, banner: null, newsRead: 0 };
  try {
    const b = writeBatch(db);
    b.set(doc(db, 'usernames', username), { uid: cred.user.uid, email });
    b.set(doc(db, 'users', cred.user.uid), profile);
    await b.commit();
  } catch (err) {
    signingUp = false;
    await deleteUser(cred.user).catch(() => signOut(auth));
    throw err.code === 'permission-denied' ? fail('That username is taken, or the Firebase rules are missing.') : err;
  }
  signingUp = false;
  boot(cred.user, profile);
}
async function login(username, password) {
  const snap = await getDoc(doc(db, 'usernames', username));
  if (!snap.exists()) throw fail('Wrong username or password.');
  await signInWithEmailAndPassword(auth, snap.data().email, password);
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#auth-submit');
  btn.disabled = true;
  const username = $('#auth-user').value.trim().toLowerCase();
  const password = $('#auth-pass').value;
  $('#auth-pass').value = '';
  try {
    if (mode === 'login') await login(username, password);
    else await register(username, password);
  } catch (err) {
    $('#auth-error').textContent = niceError(err);
    const f = $('#auth-form');
    f.classList.remove('shake');
    void f.offsetWidth;
    f.classList.add('shake');
  } finally {
    btn.disabled = false;
  }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) return showAuth();
  if (signingUp) return; // register() finishes the job
  let snap;
  try {
    snap = await getDoc(doc(db, 'users', user.uid));
  } catch (err) {
    $('#auth-error').textContent = niceError(err);
    return showAuth();
  }
  if (!snap.exists()) {
    // a sign-up that did not finish; wait a moment in case it is still saving
    await new Promise((r) => setTimeout(r, 1500));
    snap = await getDoc(doc(db, 'users', user.uid)).catch(() => null);
    if (!snap || !snap.exists()) {
      await signOut(auth);
      return showAuth();
    }
  }
  boot(user, snap.data());
});

function showAuth() {
  stopAll();
  me = null;
  $('#shell').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  document.body.classList.remove('calm');
}

function stopAll() {
  subs.forEach((u) => u());
  subs = [];
  for (const u of userSubs.values()) u();
  userSubs.clear();
  if (msgUnsub) msgUnsub();
  msgUnsub = null;
  chats.clear();
  reqIn.clear();
  reqOut.clear();
}

/* ---------- boot ---------- */
function boot(user, data) {
  stopAll();
  me = { id: user.uid, email: user.email, ...data };
  users.set(me.id, me);
  $('#auth').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  if (!booted) {
    booted = true;
    let v = 'home';
    try { v = sessionStorage.getItem('view') || 'home'; } catch {}
    go(['home', 'chat', 'games'].includes(v) ? v : 'home');
  }
  renderMe();
  renderRequests();
  renderFriends();
  closeChat();

  // my own profile
  subs.push(onSnapshot(doc(db, 'users', me.id), (s) => {
    if (!s.exists()) return;
    Object.assign(me, s.data());
    users.set(me.id, me);
    renderMe();
    renderFriends();
  }));
  // every chat I am in
  let firstChats = true;
  subs.push(onSnapshot(query(collection(db, 'chats'), where('members', 'array-contains', me.id)), (snap) => {
    for (const ch of snap.docChanges()) {
      const id = ch.doc.id;
      if (ch.type === 'removed') {
        chats.delete(id);
        if (id === activeId) closeChat();
        continue;
      }
      const prev = chats.get(id);
      const c = { id, ...ch.doc.data() };
      chats.set(id, c);
      watchMembers(c);
      if (!firstChats && prev && (c.n || 0) > (prev.n || 0) && c.last && c.last.from !== me.id) incoming(c);
      if (id === activeId) {
        renderHead();
        updateSeen();
        showTyping();
        if (lookingAt(id)) markRead(c);
      }
    }
    firstChats = false;
    renderFriends();
  }, (err) => toast(niceError(err))));
  // the news channel
  let firstNews = true;
  subs.push(onSnapshot(chatRef('news'), (s) => {
    if (!s.exists()) {
      chats.delete('news');
      if (isAdmin()) setDoc(chatRef('news'), { type: 'news', name: 'News', n: 0, last: null, created: Date.now() }).catch(() => {});
    } else {
      const prev = chats.get('news');
      const c = { id: 'news', ...s.data() };
      chats.set('news', c);
      if (!firstNews && prev && (c.n || 0) > (prev.n || 0) && !isAdmin()) incoming(c);
      if (activeId === 'news') {
        renderHead();
        if (lookingAt('news')) markRead(c);
      }
    }
    firstNews = false;
    renderFriends();
  }, () => {}));
  // friend requests
  subs.push(onSnapshot(query(collection(db, 'requests'), where('to', '==', me.id)), (snap) => {
    reqIn.clear();
    snap.forEach((d) => { reqIn.set(d.data().from, d.data()); watchUser(d.data().from); });
    renderRequests();
    renderFriends();
  }, () => {}));
  subs.push(onSnapshot(query(collection(db, 'requests'), where('from', '==', me.id)), (snap) => {
    reqOut.clear();
    snap.forEach((d) => { reqOut.set(d.data().to, d.data()); watchUser(d.data().to); });
    renderRequests();
  }, () => {}));

  heartbeat();
}

// keep "online" fresh
let beatTimer;
function heartbeat() {
  clearInterval(beatTimer);
  const beat = () => me && updateDoc(doc(db, 'users', me.id), { lastSeen: Date.now() }).catch(() => {});
  beat();
  beatTimer = setInterval(beat, 60_000);
}
setInterval(() => {
  if (!me) return;
  renderFriends();
  if (activeId) renderHead();
}, 30_000);

function watchUser(uid) {
  if (!uid || uid === me.id || userSubs.has(uid)) return;
  userSubs.set(uid, onSnapshot(doc(db, 'users', uid), (s) => {
    if (s.exists()) users.set(uid, { id: uid, ...s.data() });
    renderFriends();
    renderRequests();
    if (activeId) {
      const c = chats.get(activeId);
      if (c && (c.members || []).includes(uid)) {
        renderHead();
        renderMsgs();
      }
    }
  }, () => {}));
}
function watchMembers(c) {
  for (const uid of c.members || []) watchUser(uid);
}

/* ---------- people + chat labels ---------- */
function avatarEl(user, extra) {
  const a = el('div', { class: 'avatar' + (user.group ? ' group' : '') + (extra ? ' ' + extra : '') });
  if (user.avatar) a.append(el('img', { src: user.avatar, alt: '' }));
  else a.textContent = (user.username || '?')[0];
  return a;
}
const nameOf = (id) => (me && id === me.id ? 'You' : (users.get(id) || {}).username || 'Someone');
function chatInfo(c) {
  if (c.type === 'news') return { title: c.name || 'News', user: { username: 'News' }, news: true };
  if (c.type === 'group') return { title: c.name || 'Group', user: { username: c.name || 'G', group: true }, group: true };
  const u = users.get(otherOf(c)) || { username: '...' };
  return { title: u.username, user: u, online: isOnline(u), uid: u.id };
}
function unreadOf(c) {
  const mine = c.type === 'news' ? me.newsRead || 0 : (c.readN || {})[me.id] || 0;
  return Math.max(0, (c.n || 0) - mine);
}
const cleared = (c) => ((c.cleared || {})[me.id] || 0);
const snippet = (m) => (m.type === 'image' ? 'Image' : m.text || '');
function preview(c) {
  const m = c.last;
  if (!m || (m.at || 0) <= cleared(c)) return c.type === 'group' ? (c.members || []).length + ' members' : 'No messages yet';
  if (m.type === 'sys') return m.text;
  if (c.type === 'news') return snippet(m);
  return (m.from === me.id ? 'You: ' : c.type === 'group' ? nameOf(m.from) + ': ' : '') + snippet(m);
}

function renderMe() {
  if (!me) return;
  showAdmin();
  $('#me-name').textContent = me.username;
  $('#home-name').textContent = me.username;
  $('#me-avatar').replaceChildren(avatarEl(me));
  $('#set-avatar').replaceChildren(avatarEl(me));
  $('#set-pic-remove').classList.toggle('hidden', !me.avatar);
  paintBanner($('#set-banner'), me.banner);
  $('#set-banner-remove').classList.toggle('hidden', !me.banner);
}

function setTitle() {
  document.title = cloakOn() ? CLOAKS[cloak].title : (unreadTotal ? `(${unreadTotal}) ` : '') + 'Study Hall';
}

function renderFriends() {
  if (!me) return;
  const box = $('#friends');
  const when = (c) => Math.max(c.last ? c.last.at || 0 : 0, c.created || 0);
  const list = [...chats.values()].sort(
    (a, b) => (b.type === 'news' ? 1 : 0) - (a.type === 'news' ? 1 : 0) || when(b) - when(a)
  );
  let total = 0;
  for (const c of list) if (c.id !== activeId || view !== 'chat' || document.hidden) total += unreadOf(c);
  unreadTotal = total;
  setTitle();
  const waiting = reqIn.size;
  const people = list.filter((c) => c.type === 'dm');
  const online = people.filter((c) => chatInfo(c).online).length;
  for (const id of ['#nav-badge', '#home-badge']) {
    $(id).classList.toggle('hidden', !(total + waiting));
    $(id).textContent = total + waiting > 99 ? '99+' : String(total + waiting);
  }
  $('#home-chat-sub').textContent = total
    ? total + (total === 1 ? ' unread message' : ' unread messages')
    : people.length ? `${online} of ${people.length} friends online` : 'Add your first friend';
  $('#tile-req-sub').textContent = waiting ? waiting + (waiting === 1 ? ' person wants to add you' : ' people want to add you') : 'Nothing waiting';
  if (!list.length) {
    box.replaceChildren(el('div', { class: 'none', text: 'No friends yet. Send someone a request by their username above.' }));
    return;
  }
  box.replaceChildren(
    ...list.map((c) => {
      const info = chatInfo(c);
      const n = c.id === activeId && view === 'chat' && !document.hidden ? 0 : unreadOf(c);
      const showLast = c.last && (c.last.at || 0) > cleared(c);
      return el(
        'button',
        { class: 'friend' + (info.news ? ' newsrow' : '') + (c.id === activeId ? ' active' : '') + (n ? ' unread' : ''), type: 'button', onclick: () => { go('chat'); openChat(c.id); } },
        info.news ? el('div', { class: 'avatar news' }, icon('news')) : avatarEl(info.user, info.online ? 'online' : ''),
        el('div', { class: 'text' }, el('div', { class: 'name', text: info.title }), el('div', { class: 'sub', text: preview(c) })),
        el('div', { class: 'side' },
          showLast ? el('div', { class: 'when', text: fmtWhen(c.last.at) }) : null,
          n ? el('div', { class: 'badge', text: n > 99 ? '99+' : String(n) }) : null)
      );
    })
  );
}

/* ---------- friend requests ---------- */
const reqDoc = (from, to) => doc(db, 'requests', from + '_' + to);
async function acceptRequest(from) {
  const ids = [from, me.id].sort();
  const b = writeBatch(db);
  b.set(chatRef(dmId(from, me.id)), { type: 'dm', members: ids, n: 0, last: null, readN: {}, created: Date.now() });
  b.delete(reqDoc(from, me.id));
  await b.commit();
}
function renderRequests() {
  if (!me) return;
  $('#req-box').classList.toggle('hidden', !(reqIn.size + reqOut.size));
  const act = (p) => p.catch((e) => toast(niceError(e)));
  const u = (id) => users.get(id) || { id, username: '...' };
  $('#requests').replaceChildren(
    ...[...reqIn.keys()].map((id) =>
      el('div', { class: 'req' }, avatarEl(u(id)),
        el('div', { class: 'text' }, el('div', { class: 'name', text: u(id).username }), el('div', { class: 'sub', text: 'Wants to be friends' })),
        el('button', { class: 'icon-btn yes', type: 'button', title: 'Accept', onclick: () => act(acceptRequest(id)) }, icon('check')),
        el('button', { class: 'icon-btn no', type: 'button', title: 'Decline', onclick: () => act(deleteDoc(reqDoc(id, me.id))) }, icon('x')))),
    ...[...reqOut.keys()].map((id) =>
      el('div', { class: 'req' }, avatarEl(u(id)),
        el('div', { class: 'text' }, el('div', { class: 'name', text: u(id).username }), el('div', { class: 'sub', text: 'Request sent, waiting' })),
        el('button', { class: 'icon-btn no', type: 'button', title: 'Cancel request', onclick: () => act(deleteDoc(reqDoc(me.id, id))) }, icon('x'))))
  );
}

async function addFriend(username) {
  username = username.trim().toLowerCase().replace(/^@/, '');
  if (username === me.username) throw fail("That's you.");
  const snap = await getDoc(doc(db, 'usernames', username));
  if (!snap.exists()) throw fail('Nobody has that username.');
  const them = snap.data().uid;
  if (chats.has(dmId(me.id, them))) throw fail('You are already friends.');
  if (reqIn.has(them)) {
    await acceptRequest(them);
    return 'You and ' + username + ' are now friends.';
  }
  if (reqOut.has(them)) throw fail('Request already sent.');
  await setDoc(reqDoc(me.id, them), { from: me.id, to: them, created: Date.now() });
  return 'Request sent to ' + username + '.';
}

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#add-input');
  const note = $('#add-msg');
  if (!input.value.trim()) return;
  try {
    note.textContent = await addFriend(input.value);
    note.className = 'note';
    input.value = '';
  } catch (err) {
    note.className = 'note bad';
    note.textContent = niceError(err);
  }
  setTimeout(() => (note.textContent = ''), 4000);
});

// delete every message in a chat, a few hundred at a time
async function wipeMessages(id) {
  for (;;) {
    const snap = await getDocs(query(msgCol(id), limit(300)));
    if (snap.empty) return;
    const b = writeBatch(db);
    snap.forEach((d) => b.delete(d.ref));
    await b.commit();
  }
}

$('#remove-friend').addEventListener('click', async () => {
  const c = chats.get(activeId);
  if (!c) return;
  const title = chatInfo(c).title;
  try {
    if (c.type === 'group') {
      if (!(await confirmBox(`Leave ${title}? You will stop getting its messages.`, 'Leave'))) return;
      await postSys(c.id, me.username + ' left');
      await updateDoc(chatRef(c.id), { members: arrayRemove(me.id) });
    } else {
      if (!(await confirmBox(`Remove ${title} from your friends? Your chat with them is deleted too.`, 'Unfriend'))) return;
      const id = c.id;
      closeChat();
      await wipeMessages(id);
      await deleteDoc(chatRef(id));
    }
  } catch (err) {
    toast(niceError(err));
  }
  $('#chat-set').classList.add('hidden');
});

$('#clear-chat').addEventListener('click', async () => {
  const c = chats.get(activeId);
  if (!c) return;
  if (!(await confirmBox(`Delete your chat with ${chatInfo(c).title}? This clears it on your side only.`, 'Delete'))) return;
  $('#chat-set').classList.add('hidden');
  try {
    await updateDoc(chatRef(c.id), { ['cleared.' + me.id]: Date.now(), ['readN.' + me.id]: c.n || 0 });
    openChat(c.id);
  } catch (err) {
    toast(niceError(err));
  }
});

/* ---------- chat ---------- */
const msgBox = $('#msgs');
const pinned = () => msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 120;
function toBottom() {
  msgBox.scrollTop = msgBox.scrollHeight;
  setJump(0);
}
function setJump(n) {
  jumpCount = n;
  $('#jump').classList.toggle('hidden', !n);
  $('#jump').textContent = n === 1 ? '1 new message' : n + ' new messages';
}
$('#jump').addEventListener('click', toBottom);
let wasPinned = true;
msgBox.addEventListener('scroll', () => (wasPinned = pinned()), { passive: true });
if (window.ResizeObserver) new ResizeObserver(() => wasPinned && (msgBox.scrollTop = msgBox.scrollHeight)).observe(msgBox);

const canPost = (c) => c.type !== 'news' || isAdmin();

function renderHead() {
  const c = chats.get(activeId);
  if (!c) return;
  const info = chatInfo(c);
  $('#peer-avatar').replaceChildren(info.news ? el('div', { class: 'avatar news' }, icon('news')) : avatarEl(info.user, info.online ? 'online' : ''));
  $('#peer-name').textContent = info.title;
  const s = $('#peer-status');
  s.textContent = info.news ? (canPost(c) ? 'Announcements / you can post' : 'Announcements / read only')
    : info.group ? (c.members || []).length + ' members' : info.online ? 'Online' : 'Offline';
  s.className = 'sub' + (info.online ? ' online' : '');
  $('#chat-settings').classList.toggle('hidden', !!info.news);
  const ro = !canPost(c);
  $('#composer').classList.toggle('hidden', ro);
  $('#readonly').classList.toggle('hidden', !ro);
  if (ro) clearCtx();
}

function closeChat() {
  if (msgUnsub) msgUnsub();
  msgUnsub = null;
  clearCtx();
  activeId = null;
  msgs = [];
  $('#convo').classList.add('hidden');
  $('#empty').classList.remove('hidden');
  document.body.classList.remove('chat-open');
  renderFriends();
}

function markRead(c) {
  if (!c || !unreadOf(c)) return;
  if (c.type === 'news') {
    me.newsRead = c.n || 0;
    updateDoc(doc(db, 'users', me.id), { newsRead: c.n || 0 }).catch(() => {});
  } else {
    c.readN = { ...(c.readN || {}), [me.id]: c.n || 0 };
    updateDoc(chatRef(c.id), { ['readN.' + me.id]: c.n || 0 }).catch(() => {});
  }
}
const lookingAt = (id) => id === activeId && view === 'chat' && !document.hidden;

function subscribeMsgs(id, keepScroll) {
  if (msgUnsub) msgUnsub();
  const c = chats.get(id);
  const parts = [msgCol(id)];
  if (c && cleared(c)) parts.push(where('created', '>', Timestamp.fromMillis(cleared(c))));
  parts.push(orderBy('created', 'desc'), limit(msgLimit));
  let first = true;
  msgUnsub = onSnapshot(query(...parts), (snap) => {
    if (activeId !== id) return;
    const fresh = new Set();
    let incomingNew = 0;
    if (!first) for (const ch of snap.docChanges()) if (ch.type === 'added') {
      fresh.add(ch.doc.id);
      if (ch.doc.data().from !== me.id) incomingNew++;
    }
    const stick = pinned();
    const prevHeight = msgBox.scrollHeight;
    const prevTop = msgBox.scrollTop;
    msgs = snap.docs.map((d) => {
      const x = d.data({ serverTimestamps: 'estimate' });
      return { id: d.id, ...x, created: x.created ? x.created.toMillis() : Date.now() };
    }).reverse();
    hasMore = snap.size >= msgLimit;
    renderMsgs(fresh);
    if (keepScroll) msgBox.scrollTop = msgBox.scrollHeight - prevHeight + prevTop;
    else if (first) toBottom();
    else if (stick || (fresh.size && !incomingNew)) toBottom();
    else if (incomingNew) setJump(jumpCount + incomingNew);
    first = false;
    keepScroll = false;
    if (lookingAt(id)) markRead(chats.get(id));
  }, (err) => toast(niceError(err)));
}

function openChat(id) {
  const c = chats.get(id);
  if (!c) return;
  clearCtx();
  activeId = id;
  msgs = [];
  msgLimit = PAGE;
  setJump(0);
  $('#empty').classList.add('hidden');
  $('#convo').classList.remove('hidden');
  closePanels();
  $('#typing').textContent = '';
  document.body.classList.add('chat-open');
  msgBox.replaceChildren();
  renderHead();
  subscribeMsgs(id);
  if (lookingAt(id)) markRead(c);
  renderFriends();
  if (matchMedia('(min-width: 761px)').matches && canPost(c)) $('#text').focus();
}

$('#back').addEventListener('click', closeChat);

let loadingMore = false;
msgBox.addEventListener('scroll', () => {
  if (jumpCount && pinned()) setJump(0);
  if (msgBox.scrollTop > 40 || !hasMore || loadingMore || !activeId) return;
  loadingMore = true;
  msgLimit += PAGE;
  subscribeMsgs(activeId, true);
  setTimeout(() => (loadingMore = false), 800);
});

function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<]+[^\s<.,!?)\]'"]/g)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(el('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer', text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function msgEl(m, fresh) {
  if (m.type === 'sys') {
    const line = el('div', { class: 'sep sys' + (fresh ? ' new' : ''), 'data-id': m.id, text: m.text });
    line._m = m;
    return line;
  }
  const c = chats.get(activeId) || {};
  const mine = m.from === me.id;
  const node = el('div', { class: 'msg' + (mine ? ' mine' : ' theirs') + (fresh ? ' new' : ''), 'data-id': m.id });
  node._m = m;
  if (!mine) {
    if (c.type === 'news') {
      node.append(el('div', { class: 'msg-av static news-av' }, icon('news')));
      node.append(el('div', { class: 'who', text: 'News' }));
    } else {
      const who = users.get(m.from) || { username: '?' };
      node.append(el('button', { class: 'msg-av', type: 'button', title: who.username, onclick: () => openProfile(m.from) }, avatarEl(who)));
      if (c.type === 'group') node.append(el('button', { class: 'who', type: 'button', text: who.username, onclick: () => openProfile(m.from) }));
    }
  }
  if (m.reply) {
    node.append(el('button', { class: 'reply-ref', type: 'button', onclick: () => jumpTo(m.reply.id) },
      el('b', { text: c.type === 'news' ? 'News' : nameOf(m.reply.from) }), ' ' + (m.reply.snip || '')));
  }
  const bubble = el('div', { class: 'bubble ' + m.type });
  if (m.type === 'text') bubble.append(...linkify(m.text || ''));
  else if (m.type === 'image') {
    const img = el('img', { src: m.image, alt: 'Image', loading: 'lazy' });
    const stick = pinned();
    img.addEventListener('load', () => stick && toBottom(), { once: true });
    img.addEventListener('click', () => openLightbox(m.image));
    bubble.append(img);
  }
  bubble.addEventListener('click', (e) => {
    if (e.target.closest('a, button, img')) return;
    const was = node.classList.contains('show');
    msgBox.querySelectorAll('.msg.show').forEach((n) => n.classList.remove('show'));
    node.classList.toggle('show', !was);
  });
  const canDelete = mine || (c.type === 'news' && isAdmin());
  const acts = el('div', { class: 'acts' },
    QUICK.map((e) => el('button', { type: 'button', class: 'emo', text: e, title: 'React', onclick: () => react(m, e) })),
    canPost(c) ? el('button', { type: 'button', class: 'act-reply', text: 'Reply', onclick: () => setReply(m) }) : null,
    mine && m.type === 'text' ? el('button', { type: 'button', class: 'act-edit', text: 'Edit', onclick: () => setEdit(m) }) : null,
    canDelete ? el('button', { type: 'button', class: 'act-del danger', text: 'Delete', onclick: () => deleteMsg(m) }) : null);
  node.append(el('div', { class: 'row' }, bubble, acts));

  const groups = new Map();
  for (const [uid, list] of Object.entries(m.reactions || {})) for (const e of list || []) groups.set(e, (groups.get(e) || []).concat(uid));
  if (groups.size) {
    node.append(el('div', { class: 'reacts' }, [...groups].map(([emoji, who]) =>
      el('button', { type: 'button', class: 'react' + (who.includes(me.id) ? ' on' : ''), title: c.type === 'news' ? '' : who.map(nameOf).join(', '), onclick: () => react(m, emoji) },
        emoji, who.length > 1 ? el('small', { text: String(who.length) }) : null))));
  }
  node.append(el('div', { class: 'meta' + (m.edited ? ' keep' : '') },
    el('span', { text: fmtTime(m.created) }), m.edited ? el('span', { text: 'edited' }) : null));
  return node;
}

function regroup() {
  let prev = null;
  for (const n of msgBox.children) {
    if (!n.classList.contains('msg')) {
      prev = null;
      continue;
    }
    const g = !!prev && prev._m.from === n._m.from && n._m.created - prev._m.created < 3e5 && !n._m.reply;
    n.classList.toggle('grp', g);
    n.classList.remove('has-next');
    if (prev) prev.classList.toggle('has-next', g);
    prev = n;
  }
}

function updateSeen() {
  msgBox.querySelectorAll('.status').forEach((n) => n.remove());
  const last = msgs[msgs.length - 1];
  const c = chats.get(activeId);
  if (!last || !c || c.type !== 'dm' || last.from !== me.id) return;
  const node = msgBox.querySelector(`.msg[data-id="${last.id}"] .meta`);
  const seen = ((c.readN || {})[otherOf(c)] || 0) >= (c.n || 0);
  if (node) node.append(el('span', { class: 'status' + (seen ? ' seen' : ''), text: seen ? 'Seen' : 'Sent' }));
}

function renderMsgs(fresh) {
  if (!activeId) return;
  const nodes = [];
  let last = '';
  for (const m of msgs) {
    const k = dayKey(m.created);
    if (k !== last) {
      nodes.push(el('div', { class: 'sep', text: fmtDay(m.created) }));
      last = k;
    }
    nodes.push(msgEl(m, fresh && fresh.has(m.id)));
  }
  if (!msgs.length) nodes.push(el('div', { class: 'sep', text: 'No messages yet. Say something.' }));
  msgBox.replaceChildren(...nodes);
  regroup();
  updateSeen();
}

function jumpTo(id) {
  const node = msgBox.querySelector(`.msg[data-id="${id}"]`);
  if (!node) return toast('That message is further up or was deleted.');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
}

// a new message arrived in a chat (seen from the chat list)
function incoming(c) {
  if (lookingAt(c.id)) return;
  alertUser(c);
}

document.addEventListener('visibilitychange', () => {
  if (!me) return;
  if (!document.hidden) {
    heartbeatOnce();
    if (activeId && view === 'chat') markRead(chats.get(activeId));
  }
  renderFriends();
});
const heartbeatOnce = () => updateDoc(doc(db, 'users', me.id), { lastSeen: Date.now() }).catch(() => {});

/* sending, editing, deleting */
async function sendMessage(c, data) {
  const ref = doc(msgCol(c.id));
  const at = Date.now();
  const b = writeBatch(db);
  b.set(ref, { from: me.id, reactions: {}, created: serverTimestamp(), ...data });
  const last = { id: ref.id, from: me.id, type: data.type, text: data.type === 'image' ? '' : (data.text || '').slice(0, 140), at };
  const upd = { n: increment(1), last };
  if (c.type !== 'news') {
    upd['readN.' + me.id] = (c.n || 0) + 1;
    upd['typing.' + me.id] = deleteField();
  }
  b.update(chatRef(c.id), upd);
  if (c.type === 'news') b.update(doc(db, 'users', me.id), { newsRead: (c.n || 0) + 1 });
  await b.commit();
}
async function postSys(id, text) {
  const c = chats.get(id);
  if (c) await sendMessage(c, { type: 'sys', text });
}

async function deleteMsg(m) {
  if (!(await confirmBox('Delete this message for everyone?', 'Delete'))) return;
  const c = chats.get(activeId);
  try {
    await deleteDoc(doc(msgCol(c.id), m.id));
    if (c.last && c.last.id === m.id) {
      const prev = [...msgs].reverse().find((x) => x.id !== m.id);
      await updateDoc(chatRef(c.id), {
        last: prev ? { id: prev.id, from: prev.from, type: prev.type, text: prev.type === 'image' ? '' : (prev.text || '').slice(0, 140), at: prev.created } : null,
      });
    }
  } catch (err) {
    toast(niceError(err));
  }
}
function react(m, emoji) {
  const c = chats.get(activeId);
  if (!c) return;
  const list = [...((m.reactions || {})[me.id] || [])];
  const i = list.indexOf(emoji);
  if (i >= 0) list.splice(i, 1);
  else list.push(emoji);
  updateDoc(doc(msgCol(c.id), m.id), { ['reactions.' + me.id]: list.length ? list : deleteField() }).catch((e) => toast(niceError(e)));
}

/* lightbox */
function openLightbox(src) {
  $('#lightbox img').src = src;
  $('#lightbox').classList.remove('hidden');
}
$('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#cloak').classList.contains('hidden')) pickCloak(cloak || 'none');
  for (const id of ['#lightbox', '#settings', '#chat-set', '#group-new', '#profile', '#stats', '#spy']) $(id).classList.add('hidden');
  closePanels();
  clearCtx();
});

/* ---------- composer ---------- */
const text = $('#text');
function grow() {
  text.style.height = 'auto';
  text.style.height = Math.min(140, text.scrollHeight + 2) + 'px';
}
function setText(v) {
  text.value = v;
  grow();
}
function showCtx(title, body) {
  $('#ctx-title').textContent = title;
  $('#ctx-body').textContent = body;
  $('#ctx').classList.remove('hidden');
  text.focus();
}
function clearCtx() {
  if (editing) setText('');
  replyTo = editing = null;
  $('#ctx').classList.add('hidden');
  $('#send').textContent = 'Send';
}
function setReply(m) {
  clearCtx();
  replyTo = m;
  const c = chats.get(activeId) || {};
  showCtx('Replying to ' + (c.type === 'news' ? 'News' : nameOf(m.from)), snippet(m));
}
function setEdit(m) {
  clearCtx();
  editing = m;
  setText(m.text);
  $('#send').textContent = 'Save';
  showCtx('Editing message', m.text);
}
$('#ctx-x').addEventListener('click', clearCtx);
const replyData = () => (replyTo ? { reply: { id: replyTo.id, from: replyTo.from, snip: snippet(replyTo).slice(0, 100) } } : {});

let lastTyping = 0;
text.addEventListener('input', () => {
  grow();
  const c = chats.get(activeId);
  if (!c || c.type === 'news' || editing || Date.now() - lastTyping < 3000) return;
  lastTyping = Date.now();
  updateDoc(chatRef(c.id), { ['typing.' + me.id]: Date.now() }).catch(() => {});
});
text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  } else if (e.key === 'ArrowUp' && !text.value && !editing) {
    const mine = [...msgs].reverse().find((m) => m.from === me.id && m.type === 'text');
    if (mine) {
      e.preventDefault();
      setEdit(mine);
    }
  }
});

function showTyping() {
  const c = chats.get(activeId);
  if (!c || c.type === 'news') return ($('#typing').textContent = '');
  const now = Date.now();
  const who = Object.entries(c.typing || {}).filter(([uid, t]) => uid !== me.id && now - t < 5000).map(([uid]) => nameOf(uid));
  $('#typing').textContent = !who.length ? '' : who.length === 1 ? who[0] + ' is typing' : who.join(', ') + ' are typing';
}
setInterval(() => activeId && showTyping(), 1000);

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = text.value.trim();
  const c = chats.get(activeId);
  if (!content || !c) return;
  const wasEdit = editing;
  const extra = replyData();
  setText('');
  lastTyping = 0;
  clearCtx();
  try {
    if (wasEdit) {
      await updateDoc(doc(msgCol(c.id), wasEdit.id), { text: content, edited: true });
      if (c.last && c.last.id === wasEdit.id) await updateDoc(chatRef(c.id), { 'last.text': content.slice(0, 140) });
    } else {
      await sendMessage(c, { type: 'text', text: content, ...extra });
    }
  } catch (err) {
    setText(content);
    toast(niceError(err));
  }
});

// images
$('#btn-img').addEventListener('click', () => $('#file-img').click());
$('#file-img').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) sendImage(file);
});
async function sendImage(file) {
  const c = chats.get(activeId);
  if (!c || !canPost(c)) return;
  const extra = replyData();
  clearCtx();
  toast('Sending image...');
  try {
    const image = await shrink(file, 1280, 850_000);
    await sendMessage(c, { type: 'image', image, ...extra });
  } catch (err) {
    toast(niceError(err));
  }
}
text.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
  if (item) {
    e.preventDefault();
    sendImage(item.getAsFile());
  }
});
let dragTimer;
$('#chat').addEventListener('dragover', (e) => {
  e.preventDefault();
  $('#chat').classList.add('drag');
  clearTimeout(dragTimer);
  dragTimer = setTimeout(() => $('#chat').classList.remove('drag'), 200);
});
$('#chat').addEventListener('drop', (e) => {
  e.preventDefault();
  $('#chat').classList.remove('drag');
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (file) sendImage(file);
});

/* ---------- emoji panel ---------- */
function closePanels() {
  $('#emoji-panel').classList.add('hidden');
  $('#btn-emo').classList.remove('on');
}
$('#emoji-grid').append(
  ...EMOJI.map((e) =>
    el('button', {
      type: 'button',
      text: e,
      onclick: () => {
        const s = text.selectionStart ?? text.value.length;
        text.setRangeText(e, s, text.selectionEnd ?? s, 'end');
        grow();
        text.focus();
      },
    })
  )
);
$('#btn-emo').addEventListener('click', () => {
  const open = $('#emoji-panel').classList.contains('hidden');
  closePanels();
  if (open) {
    $('#emoji-panel').classList.remove('hidden');
    $('#btn-emo').classList.add('on');
  }
});

/* ---------- alerts: sound + desktop notifications ---------- */
let actx = null;
function blip() {
  if (!prefs.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(740, t);
    o.frequency.exponentialRampToValueAtTime(1180, t + 0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g).connect(actx.destination);
    o.start(t);
    o.stop(t + 0.3);
  } catch {}
}
function alertUser(c) {
  blip();
  if (!prefs.notify || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  const info = chatInfo(c);
  try {
    const n = new Notification(info.title, { body: preview(c), icon: info.user.avatar || undefined, tag: 'chat-' + c.id });
    n.onclick = () => {
      window.focus();
      go('chat');
      openChat(c.id);
      n.close();
    };
  } catch {}
}

/* ---------- profile + settings ---------- */
function paintBanner(node, url) {
  node.classList.toggle('empty', !url);
  node.style.backgroundImage = url ? `url("${url}")` : '';
}
function renderSettings() {
  $('#set-sound').textContent = prefs.sound ? 'On' : 'Off';
  $('#set-sound').classList.toggle('on', prefs.sound);
  const granted = 'Notification' in window && Notification.permission === 'granted';
  $('#set-notify').textContent = prefs.notify && granted ? 'On' : 'Off';
  $('#set-notify').classList.toggle('on', prefs.notify && granted);
}
const openSettings = () => {
  renderSettings();
  $('#set-name').value = me.username;
  $('#name-msg').textContent = '';
  $('#pw-msg').textContent = '';
  $('#settings').classList.remove('hidden');
};
$('#open-settings').addEventListener('click', openSettings);
$('#tile-profile').addEventListener('click', openSettings);
$('#set-close').addEventListener('click', () => $('#settings').classList.add('hidden'));
$('#settings').addEventListener('click', (e) => e.target.id === 'settings' && $('#settings').classList.add('hidden'));
$('#set-sound').addEventListener('click', () => {
  prefs.sound = !prefs.sound;
  savePrefs();
  renderSettings();
  blip();
});
$('#set-notify').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('This browser does not support notifications.');
  if (prefs.notify && Notification.permission === 'granted') prefs.notify = false;
  else {
    const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (p !== 'granted') toast('Notifications are blocked in your browser settings.');
    prefs.notify = p === 'granted';
  }
  savePrefs();
  renderSettings();
});

async function setPicture(field, file, maxDim, maxChars, done) {
  try {
    const data = await shrink(file, maxDim, maxChars);
    await updateDoc(doc(db, 'users', me.id), { [field]: data });
    toast(done);
  } catch (err) {
    toast(niceError(err));
  }
}
$('#set-pic').addEventListener('click', () => $('#file-avatar').click());
$('#file-avatar').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) setPicture('avatar', file, 256, 120_000, 'Profile picture updated.');
});
$('#set-pic-remove').addEventListener('click', () => updateDoc(doc(db, 'users', me.id), { avatar: null }).catch((e) => toast(niceError(e))));
$('#set-banner-btn').addEventListener('click', () => $('#file-banner').click());
$('#file-banner').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) setPicture('banner', file, 1200, 350_000, 'Banner updated.');
});
$('#set-banner-remove').addEventListener('click', () => updateDoc(doc(db, 'users', me.id), { banner: null }).catch((e) => toast(niceError(e))));

$('#name-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = $('#name-msg');
  const next = $('#set-name').value.trim().toLowerCase();
  try {
    if (next === me.username) throw fail('That is already your username.');
    if (!NAME_RE.test(next)) throw fail('Username must be 3-20 characters: letters, numbers, _ or .');
    if ((await getDoc(doc(db, 'usernames', next))).exists()) throw fail('That username is taken.');
    const b = writeBatch(db);
    b.set(doc(db, 'usernames', next), { uid: me.id, email: auth.currentUser.email });
    b.update(doc(db, 'users', me.id), { username: next });
    b.delete(doc(db, 'usernames', me.username));
    await b.commit();
    note.className = 'note';
    note.textContent = 'Saved. You now log in as ' + next + '.';
  } catch (err) {
    note.className = 'note bad';
    note.textContent = niceError(err);
  }
});

$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = $('#pw-msg');
  try {
    const next = $('#pw-next').value;
    if (next.length < 6) throw fail('New password must be at least 6 characters.');
    const cred = EmailAuthProvider.credential(auth.currentUser.email, $('#pw-current').value);
    await reauthenticateWithCredential(auth.currentUser, cred);
    await updatePassword(auth.currentUser, next);
    $('#pw-current').value = $('#pw-next').value = '';
    note.className = 'note';
    note.textContent = 'Password changed.';
  } catch (err) {
    note.className = 'note bad';
    note.textContent = err.code === 'auth/invalid-credential' ? 'Current password is wrong.' : niceError(err);
  }
});
$('#logout').addEventListener('click', async () => {
  await signOut(auth).catch(() => {});
  location.reload();
});

/* ---------- profile cards ---------- */
const closeModals = () => ['#profile', '#chat-set', '#group-new', '#settings'].forEach((id) => $(id).classList.add('hidden'));
async function openProfile(id) {
  let u = id === me.id ? me : users.get(id);
  if (!u) {
    try {
      const s = await getDoc(doc(db, 'users', id));
      if (!s.exists()) return toast('That account is gone.');
      u = { id, ...s.data() };
    } catch (err) {
      return toast(niceError(err));
    }
  }
  const self = id === me.id;
  const friend = chats.has(dmId(me.id, id));
  const online = isOnline(u) && !self;
  paintBanner($('#pf-banner'), u.banner);
  $('#pf-avatar').replaceChildren(avatarEl(u, online ? 'online' : ''));
  $('#pf-name').textContent = u.username;
  $('#pf-badge').classList.toggle('hidden', u.username !== ADMIN_USER);
  $('#pf-status').textContent = self ? 'This is you'
    : friend ? (online ? 'Online' : 'Offline')
    : reqOut.has(id) ? 'Request sent' : reqIn.has(id) ? 'Wants to be friends' : 'Not friends yet';
  $('#pf-status').className = 'sub' + (online ? ' online' : '');
  const created = u.created || Date.now();
  $('#pf-joined').textContent = new Date(created).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
  const days = Math.floor((Date.now() - created) / 864e5);
  $('#pf-age').textContent = days < 1 ? 'Less than a day' : days === 1 ? '1 day' : days + ' days';
  const btn = (label, solid, fn) => el('button', { class: 'btn small' + (solid ? ' solid' : ''), type: 'button', text: label, onclick: fn });
  const run = (p) => p.then(() => openProfile(id)).catch((e) => toast(niceError(e)));
  const acts = [];
  if (self) acts.push(btn('Edit profile', true, () => { closeModals(); openSettings(); }));
  else if (friend) acts.push(btn('Message', true, () => { closeModals(); go('chat'); openChat(dmId(me.id, id)); }));
  else if (reqIn.has(id)) acts.push(btn('Accept request', true, () => run(acceptRequest(id))));
  else if (reqOut.has(id)) acts.push(btn('Cancel request', false, () => run(deleteDoc(reqDoc(me.id, id)))));
  else acts.push(btn('Add friend', true, () => run(addFriend(u.username))));
  acts.push(btn('Close', false, () => $('#profile').classList.add('hidden')));
  $('#pf-actions').replaceChildren(...acts);
  $('#profile').classList.remove('hidden');
}
$('#profile').addEventListener('click', (e) => e.target.id === 'profile' && $('#profile').classList.add('hidden'));
$('#peer-btn').addEventListener('click', () => {
  const c = chats.get(activeId);
  if (!c || c.type === 'news') return;
  c.type === 'group' ? openChatSettings() : openProfile(otherOf(c));
});

/* ---------- group chats ---------- */
const friendList = () => [...chats.values()].filter((c) => c.type === 'dm')
  .map((c) => users.get(otherOf(c)) || { id: otherOf(c), username: '...' })
  .sort((a, b) => a.username.localeCompare(b.username));
function pickList(box, people, picked, emptyText) {
  if (!people.length) return box.replaceChildren(el('div', { class: 'none', text: emptyText }));
  box.replaceChildren(
    ...people.map((u) => {
      const b = el('button', { class: 'pick' + (picked.has(u.id) ? ' on' : ''), type: 'button' },
        avatarEl(u), el('span', { class: 'name', text: u.username }), el('i', { class: 'tick' }));
      b.addEventListener('click', () => {
        if (picked.has(u.id)) picked.delete(u.id);
        else picked.add(u.id);
        b.classList.toggle('on', picked.has(u.id));
      });
      return b;
    })
  );
}
const newPicked = new Set();
$('#new-group').addEventListener('click', () => {
  newPicked.clear();
  $('#group-name').value = '';
  $('#group-msg').textContent = '';
  pickList($('#group-picks'), friendList(), newPicked, 'Add some friends first, then you can put them in a group.');
  $('#group-new').classList.remove('hidden');
  $('#group-name').focus();
});
$('#group-cancel').addEventListener('click', () => $('#group-new').classList.add('hidden'));
$('#group-new').addEventListener('click', (e) => e.target.id === 'group-new' && $('#group-new').classList.add('hidden'));
$('#group-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#group-name').value.trim().slice(0, 40);
  if (!name) return;
  if (!newPicked.size) return ($('#group-msg').textContent = 'Pick at least one friend.');
  try {
    const ref = doc(collection(db, 'chats'));
    await setDoc(ref, { type: 'group', name, owner: me.id, members: [me.id, ...newPicked], n: 0, last: null, readN: {}, created: Date.now() });
    chats.set(ref.id, { id: ref.id, type: 'group', name, owner: me.id, members: [me.id, ...newPicked], n: 0, created: Date.now() });
    await postSys(ref.id, me.username + ' made the group');
    $('#group-new').classList.add('hidden');
    go('chat');
    openChat(ref.id);
  } catch (err) {
    $('#group-msg').textContent = niceError(err);
  }
});

/* ---------- chat settings ---------- */
const addPicked = new Set();
function openChatSettings() {
  if (!chats.get(activeId)) return;
  addPicked.clear();
  renderChatSettings();
  $('#chat-set').classList.remove('hidden');
}
function renderChatSettings() {
  const c = chats.get(activeId);
  if (!c) return $('#chat-set').classList.add('hidden');
  const info = chatInfo(c);
  const group = c.type === 'group';
  const owner = group && c.owner === me.id;
  const run = (p) => p.catch((e) => toast(niceError(e))).then(renderChatSettings);
  $('#cs-title').textContent = info.title;
  $('#cs-group').classList.toggle('hidden', !group);
  if (group) {
    const members = (c.members || []).map((id) => users.get(id) || { id, username: '...' });
    $('#cs-members').replaceChildren(...members.map((u) =>
      el('div', { class: 'req' },
        el('button', { class: 'msg-av static', type: 'button', onclick: () => openProfile(u.id) }, avatarEl(u)),
        el('div', { class: 'text' }, el('div', { class: 'name', text: u.username + (u.id === me.id ? ' (you)' : '') }), el('div', { class: 'sub' + (u.id === c.owner ? ' online' : ''), text: u.id === c.owner ? 'Master' : 'Member' })),
        owner && u.id !== me.id ? el('button', { class: 'btn small', type: 'button', text: 'Make master', onclick: async () => {
          if (await confirmBox(`Hand ${info.title} over to ${u.username}? They become the master.`, 'Hand over')) run(updateDoc(chatRef(c.id), { owner: u.id }));
        } }) : null,
        owner && u.id !== me.id ? el('button', { class: 'btn small kick', type: 'button', text: 'Kick', onclick: async () => {
          if (!(await confirmBox(`Kick ${u.username} out of ${info.title}?`, 'Kick'))) return;
          run(postSys(c.id, u.username + ' was removed').then(() => updateDoc(chatRef(c.id), { members: arrayRemove(u.id) })));
        } }) : null)));
    const can = friendList().filter((f) => !(c.members || []).includes(f.id));
    for (const id of [...addPicked]) if (!can.some((f) => f.id === id)) addPicked.delete(id);
    $('#cs-add-box').classList.toggle('hidden', !can.length);
    pickList($('#cs-add'), can, addPicked, '');
    $('#cs-add-btn').onclick = async () => {
      if (!addPicked.size) return toast('Tick who to add first.');
      const ids = [...addPicked];
      addPicked.clear();
      run(updateDoc(chatRef(c.id), { members: arrayUnion(...ids) })
        .then(() => postSys(c.id, me.username + ' added ' + ids.map(nameOf).join(', '))));
    };
    $('#cs-rename').classList.toggle('hidden', !owner);
    if (document.activeElement !== $('#cs-name')) $('#cs-name').value = info.title;
    $('#cs-rename').onsubmit = (e) => {
      e.preventDefault();
      const name = $('#cs-name').value.trim().slice(0, 40);
      if (name) run(updateDoc(chatRef(c.id), { name }).then(() => postSys(c.id, me.username + ' renamed the group to ' + name)));
    };
  }
  $('#remove-friend').textContent = group ? 'Leave group' : 'Unfriend';
}
$('#chat-settings').addEventListener('click', openChatSettings);
$('#cs-close').addEventListener('click', () => $('#chat-set').classList.add('hidden'));
$('#chat-set').addEventListener('click', (e) => e.target.id === 'chat-set' && $('#chat-set').classList.add('hidden'));

/* ---------- admin: site stats (only the ADMIN_USER account sees the button) ---------- */
let statsFilter = 'all';
let statsUsers = null;
// the "View chats" buttons stay hidden until the invisible top-right corner of the stats
// panel is tapped. Every time the panel is reopened it locks again.
let spyUnlocked = false;
function showAdmin() {
  $('#open-stats').classList.toggle('hidden', !isAdmin());
}
async function loadStats() {
  try {
    const snap = await getDocs(collection(db, 'users'));
    statsUsers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    return toast(niceError(err));
  }
  renderStats();
}
const fmtAgo = (ts) => {
  if (!ts) return 'never on the new site';
  const s = (Date.now() - ts) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};
function renderStats() {
  const list = statsUsers;
  if (!list) return;
  const online = list.filter((u) => u.id === me.id || isOnline(u));
  $('#stat-total').textContent = list.length;
  $('#stat-online').textContent = online.length;
  $('#stat-offline').textContent = list.length - online.length;
  const newest = [...list].sort((a, b) => (b.created || 0) - (a.created || 0))[0];
  $('#stat-last').textContent = newest ? 'Newest sign-up: ' + newest.username + ' / ' + new Date(newest.created).toLocaleString() : 'No sign-ups yet.';
  const on = (u) => u.id === me.id || isOnline(u);
  const rows = list
    .filter((u) => statsFilter === 'all' || (statsFilter === 'online') === on(u))
    .sort((a, b) => on(b) - on(a) || (b.lastSeen || 0) - (a.lastSeen || 0) || (b.created || 0) - (a.created || 0));
  $('#stat-list').replaceChildren(
    ...rows.map((u) =>
      el('div', { class: 'stat-row' },
        avatarEl(u, on(u) ? 'online' : ''),
        el('div', { class: 'text' },
          el('div', { class: 'name', text: u.username + (u.id === me.id ? ' / you' : '') }),
          el('div', { class: 'sub', text: 'Joined ' + new Date(u.created || Date.now()).toLocaleDateString() + (on(u) ? '' : ' / last seen ' + fmtAgo(u.lastSeen)) })),
        (spyUnlocked && u.id !== me.id) ? el('button', { class: 'btn small', type: 'button', text: 'View chats', onclick: () => openSpy(u.id, u.username) }) : null,
        el('div', { class: 'dot-state ' + (on(u) ? 'on' : 'off'), text: on(u) ? 'Online' : 'Offline' }))),
    ...(rows.length ? [] : [el('div', { class: 'none', text: 'Nobody here.' })])
  );
}
$('#open-stats').addEventListener('click', () => {
  statsUsers = null;
  spyUnlocked = false; // always start locked
  $('#stat-list').replaceChildren(el('div', { class: 'none', text: 'Loading...' }));
  $('#stats').classList.remove('hidden');
  loadStats();
});
// the invisible corner button reveals or re-hides the "View chats" buttons
$('#stat-unlock').addEventListener('click', () => {
  spyUnlocked = !spyUnlocked;
  if (statsUsers) renderStats();
});
$('#stats-refresh').addEventListener('click', loadStats);
$('#stats-close').addEventListener('click', () => $('#stats').classList.add('hidden'));
$('#stats').addEventListener('click', (e) => e.target.id === 'stats' && $('#stats').classList.add('hidden'));
document.querySelectorAll('.stat-tabs .opt').forEach((b) =>
  b.addEventListener('click', () => {
    statsFilter = b.dataset.filter;
    document.querySelectorAll('.stat-tabs .opt').forEach((x) => x.classList.toggle('on', x === b));
    renderStats();
  })
);

/* ---------- admin: read any account's chats (only the ADMIN_USER account) ---------- */
let spyTarget = null;
let spyChats = [];
async function fetchUser(uid) {
  if (users.has(uid)) return users.get(uid);
  try {
    const s = await getDoc(doc(db, 'users', uid));
    if (s.exists()) {
      const u = { id: uid, ...s.data() };
      users.set(uid, u);
      return u;
    }
  } catch {}
  return { id: uid, username: 'Someone' };
}
const spyName = (uid) => (uid === me.id ? me.username : (users.get(uid) || {}).username || 'Someone');
function spyChatLabel(c) {
  if (c.type === 'news') return c.name || 'News';
  if (c.type === 'group') return (c.name || 'Group') + ' / group';
  const other = (c.members || []).find((u) => u !== spyTarget.uid);
  return spyName(other);
}
async function openSpy(uid, username) {
  spyTarget = { uid, username };
  $('#spy-title').textContent = 'Viewing ' + username + "'s chats";
  $('#spy-chats').replaceChildren(el('div', { class: 'none', text: 'Loading...' }));
  $('#spy-msgs').replaceChildren(el('div', { class: 'sep', text: 'Pick a chat on the left.' }));
  $('#spy').classList.remove('hidden');
  try {
    const snap = await getDocs(query(collection(db, 'chats'), where('members', 'array-contains', uid)));
    spyChats = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const news = await getDoc(chatRef('news')).catch(() => null);
    if (news && news.exists()) spyChats.push({ id: 'news', ...news.data() });
    const ids = new Set();
    for (const c of spyChats) for (const m of c.members || []) ids.add(m);
    await Promise.all([...ids].map(fetchUser));
    spyChats.sort((a, b) => (b.last ? b.last.at || 0 : 0) - (a.last ? a.last.at || 0 : 0));
    renderSpyChats();
  } catch (err) {
    $('#spy-chats').replaceChildren(el('div', { class: 'none bad', text: niceError(err) }));
  }
}
function renderSpyChats() {
  if (!spyChats.length) return $('#spy-chats').replaceChildren(el('div', { class: 'none', text: 'No chats.' }));
  $('#spy-chats').replaceChildren(
    ...spyChats.map((c) =>
      el('button', { class: 'friend', type: 'button', onclick: () => openSpyChat(c) },
        el('div', { class: 'text' },
          el('div', { class: 'name', text: spyChatLabel(c) }),
          el('div', { class: 'sub', text: (c.n || 0) + ' messages' }))))
  );
}
async function openSpyChat(c) {
  $('#spy-msgs').replaceChildren(el('div', { class: 'sep', text: 'Loading...' }));
  try {
    const snap = await getDocs(query(collection(db, 'chats', c.id, 'messages'), orderBy('created', 'asc'), limit(400)));
    const list = snap.docs.map((d) => {
      const x = d.data({ serverTimestamps: 'estimate' });
      return { id: d.id, ...x, created: x.created ? x.created.toMillis() : Date.now() };
    });
    const missing = new Set();
    for (const m of list) if (!users.has(m.from) && m.from !== me.id) missing.add(m.from);
    await Promise.all([...missing].map(fetchUser));
    if (!list.length) return $('#spy-msgs').replaceChildren(el('div', { class: 'sep', text: 'No messages in this chat.' }));
    $('#spy-msgs').replaceChildren(...list.map((m) => {
      if (m.type === 'sys') return el('div', { class: 'sep sys', text: m.text });
      const line = el('div', { class: 'spy-line' },
        el('b', { text: (c.type === 'news' ? 'News' : spyName(m.from)) + ': ' }));
      if (m.type === 'image') line.append(el('img', { class: 'spy-img', src: m.image, alt: '', loading: 'lazy', onclick: () => openLightbox(m.image) }));
      else line.append(document.createTextNode(m.text || ''));
      line.append(el('span', { class: 'spy-time', text: fmtTime(m.created) }));
      return line;
    }));
    $('#spy-msgs').scrollTop = $('#spy-msgs').scrollHeight;
  } catch (err) {
    $('#spy-msgs').replaceChildren(el('div', { class: 'none bad', text: niceError(err) }));
  }
}
$('#spy-close').addEventListener('click', () => $('#spy').classList.add('hidden'));
$('#spy').addEventListener('click', (e) => e.target.id === 'spy' && $('#spy').classList.add('hidden'));

/* ---------- views: home / chat / games ---------- */
function go(v) {
  view = v;
  for (const name of ['home', 'chat', 'games', 'videos']) $('#view-' + name).classList.toggle('on', name === v);
  $('#nav').dataset.view = v;
  document.body.classList.toggle('calm', v !== 'home');
  try { sessionStorage.setItem('view', v); } catch {}
  if (v === 'games') loadGames(false);
  if (v === 'videos') loadVideos(false);
  if (v === 'chat' && activeId) {
    markRead(chats.get(activeId));
    toBottom();
  }
  renderFriends();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b) go(b.dataset.go);
});
$('#home-date').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

/* ---------- mouse: cursor, light, glowing edges, 3d tilt ---------- */
if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;
  const dot = $('#cur-dot');
  const ring = $('#cur-ring');
  const bg = $('#bg');
  const GLOW = '.glass, .modal-box';
  let mx = innerWidth / 2, my = innerHeight * 0.4;
  let rx = mx, ry = my;
  let sx = mx, sy = my;
  let gx = mx, gy = my;
  let lastSpark = 0;
  let tiltOn = null;
  const tilts = new Map();
  root.classList.add('has-cursor');

  const show = (on) => {
    dot.classList.toggle('gone', !on);
    ring.classList.toggle('gone', !on);
  };
  addEventListener('pointermove', (e) => {
    mx = e.clientX;
    my = e.clientY;
    const t = e.target instanceof Element ? e.target : null;
    show(!(t && t.tagName === 'IFRAME'));
    dot.style.transform = `translate3d(${mx}px, ${my}px, 0)`;
    const isText = !!t && t.matches('input:not([type=file]), textarea');
    ring.classList.toggle('text', isText);
    ring.classList.toggle('hover', !isText && !!t && !!t.closest('button, a, label, .bubble.image img'));

    const el2 = !still && t ? t.closest('[data-tilt]') : null;
    if (tiltOn && tiltOn !== el2) {
      tiltOn.classList.remove('tilting');
      const s = tilts.get(tiltOn);
      if (s) s.tx = s.ty = 0;
    }
    tiltOn = el2;
    if (el2) {
      const box = el2.parentElement.classList.contains('tilt-wrap') ? el2.parentElement : el2;
      const r = box.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (mx - r.left) / r.width)) - 0.5;
      const y = Math.min(1, Math.max(0, (my - r.top) / r.height)) - 0.5;
      const max = Number(el2.dataset.tilt) || 8;
      let s = tilts.get(el2);
      if (!s) tilts.set(el2, (s = { x: 0, y: 0, tx: 0, ty: 0 }));
      s.tx = -y * 2 * max;
      s.ty = x * 2 * max;
      el2.classList.add('tilting');
    }

    const speed = Math.hypot(e.movementX || 0, e.movementY || 0);
    if (!still && speed > 26 && e.timeStamp - lastSpark > 28 && t && t.tagName !== 'IFRAME') {
      lastSpark = e.timeStamp;
      const p = el('div', { class: 'spark' });
      p.style.left = mx + (Math.random() - 0.5) * 14 + 'px';
      p.style.top = my + (Math.random() - 0.5) * 14 + 'px';
      p.addEventListener('animationend', () => p.remove());
      document.body.append(p);
    }
  }, { passive: true });
  document.addEventListener('pointerleave', () => show(false));
  addEventListener('blur', () => show(false));
  addEventListener('pointerdown', (e) => {
    ring.classList.add('down');
    if (still) return;
    const p = el('div', { class: 'pulse' });
    p.style.left = e.clientX + 'px';
    p.style.top = e.clientY + 'px';
    p.addEventListener('animationend', () => p.remove());
    document.body.append(p);
  });
  addEventListener('pointerup', () => ring.classList.remove('down'));

  (function loop() {
    rx += (mx - rx) * 0.22;
    ry += (my - ry) * 0.22;
    sx += (mx - sx) * 0.07;
    sy += (my - sy) * 0.07;
    ring.style.transform = `translate3d(${rx.toFixed(1)}px, ${ry.toFixed(1)}px, 0)`;
    bg.style.setProperty('--sx', sx.toFixed(1) + 'px');
    bg.style.setProperty('--sy', sy.toFixed(1) + 'px');
    if (Math.abs(mx - gx) + Math.abs(my - gy) > 0.3) {
      gx += (mx - gx) * 0.3;
      gy += (my - gy) * 0.3;
      for (const n of document.querySelectorAll(GLOW)) {
        const r = n.getBoundingClientRect();
        if (!r.width) continue;
        n.style.setProperty('--gx', (gx - r.left).toFixed(1) + 'px');
        n.style.setProperty('--gy', (gy - r.top).toFixed(1) + 'px');
      }
    }
    for (const [n, s] of tilts) {
      s.x += (s.tx - s.x) * 0.12;
      s.y += (s.ty - s.y) * 0.12;
      if (n !== tiltOn && Math.abs(s.x) + Math.abs(s.y) < 0.02) {
        n.style.removeProperty('--rx');
        n.style.removeProperty('--ry');
        tilts.delete(n);
        continue;
      }
      n.style.setProperty('--rx', s.x.toFixed(2) + 'deg');
      n.style.setProperty('--ry', s.y.toFixed(2) + 'deg');
    }
    requestAnimationFrame(loop);
  })();
}

/* ---------- games ---------- */
let gameFrame = null;
function loadGames(force) {
  if (gameFrame && !force) return;
  if (gameFrame) gameFrame.remove();
  $('#games-loading').classList.remove('hidden');
  const f = document.createElement('iframe');
  f.title = 'Games';
  f.setAttribute('allow', 'fullscreen *; gamepad *; autoplay *');
  f.setAttribute('allowfullscreen', '');
  f.addEventListener('load', () => $('#games-loading').classList.add('hidden'));
  f.src = 'games.html';
  $('#games-frame').append(f);
  gameFrame = f;
}
$('#games-home').addEventListener('click', () => loadGames(true));
$('#games-reload').addEventListener('click', () => loadGames(true));
$('#games-full').addEventListener('click', () => {
  const box = $('#games-frame');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (box.requestFullscreen) box.requestFullscreen().catch(() => toast('Fullscreen was blocked.'));
});

/* ---------- tab cloak ---------- */
const CLOAKS = {
  classroom: { label: 'Google Classroom', title: 'Home - Classroom', icon: 'https://ssl.gstatic.com/classroom/favicon.png' },
  forms: { label: 'Google Forms', title: 'Untitled form - Google Forms', icon: 'https://ssl.gstatic.com/docs/spreadsheets/forms/forms_icon_2023q4.ico' },
  drive: { label: 'Google Drive', title: 'My Drive - Google Drive', icon: 'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png' },
  docs: { label: 'Google Docs', title: 'Untitled document - Google Docs', icon: 'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico' },
};
let cloak = store.get('cloak'); // null means we have never asked
if (cloak && cloak !== 'none' && !CLOAKS[cloak]) cloak = 'none';
const cloakOn = () => !!cloak && cloak !== 'none';

function applyCloak() {
  // browsers only notice a new tab icon when the tag itself is swapped
  const link = el('link', { id: 'favicon', rel: 'icon', href: cloakOn() ? CLOAKS[cloak].icon : 'icon.svg' });
  const old = document.getElementById('favicon');
  if (old) old.replaceWith(link); else document.head.append(link);
  setTitle();
  const chip = $('#open-cloak');
  if (chip) {
    const st = $('#cloak-state');
    if (st) st.textContent = cloakOn() ? CLOAKS[cloak].label : 'Cloak off';
    chip.classList.toggle('on', cloakOn());
  }
}
let cloakFirst = false;
function pickCloak(k) {
  const changed = k !== cloak;
  cloak = k;
  store.set('cloak', k);
  applyCloak();
  $('#cloak').classList.add('hidden');
  if (changed || cloakFirst) toast(cloakOn() ? 'This tab now looks like ' + CLOAKS[k].label + '.' : 'Tab cloak is off.');
  cloakFirst = false;
}
function openCloak(first) {
  cloakFirst = first;
  $('#cloak-title').textContent = first ? 'Cloak this tab?' : 'Tab cloak';
  const keys = ['classroom', 'forms', 'drive', 'docs', 'none'];
  $('#cloak-grid').replaceChildren(
    ...keys.map((k) => {
      const c = CLOAKS[k];
      const pic = el('span', { class: 'pic' + (c ? '' : ' plain') });
      if (c) {
        const img = el('img', { src: c.icon, alt: '' });
        img.addEventListener('error', () => pic.replaceChildren(c.label.replace('Google ', '')[0]));
        pic.append(img);
      } else pic.append(icon('x'));
      return el('button', { class: 'cloak-opt' + ((cloak || 'none') === k ? ' sel' : ''), type: 'button', 'data-tilt': '16', onclick: () => pickCloak(k) },
        el('i', { class: 'glare' }), pic,
        el('span', { text: c ? c.label : 'No cloak' }),
        el('small', { text: c ? 'Tab reads "' + c.title + '"' : 'Keep the Study Hall tab' }));
    })
  );
  $('#cloak').classList.remove('hidden');
}
$('#open-cloak').addEventListener('click', () => openCloak(false));
$('#cloak').addEventListener('click', (e) => e.target.id === 'cloak' && !cloakFirst && $('#cloak').classList.add('hidden'));
applyCloak();

// On every open or refresh: show the rules, then the tab-cloak picker.
$('#warn').classList.remove('hidden');
$('#warn-ok').addEventListener('click', () => {
  $('#warn').classList.add('hidden');
  openCloak(cloak === null);
}, { once: true });

/* ---------- videos (plays embeddable sources inside the page) ---------- */
let videoFrame = null;
let videosReady = false;
// a few full movies in the public domain, hosted and embeddable on the Internet Archive
const MOVIES = [
  { t: 'Night of the Living Dead', y: 1968, id: 'Night.Of.The.Living.Dead_1080p' },
  { t: 'Plan 9 from Outer Space', y: 1959, id: 'plan-9-from-outer-space' },
  { t: 'Charade', y: 1963, id: 'Charade19631280x696' },
  { t: 'D.O.A.', y: 1950, id: 'D.o.a.VideoQualityUpgrade' },
  { t: 'Angel and the Badman', y: 1947, id: 'AngelAndTheBadManVideoQualityUpgrade' },
  { t: 'The Front Page', y: 1931, id: 'TheFrontPage1931AdolpheMenjouPatOBrienLewismiles' },
];
// turn whatever link someone pastes into something that embeds
function toEmbed(raw) {
  const u = (raw || '').trim();
  if (!u) return '';
  let m = u.match(/archive\.org\/(?:details|embed)\/([^/?#]+)/i);
  if (m) return 'https://archive.org/embed/' + m[1];
  m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/i);
  if (m) return 'https://www.youtube-nocookie.com/embed/' + m[1];
  m = u.match(/youtube\.com\/playlist\?list=([\w-]+)/i);
  if (m) return 'https://www.youtube-nocookie.com/embed/videoseries?list=' + m[1];
  if (/^[\w-]{11}$/.test(u)) return 'https://www.youtube-nocookie.com/embed/' + u;
  return u; // some other embeddable page
}
function playVideo(src) {
  const url = toEmbed(src);
  if (!url) return;
  const box = $('#videos-frame');
  box.replaceChildren(el('div', { id: 'videos-loading' }, el('i', { class: 'spin' }), 'Loading'));
  const f = document.createElement('iframe');
  f.title = 'Video';
  f.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
  f.setAttribute('allowfullscreen', '');
  f.addEventListener('load', () => { const l = document.getElementById('videos-loading'); if (l) l.remove(); });
  f.src = url;
  box.append(f);
  videoFrame = f;
  store.set('videos-last', src);
}
function loadVideos(force) {
  if (videosReady && !force) return;
  videosReady = true;
  $('#videos-list').replaceChildren(...MOVIES.map((mv) =>
    el('button', { class: 'friend', type: 'button', onclick: () => { $('#videos-url').value = ''; playVideo('https://archive.org/embed/' + mv.id); } },
      el('div', { class: 'text' }, el('div', { class: 'name', text: mv.t }), el('div', { class: 'sub', text: String(mv.y) })))));
  const proxyBtn = $('#videos-proxy');
  if (proxyBtn) proxyBtn.onclick = () => {
    const proxy = (VIDEO_PROXY_URL || '').trim();
    if (!proxy) { toast('Add your Railway URL to config.js first.'); return; }
    let url;
    try { url = new URL(proxy); } catch { toast('The Railway URL in config.js is invalid.'); return; }
    if (url.protocol !== 'https:') { toast('The Railway URL must use HTTPS.'); return; }
    const box = $('#videos-frame');
    const f = document.createElement('iframe');
    f.title = 'Video site through Railway';
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation');
    f.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
    f.setAttribute('allowfullscreen', '');
    f.src = url.href;
    box.replaceChildren(f);
    videoFrame = f;
  };
  const openBtn = $('#videos-open');
  if (openBtn) {
    const site = (VIDEOS_URL || '').trim();
    if (site) openBtn.onclick = () => window.open(site, '_blank', 'noopener');
    else openBtn.classList.add('hidden');
  }
  const last = store.get('videos-last');
  if (last) playVideo(last);
}
const playFromBox = () => { const v = $('#videos-url').value.trim(); if (v) playVideo(v); };
$('#videos-play').addEventListener('click', playFromBox);
$('#videos-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); playFromBox(); } });
$('#videos-full').addEventListener('click', () => {
  const box = $('#videos-frame');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (box.requestFullscreen) box.requestFullscreen().catch(() => toast('Fullscreen was blocked.'));
});
