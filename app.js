// Backend URL. For local dev this is your Render backend running
// locally (or localhost:3000). BEFORE DEPLOYING TO VERCEL, change this
// to your deployed Render backend's URL, e.g.
// 'https://your-backend.onrender.com/api'
const API = 'https://varshaai-r3ap.onrender.com/api/';

const SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours of inactivity -> new session

// ---------- Session management ----------
// A "session" is just a client-generated id stamped on every message/reply.
// A new one starts automatically after 4 hours of inactivity, or manually
// via "New chat". Browsing "Sessions" and clicking one re-opens it as the
// active session (you can keep chatting in an old one on purpose).

function getOrCreateSessionId() {
  const stored = localStorage.getItem('sessionId');
  const lastActivity = Number(localStorage.getItem('lastActivity') || 0);
  const expired = !stored || Date.now() - lastActivity > SESSION_TIMEOUT_MS;

  if (expired) {
    const fresh = crypto.randomUUID();
    localStorage.setItem('sessionId', fresh);
    localStorage.setItem('lastActivity', String(Date.now()));
    return fresh;
  }
  return stored;
}

function touchActivity() {
  localStorage.setItem('lastActivity', String(Date.now()));
}

let currentSessionId = getOrCreateSessionId();

function switchToSession(sessionId) {
  currentSessionId = sessionId;
  localStorage.setItem('sessionId', sessionId);
  touchActivity();
  renderedIds.clear();
  feedEl.innerHTML = '';
  refreshFeed();
  closeDrawer(); // no-op on desktop, closes the mobile drawer if open
}

// ---------- Feed: merges Message (user turns) + Notification (assistant/system turns) ----------

const feedEl = document.getElementById('feed');
const renderedIds = new Set();

async function fetchFeedSources() {
  const [messagesRes, notificationsRes] = await Promise.all([
    fetch(`${API}/messages?sessionId=${currentSessionId}`),
    fetch(`${API}/notifications?sessionId=${currentSessionId}`),
  ]);
  const messages = await messagesRes.json();
  const notifications = await notificationsRes.json();
  return { messages, notifications };
}

function buildTimeline(messages, notifications) {
  const items = [];

  messages.forEach((m) =>
    items.push({ id: `msg:${m._id}`, ts: m.createdAt, kind: 'user', text: m.rawText })
  );

  notifications.forEach((n) => {
    if (n.type === 'assistant_reply' || n.type === 'clarification') {
      items.push({ id: `notif:${n._id}`, ts: n.createdAt, kind: 'assistant', text: n.title });
    } else {
      items.push({ id: `notif:${n._id}`, ts: n.createdAt, kind: 'system', text: n.body || n.title });
    }
  });

  return items.sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

function renderItem(item) {
  if (renderedIds.has(item.id)) return;
  renderedIds.add(item.id);

  const emptyState = feedEl.querySelector('.empty-feed');
  if (emptyState) emptyState.remove();

  const el = document.createElement('div');
  if (item.kind === 'system') {
    el.className = 'system-line';
    el.textContent = item.text;
  } else {
    el.className = `bubble ${item.kind}`;
    el.textContent = item.text;
  }
  feedEl.appendChild(el);
  feedEl.scrollTop = feedEl.scrollHeight;
}

async function refreshFeed() {
  const { messages, notifications } = await fetchFeedSources();
  const timeline = buildTimeline(messages, notifications);

  if (timeline.length === 0 && feedEl.children.length === 0) {
    feedEl.innerHTML = '<p class="empty-feed">Tell your assistant what\'s going on — try "Done, I contacted 10 teams."</p>';
    return;
  }
  timeline.forEach(renderItem);
}

// ---------- Composer ----------

const messageInput = document.getElementById('messageInput');

function autoGrow() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${messageInput.scrollHeight}px`;
}
messageInput.addEventListener('input', autoGrow);

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('messageForm').requestSubmit();
  }
});

// Shared by both typed and voice input -- returns the assistant's reply
// text so voice mode can speak it back.
async function sendTextMessage(text) {
  touchActivity();
  const res = await fetch(`${API}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId: currentSessionId }),
  });
  const data = await res.json();
  await refreshFeed();
  loadTopTask();
  loadTasks();
  loadGoals();
  return data.reply;
}

document.getElementById('messageForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  messageInput.value = '';
  autoGrow();
  messageInput.disabled = true;

  try {
    await sendTextMessage(text);
  } finally {
    messageInput.disabled = false;
    messageInput.focus();
  }
});

// ---------- Voice mode (toggle) ----------
// Click the mic once to turn Voice mode ON: the composer disables (no
// typing while in voice mode -- voice and chat are mutually exclusive,
// as requested), it starts listening immediately, and after each reply
// is spoken it automatically starts listening again -- no need to click
// the mic between turns. Click the mic again to turn Voice mode OFF and
// return to normal typing, with no more spoken replies.

const micBtn = document.getElementById('micBtn');
const voiceStatus = document.getElementById('voiceStatus');
const SILENCE_THRESHOLD = 0.02; // RMS amplitude below this counts as silence
const SILENCE_DURATION_MS = 1500;

let voiceModeOn = false;
let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let silenceTimer = null;
let isRecording = false;
let hasDetectedSpeech = false; // reset each turn -- the silence timer is only allowed to fire AFTER real speech was heard, not from turn-start silence

function setVoiceStatus(text) {
  voiceStatus.textContent = text;
}

micBtn.addEventListener('click', () => {
  if (voiceModeOn) {
    turnVoiceModeOff();
  } else {
    turnVoiceModeOn();
  }
});

function turnVoiceModeOn() {
  voiceModeOn = true;
  micBtn.classList.add('active');
  messageInput.disabled = true;
  document.querySelector('.send-btn').disabled = true;
  startRecording();
}

function turnVoiceModeOff() {
  voiceModeOn = false;
  micBtn.classList.remove('active', 'recording');
  messageInput.disabled = false;
  document.querySelector('.send-btn').disabled = false;
  setVoiceStatus('');
  stopRecording();
}

async function startRecording() {
  if (!voiceModeOn) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    isRecording = true;
    hasDetectedSpeech = false;
    micBtn.classList.add('recording');
    setVoiceStatus('Listening…');

    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      handleRecordingComplete();
    };
    mediaRecorder.start();

    setupSilenceDetection(stream);
  } catch (err) {
    console.error('Microphone access failed:', err);
    alert('Could not access the microphone. Check browser permissions.');
    turnVoiceModeOff();
  }
}

function setupSilenceDetection(stream) {
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const data = new Float32Array(analyser.fftSize);

  function checkVolume() {
    if (!isRecording) return;

    analyser.getFloatTimeDomainData(data);
    let sumSquares = 0;
    for (const amplitude of data) sumSquares += amplitude * amplitude;
    const rms = Math.sqrt(sumSquares / data.length);

    if (rms >= SILENCE_THRESHOLD) {
      // Real speech heard -- from now on, silence is meaningful (end of turn).
      hasDetectedSpeech = true;
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
    } else if (hasDetectedSpeech && !silenceTimer) {
      // Only count down to "stop and process" once we've actually heard
      // something this turn -- silence before any speech just means
      // "still waiting for you to start talking," not "end of turn."
      silenceTimer = setTimeout(() => stopRecordingAndProcess(), SILENCE_DURATION_MS);
    }

    requestAnimationFrame(checkVolume);
  }
  checkVolume();
}

// Only used when silence is detected mid-turn (keeps voice mode running).
function stopRecordingAndProcess() {
  stopRecording();
}

// Used both mid-turn and when turning voice mode off entirely.
function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  micBtn.classList.remove('recording');
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

// Whisper (like all speech-to-text models) will sometimes produce a short
// filler transcript from brief or noisy audio rather than admitting it
// heard nothing usable -- these are the common patterns for that. Caught
// here so voice mode doesn't ever send them into the message pipeline.
const HALLUCINATION_PATTERNS = [
  /^\.+$/, // just "." or "..."
  /^(you|thank you\.?|thanks for watching\.?|bye\.?|okay\.?|um+\.?|uh+\.?)$/i,
];

function looksLikeHallucination(text) {
  const trimmed = text.trim();
  if (trimmed.length < 3) return true;
  return HALLUCINATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

async function handleRecordingComplete() {
  if (!voiceModeOn) return; // mode was turned off while this was wrapping up
  if (audioChunks.length === 0 || !hasDetectedSpeech) {
    startRecording(); // nothing real captured -- just keep listening
    return;
  }

  const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
  setVoiceStatus('Thinking…');

  try {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');

    const transcribeRes = await fetch(`${API}/voice/transcribe`, {
      method: 'POST',
      body: formData,
    });
    const { text } = await transcribeRes.json();

    if (!text || looksLikeHallucination(text)) {
      if (voiceModeOn) startRecording(); // likely noise/silence artifact -- keep listening, don't send it
      return;
    }

    const reply = await sendTextMessage(text.trim());
    if (reply && voiceModeOn) {
      await speakReply(reply); // waits for playback to finish
    }
  } catch (err) {
    console.error('Voice turn failed:', err);
  } finally {
    if (voiceModeOn) startRecording(); // loop: listen again for the next turn
  }
}

// Text-to-speech via the browser's built-in Web Speech API
// (speechSynthesis) -- no external library, no CDN, no model download.
// Every modern browser supports this natively. Voice quality is more
// "system voice" than a neural TTS model like Kokoro, but it reliably
// produces actual audio, which is what matters right now.
//
// Returns a Promise that resolves once playback finishes, so the
// listen-speak loop knows when it's safe to start listening again
// (otherwise the mic would pick up the assistant's own voice).
function speakReply(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) {
      console.warn('This browser does not support speechSynthesis -- skipping voice reply.');
      resolve();
      return;
    }

    setVoiceStatus('Speaking…');

    // Cancel anything mid-utterance from a previous turn, just in case.
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onend = () => resolve();
    utterance.onerror = (err) => {
      console.error('Speech synthesis error:', err);
      resolve();
    };

    window.speechSynthesis.speak(utterance);
  });
}

// ---------- Mobile sidebar drawer ----------

const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const menuToggleBtn = document.getElementById('menuToggleBtn');

function openDrawer() {
  sidebar.classList.add('open');
  sidebarBackdrop.classList.add('open');
}
function closeDrawer() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('open');
}

menuToggleBtn.addEventListener('click', () => {
  if (sidebar.classList.contains('open')) closeDrawer();
  else openDrawer();
});
sidebarBackdrop.addEventListener('click', closeDrawer);

// ---------- Sessions panel ----------

const sessionsPanel = document.getElementById('sessionsPanel');

document.getElementById('sessionsBtn').addEventListener('click', async () => {
  sessionsPanel.classList.remove('hidden');
  await loadSessionsList();
});
document.getElementById('closeSessionsBtn').addEventListener('click', () => {
  sessionsPanel.classList.add('hidden');
});

document.getElementById('newChatBtn').addEventListener('click', () => {
  const fresh = crypto.randomUUID();
  switchToSession(fresh);
});

document.getElementById('deleteChatBtn').addEventListener('click', async () => {
  if (!confirm('Delete this entire conversation? This cannot be undone.')) return;
  await fetch(`${API}/sessions/${currentSessionId}`, { method: 'DELETE' });
  const fresh = crypto.randomUUID();
  switchToSession(fresh);
});

async function loadSessionsList() {
  const res = await fetch(`${API}/sessions`);
  const sessions = await res.json();

  const list = document.getElementById('sessionsList');
  list.innerHTML = '';

  if (sessions.length === 0) {
    list.innerHTML = '<li>No past sessions yet.</li>';
    return;
  }

  sessions.forEach((s) => {
    const li = document.createElement('li');
    li.className = 'session-row';
    const started = new Date(s.startedAt).toLocaleString();
    li.innerHTML = `
      <span class="session-preview">${s.preview || '(empty)'}</span>
      <span class="session-meta">
        <span>${started} · ${s.messageCount} msg${s.messageCount === 1 ? '' : 's'}</span>
        <button class="session-delete" data-id="${s.sessionId}">delete</button>
      </span>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('session-delete')) return;
      switchToSession(s.sessionId);
      sessionsPanel.classList.add('hidden');
    });
    list.appendChild(li);
  });

  list.querySelectorAll('.session-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this session?')) return;
      await fetch(`${API}/sessions/${btn.dataset.id}`, { method: 'DELETE' });
      if (btn.dataset.id === currentSessionId) {
        switchToSession(crypto.randomUUID());
      }
      loadSessionsList();
    });
  });
}

// ---------- Capacity ----------

async function loadCapacity() {
  const res = await fetch(`${API}/capacity/today`);
  const data = await res.json();
  if (data.hours != null) document.getElementById('capacityInput').value = data.hours;
}

document.getElementById('setCapacityBtn').addEventListener('click', async () => {
  const hours = Number(document.getElementById('capacityInput').value);
  if (!hours && hours !== 0) return;
  await fetch(`${API}/capacity/today`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hours }),
  });
  loadTopTask();
});

// ---------- Today's #1 ----------

async function loadTopTask() {
  const res = await fetch(`${API}/tasks/top`);
  const data = await res.json();
  document.getElementById('topTaskText').textContent = data.topTask
    ? data.topTask.title
    : 'Nothing pending — set your capacity or add a task.';
}

// ---------- Goals ----------

let cachedGoals = [];

async function loadGoals() {
  const res = await fetch(`${API}/goals?status=active`);
  const goals = await res.json();
  cachedGoals = goals;

  const list = document.getElementById('goalList');
  list.innerHTML = '';
  goals.forEach((g) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${g.title}</span>
      <span class="task-row-actions">
        <span class="weight-tag ${g.weight}">${g.weight}</span>
        <button class="delete-x" data-id="${g._id}" title="Delete goal">×</button>
      </span>`;
    list.appendChild(li);
  });

  list.querySelectorAll('.delete-x').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this goal? Its tasks will become standalone, not deleted.')) return;
      await fetch(`${API}/goals/${btn.dataset.id}`, { method: 'DELETE' });
      loadGoals();
      loadTasks();
    });
  });

  populateTaskGoalSelect(document.getElementById('taskGoal'), goals, '');
}

function populateTaskGoalSelect(select, goals, currentValue) {
  select.innerHTML = '<option value="">no goal</option>';
  goals.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g._id;
    opt.textContent = g.title;
    select.appendChild(opt);
  });
  select.value = currentValue || '';
}

document.getElementById('goalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('goalTitle').value;
  const weight = document.getElementById('goalWeight').value;
  await fetch(`${API}/goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, weight }),
  });
  document.getElementById('goalTitle').value = '';
  loadGoals();
});

// ---------- Tasks ----------

async function loadTasks() {
  const res = await fetch(`${API}/tasks/pending`);
  const tasks = await res.json();

  const list = document.getElementById('taskList');
  list.innerHTML = '';
  tasks.forEach((t) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${t.title}</span>
      <span class="task-row-actions">
        <select class="task-goal-select" data-id="${t._id}"></select>
        <button class="done-btn" data-id="${t._id}">done</button>
        <button class="delete-x" data-id="${t._id}" title="Delete task">×</button>
      </span>`;
    list.appendChild(li);

    const select = li.querySelector('.task-goal-select');
    populateTaskGoalSelect(select, cachedGoals, t.goalId || '');
  });

  list.querySelectorAll('.task-goal-select').forEach((select) => {
    select.addEventListener('change', async () => {
      await fetch(`${API}/tasks/${select.dataset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goalId: select.value || null }),
      });
      loadTopTask();
    });
  });

  list.querySelectorAll('.done-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`${API}/tasks/${btn.dataset.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      });
      loadTasks();
      loadTopTask();
    });
  });

  list.querySelectorAll('.delete-x').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this task?')) return;
      await fetch(`${API}/tasks/${btn.dataset.id}`, { method: 'DELETE' });
      loadTasks();
      loadTopTask();
    });
  });
}

document.getElementById('taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('taskTitle').value;
  const goalId = document.getElementById('taskGoal').value || null;
  await fetch(`${API}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, goalId }),
  });
  document.getElementById('taskTitle').value = '';
  loadTasks();
  loadTopTask();
});

// ---------- Reviews ----------

document.getElementById('eveningReviewBtn').addEventListener('click', async () => {
  await fetch(`${API}/reviews/evening`, { method: 'POST' });
  refreshFeed();
  closeDrawer();
});
document.getElementById('weeklyReviewBtn').addEventListener('click', async () => {
  await fetch(`${API}/reviews/weekly`, { method: 'POST' });
  refreshFeed();
  closeDrawer();
});

// ---------- Initial load + background polling ----------

refreshFeed();
loadCapacity();
loadTopTask();
loadGoals().then(loadTasks);

setInterval(refreshFeed, 5000);