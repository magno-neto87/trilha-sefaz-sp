"use strict";

const STORAGE_KEYS = {
  attempts: "trilha-attempts-v1",
  maps: "trilha-maps-v1",
  eliminated: "trilha-eliminated-v1",
  simulations: "trilha-simulations-v1",
  completedMaterials: "trilha-completed-materials-v1",
  contentListView: "trilha-content-list-view-v1",
  studyWeights: "trilha-study-weights-v1",
  weeklySchedule: "trilha-weekly-schedule-v1",
  automaticPlan: "trilha-automatic-plan-v1",
  studyEvents: "trilha-study-events-v1",
  studyGoals: "trilha-study-goals-v1",
  studyDiary: "trilha-study-diary-v1",
  questionReviews: "trilha-question-reviews-v1",
  studyTimer: "trilha-study-timer-v1",
  pomodoroSessions: "trilha-pomodoro-sessions-v1",
  materialReviews: "trilha-material-reviews-v1",
};
const state = {
  manifest: null,
  activeTab: "dashboard",
  subjectId: null,
  subjectCache: new Map(),
  questionIndexCache: null,
  activeMaterialId: null,
  questionIndex: 0,
  questionMode: "practice",
  randomQuestionIds: null,
  randomAnsweredIds: new Set(),
  questionBankCache: new Map(),
  simulation: null,
  flashcardIndex: 0,
  flashcardFlipped: false,
  questionTimer: null,
  calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  timerInterval: null,
  reviewQuestionId: null,
  supabase: null,
  authUser: null,
  authLoaded: false,
  cloudReady: false,
  cloudSaveTimer: null,
  cloudSavePromise: Promise.resolve(true),
  pendingImportKey: null,
  clearLocalOnSignOut: false,
  authMode: "login",
  authLoading: false,
  authGeneration: 0,
};
const view = document.getElementById("view");
const notice = document.getElementById("notice");
const breadcrumb = document.getElementById("breadcrumb");

function readStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    console.error(`Não foi possível ler ${key} do armazenamento local.`, error);
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    queueCloudSave();
  } catch (error) {
    console.error(`Não foi possível salvar ${key} no armazenamento local.`, error);
    showNotice("Não foi possível salvar seu progresso neste dispositivo. Verifique o espaço disponível no navegador.");
  }
}

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
}

function getProgressSnapshot() {
  return Object.fromEntries(Object.values(STORAGE_KEYS).flatMap((key) => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? [] : [[key, JSON.parse(raw)]];
    } catch (error) {
      console.error(`Não foi possível preparar ${key} para sincronização.`, error);
      return [];
    }
  }));
}

function hasProgress(snapshot) {
  return Object.values(snapshot).some((value) => (
    Array.isArray(value) ? value.length > 0
      : value && typeof value === "object" ? Object.keys(value).length > 0
        : value !== null && value !== undefined && value !== ""
  ));
}

function applyProgressSnapshot(snapshot) {
  for (const key of Object.values(STORAGE_KEYS)) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
      localStorage.setItem(key, JSON.stringify(snapshot[key]));
    } else {
      localStorage.removeItem(key);
    }
  }
}

function mergeProgressSnapshots(local, remote) {
  const merged = {};
  for (const key of Object.values(STORAGE_KEYS)) {
    const localValue = local[key];
    const remoteValue = remote[key];
    if (Array.isArray(localValue) && Array.isArray(remoteValue)) {
      const items = new Map();
      for (const item of [...remoteValue, ...localValue]) {
        const identity = item && typeof item === "object" && item.id
          ? `id:${item.id}`
          : JSON.stringify(item);
        items.set(identity, item);
      }
      merged[key] = [...items.values()];
    } else if (
      localValue && typeof localValue === "object" && !Array.isArray(localValue)
      && remoteValue && typeof remoteValue === "object" && !Array.isArray(remoteValue)
    ) {
      merged[key] = { ...localValue, ...remoteValue };
    } else {
      merged[key] = remoteValue ?? localValue;
    }
  }
  return merged;
}

function setSyncStatus(message, stateName = "local") {
  const label = document.getElementById("sync-label");
  const indicator = document.getElementById("sync-indicator");
  if (!label || !indicator) return;
  label.textContent = message;
  indicator.classList.toggle("sync-error", stateName === "error");
  indicator.title = stateName === "error" ? "Falha na sincronização" : message;
}

function showAuthMessage(elementId, message) {
  const element = document.getElementById(elementId);
  element.textContent = message;
  element.hidden = false;
}

function updateAccountUi() {
  const configured = Boolean(state.supabase);
  const hasUser = Boolean(state.authUser);
  document.getElementById("auth-setup").hidden = configured;
  document.getElementById("auth-guest").hidden = !configured || hasUser;
  document.getElementById("auth-user").hidden = !configured || !hasUser;
  document.getElementById("account-button").textContent = hasUser ? "Minha conta" : "Entrar";
  if (!hasUser) return;

  document.getElementById("auth-user-email").textContent = state.authUser.email || "Conta conectada";
  const pendingImport = state.cloudReady && state.pendingImportKey && localStorage.getItem(state.pendingImportKey);
  document.getElementById("import-local-history").hidden = !pendingImport;
  document.getElementById("auth-cloud-message").textContent = pendingImport
    ? "Há um histórico deste dispositivo preservado separadamente. Você pode mesclá-lo com o histórico da conta."
    : state.cloudReady
      ? "Seu progresso é sincronizado com esta conta."
      : "A conta está conectada, mas o histórico ainda não foi carregado. Verifique a configuração do Supabase.";
}

function setAuthMode(mode) {
  state.authMode = mode;
  const recovery = mode === "recovery";
  const email = document.getElementById("auth-email");
  const password = document.getElementById("auth-password");
  document.getElementById("auth-email-label").hidden = recovery;
  email.hidden = recovery;
  email.required = !recovery;
  document.getElementById("auth-password-label").textContent = recovery ? "Nova senha" : "Senha";
  password.autocomplete = recovery || mode === "signup" ? "new-password" : "current-password";
  password.minLength = recovery || mode === "signup" ? 8 : 0;
  document.getElementById("auth-submit").textContent = recovery
    ? "Salvar nova senha"
    : mode === "signup" ? "Criar conta" : "Entrar";
  document.getElementById("auth-reset-password").hidden = mode !== "login";
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.hidden = recovery;
    button.classList.toggle("selected", button.dataset.authMode === mode);
  });
  document.getElementById("auth-message").hidden = true;
}

function pendingImportStorageKey(userId) {
  return `trilha-pending-import-v1:${userId}`;
}

function storePendingImport(key, snapshot) {
  const existingRaw = localStorage.getItem(key);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};
  const merged = mergeProgressSnapshots(snapshot, existing);
  localStorage.setItem(key, JSON.stringify(merged));
}

async function loadCloudProgress(user, generation) {
  state.pendingImportKey = pendingImportStorageKey(user.id);
  const localSnapshot = getProgressSnapshot();
  const { data, error } = await state.supabase
    .from("user_progress")
    .select("data")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (state.authGeneration !== generation || state.authUser?.id !== user.id) return;

  if (data?.data && typeof data.data === "object") {
    if (hasProgress(localSnapshot)) storePendingImport(state.pendingImportKey, localSnapshot);
    applyProgressSnapshot(data.data);
  } else if (hasProgress(localSnapshot)) {
    storePendingImport(state.pendingImportKey, localSnapshot);
    applyProgressSnapshot({});
  }
  state.cloudReady = true;
}

async function handleAuthSession(session) {
  const nextUser = session?.user || null;
  if (nextUser && state.authUser?.id === nextUser.id && (state.cloudReady || state.authLoading)) return;
  const generation = ++state.authGeneration;
  if (!nextUser) {
    if (state.authUser && state.clearLocalOnSignOut && state.cloudReady) {
      for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
    }
    state.authUser = null;
    state.authLoaded = true;
    state.cloudReady = false;
    state.authLoading = false;
    state.clearLocalOnSignOut = false;
    state.pendingImportKey = null;
    updateAccountUi();
    setSyncStatus("Salvo neste dispositivo");
    return;
  }

  state.authUser = nextUser;
  state.pendingImportKey = pendingImportStorageKey(nextUser.id);
  state.authLoaded = false;
  state.cloudReady = false;
  state.authLoading = true;
  updateAccountUi();
  setSyncStatus("Carregando seu histórico...");
  try {
    await loadCloudProgress(nextUser, generation);
    if (state.authGeneration !== generation || state.authUser?.id !== nextUser.id) return;
    state.authLoaded = true;
    setSyncStatus(localStorage.getItem(state.pendingImportKey)
      ? "Histórico local aguardando importação"
      : "Histórico sincronizado", "cloud");
  } catch (error) {
    if (state.authGeneration !== generation || state.authUser?.id !== nextUser.id) return;
    console.error("Não foi possível carregar o histórico da conta.", error);
    state.authLoaded = true;
    setSyncStatus("Falha ao carregar histórico", "error");
    showNotice(`A conta foi conectada, mas não foi possível carregar o histórico: ${error.message}`);
  } finally {
    if (state.authGeneration === generation) state.authLoading = false;
  }
  updateAccountUi();
  if (state.manifest && state.cloudReady) setTab(state.activeTab);
}

function saveCloudProgressNow() {
  if (!state.supabase || !state.authUser || !state.cloudReady) return Promise.resolve(false);
  if (state.cloudSaveTimer) {
    clearTimeout(state.cloudSaveTimer);
    state.cloudSaveTimer = null;
  }
  const userId = state.authUser.id;
  const snapshot = getProgressSnapshot();
  state.cloudSavePromise = state.cloudSavePromise.catch(() => false).then(async () => {
    if (state.authUser?.id !== userId || !state.cloudReady) return false;
    const { error } = await state.supabase.from("user_progress").upsert({
      user_id: userId,
      data: snapshot,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) throw error;
    if (state.authUser?.id === userId) setSyncStatus("Histórico sincronizado", "cloud");
    return true;
  });
  return state.cloudSavePromise;
}

function queueCloudSave() {
  if (!state.supabase || !state.authUser || !state.cloudReady) return;
  if (state.cloudSaveTimer) clearTimeout(state.cloudSaveTimer);
  setSyncStatus("Sincronizando...", "cloud");
  state.cloudSaveTimer = setTimeout(() => {
    state.cloudSaveTimer = null;
    saveCloudProgressNow().catch((error) => {
      console.error("Não foi possível sincronizar o histórico.", error);
      setSyncStatus("Falha na sincronização", "error");
      showNotice(`Seu progresso continua salvo neste dispositivo, mas não foi sincronizado: ${error.message}`);
    });
  }, 700);
}

async function importLocalHistory() {
  if (!state.pendingImportKey || !state.authUser) return;
  const button = document.getElementById("import-local-history");
  const message = document.getElementById("auth-user-message");
  button.disabled = true;
  message.hidden = true;
  try {
    const localRaw = localStorage.getItem(state.pendingImportKey);
    if (!localRaw) throw new Error("Não há histórico local pendente para importar.");
    const pending = JSON.parse(localRaw);
    const { data, error } = await state.supabase
      .from("user_progress")
      .select("data")
      .eq("user_id", state.authUser.id)
      .maybeSingle();
    if (error) throw error;
    const merged = mergeProgressSnapshots(pending, data?.data || {});
    applyProgressSnapshot(merged);
    const saved = await saveCloudProgressNow();
    if (!saved) throw new Error("A conta mudou ou a conexão ainda não está pronta.");
    localStorage.removeItem(state.pendingImportKey);
    updateAccountUi();
    showAuthMessage("auth-user-message", "Histórico mesclado e sincronizado com sucesso.");
    if (state.manifest) setTab(state.activeTab);
  } catch (error) {
    console.error("Não foi possível importar o histórico local.", error);
    showAuthMessage("auth-user-message", `Não foi possível importar: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function loadSupabaseSdk() {
  if (window.supabase?.createClient) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.min.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Não foi possível carregar o cliente do Supabase."));
    document.head.append(script);
  });
  if (!window.supabase?.createClient) throw new Error("O cliente do Supabase não foi inicializado.");
}

async function initializeAuth() {
  const config = window.TRILHA_SUPABASE_CONFIG;
  bindAuthEvents();
  if (!config?.url || !config?.publishableKey) {
    updateAccountUi();
    setSyncStatus("Salvo neste dispositivo");
    return;
  }

  try {
    await loadSupabaseSdk();
    state.supabase = window.supabase.createClient(config.url, config.publishableKey);
    state.supabase.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION") return;
      if (event === "PASSWORD_RECOVERY") {
        setAuthMode("recovery");
        document.getElementById("account-dialog").showModal();
      }
      handleAuthSession(session).catch((error) => {
        console.error("Não foi possível atualizar a sessão da conta.", error);
        showNotice(`Não foi possível atualizar sua conta: ${error.message}`);
      });
    });
    const { data, error } = await state.supabase.auth.getSession();
    if (error) throw error;
    await handleAuthSession(data.session);
    updateAccountUi();
  } catch (error) {
    console.error("Não foi possível iniciar o Supabase.", error);
    state.supabase = null;
    updateAccountUi();
    setSyncStatus("Falha ao conectar", "error");
    showNotice(`Não foi possível iniciar login e sincronização: ${error.message}`);
  }
}

function bindAuthEvents() {
  document.getElementById("account-button").addEventListener("click", () => {
    updateAccountUi();
    document.getElementById("account-dialog").showModal();
  });
  document.getElementById("account-dialog-close").addEventListener("click", () => {
    document.getElementById("account-dialog").close();
  });
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
  });
  document.getElementById("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.supabase) return;
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    const submit = document.getElementById("auth-submit");
    submit.disabled = true;
    document.getElementById("auth-message").hidden = true;
    try {
      if (state.authMode === "recovery") {
        const { error } = await state.supabase.auth.updateUser({ password });
        if (error) throw error;
        setAuthMode("login");
        showAuthMessage("auth-message", "Senha alterada. Agora você já pode entrar.");
        return;
      }
      if (state.authMode === "signup") {
        const { data, error } = await state.supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          setAuthMode("login");
          showAuthMessage("auth-message", "Conta criada. Confira seu e-mail para confirmar o cadastro e depois entre.");
        } else {
          document.getElementById("account-dialog").close();
        }
        return;
      }
      const { data, error } = await state.supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await handleAuthSession(data.session);
      document.getElementById("account-dialog").close();
    } catch (error) {
      console.error("A autenticação falhou.", error);
      showAuthMessage("auth-message", error.message);
    } finally {
      submit.disabled = false;
    }
  });
  document.getElementById("auth-reset-password").addEventListener("click", async () => {
    if (!state.supabase) return;
    const emailInput = document.getElementById("auth-email");
    if (!emailInput.reportValidity()) return;
    try {
      const { error } = await state.supabase.auth.resetPasswordForEmail(emailInput.value.trim(), {
        redirectTo: window.location.href,
      });
      if (error) throw error;
      showAuthMessage("auth-message", "Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.");
    } catch (error) {
      console.error("Não foi possível solicitar a redefinição de senha.", error);
      showAuthMessage("auth-message", `Não foi possível enviar o link: ${error.message}`);
    }
  });
  document.getElementById("import-local-history").addEventListener("click", importLocalHistory);
  document.getElementById("auth-sign-out").addEventListener("click", async () => {
    const button = document.getElementById("auth-sign-out");
    button.disabled = true;
    try {
      const saved = await saveCloudProgressNow();
      state.clearLocalOnSignOut = saved;
      const { error } = await state.supabase.auth.signOut();
      if (error) throw error;
      document.getElementById("account-dialog").close();
    } catch (error) {
      state.clearLocalOnSignOut = false;
      console.error("Não foi possível sair da conta.", error);
      showAuthMessage("auth-user-message", `Não foi possível sair da conta: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });
  setAuthMode("login");
  updateAccountUi();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function safeHref(raw) {
  try {
    const url = new URL(raw, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function inlineMarkdown(value) {
  const codeTokens = [];
  let text = escapeHtml(value.replace(/<br\s*\/?>/gi, "\n"));
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@CODE${codeTokens.length}@@`;
    codeTokens.push(`<code>${code}</code>`);
    return token;
  });
  text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_, alt, url) => {
    const safe = safeHref(url);
    return safe ? `<span class="image-alt">[Imagem: ${alt || "visual"}</span>` : "";
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
    const safe = safeHref(url);
    return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  text = text.replace(/\*\*(.+?)\*\*|__(.+?)__/g, "<strong>$1$2</strong>");
  text = text.replace(/\*(.+?)\*|_(.+?)_/g, "<em>$1$2</em>");
  text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");
  text = text.replace(/@@CODE(\d+)@@/g, (_, index) => codeTokens[Number(index)]);
  return text;
}

function renderMarkdown(markdown) {
  if (!markdown?.trim()) return '<p class="empty-state">Este material ainda não possui texto teórico separado.</p>';
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listType = "";
  let tableRows = [];
  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (listType) html.push(`</${listType}>`);
    listType = "";
  };
  const flushTable = () => {
    if (!tableRows.length) return;
    const rows = tableRows.filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line));
    if (rows.length) {
      const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      const header = cells(rows[0]);
      const body = rows.slice(1).map(cells);
      html.push(`<table><thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    }
    tableRows = [];
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    const list = line.match(/^([-*+]|\d+[.)])\s+(.+)$/);
    if (line.includes("|") && /^\|?.+\|.+\|?$/.test(line)) {
      flushParagraph(); flushList(); tableRows.push(line); continue;
    }
    flushTable();
    if (!line) { flushParagraph(); flushList(); continue; }
    if (heading) {
      flushParagraph(); flushList();
      const level = Math.min(heading[1].length, 4);
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
    } else if (list) {
      flushParagraph();
      const nextType = /^\d/.test(list[1]) ? "ol" : "ul";
      if (listType !== nextType) { flushList(); listType = nextType; html.push(`<${listType}>`); }
      html.push(`<li>${inlineMarkdown(list[2])}</li>`);
    } else if (/^>\s?/.test(line)) {
      flushParagraph(); flushList();
      html.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`);
    } else if (/^([-*_]\s*){3,}$/.test(line)) {
      flushParagraph(); flushList(); html.push("<hr>");
    } else {
      flushList(); paragraph.push(line);
    }
  }
  flushParagraph(); flushList(); flushTable();
  return html.join("\n");
}

function getAttempts() {
  const attempts = readStorage(STORAGE_KEYS.attempts, []);
  return Array.isArray(attempts) ? attempts : [];
}

async function loadQuestionIndex() {
  if (state.questionIndexCache) return state.questionIndexCache;
  const file = state.manifest.questionIndexFile || "question-index.json";
  try {
    const response = await fetch(`data/${file}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Não foi possível carregar o índice de assuntos e bancas (${response.status}).`);
    const data = await response.json();
    state.questionIndexCache = new Map((data.questions || []).map((question) => [question.id, question]));
  } catch (error) {
    console.error(error);
    state.questionIndexCache = new Map();
    showNotice("Assuntos e bancas não estão indexados. Rode novamente python extractor.py para atualizar os dados.");
  }
  return state.questionIndexCache;
}

function startQuestionTimer(questionId, mode) {
  if (state.questionTimer?.questionId === questionId && state.questionTimer.mode === mode) return;
  state.questionTimer = { questionId, mode, startedAt: Date.now() };
}

function stopQuestionTimer(questionId, mode) {
  const timer = state.questionTimer;
  if (!timer || timer.questionId !== questionId || timer.mode !== mode) return null;
  state.questionTimer = null;
  const seconds = Math.round((Date.now() - timer.startedAt) / 1000);
  return seconds <= 3600 ? seconds : null;
}

function selectedSubject() {
  return state.manifest?.subjects.find((subject) => subject.id === state.subjectId) || state.manifest?.subjects[0] || null;
}

async function loadSubject(subjectId = state.subjectId) {
  const subject = state.manifest.subjects.find((item) => item.id === subjectId);
  if (!subject) throw new Error("Disciplina não encontrada no índice de materiais.");
  if (state.subjectCache.has(subjectId)) return state.subjectCache.get(subjectId);
  const response = await fetch(`data/${subject.file}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Não foi possível carregar os materiais de ${subject.name} (${response.status}).`);
  const data = await response.json();
  state.subjectCache.set(subjectId, data);
  return data;
}

function setTab(tab) {
  if (!state.manifest) return;
  state.activeTab = tab;
  document.querySelectorAll(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  breadcrumb.textContent = {
    dashboard: "Visão geral", contents: "Conteúdos", questions: "Questões",
    mindmaps: "Mapas mentais", flashcards: "Flashcards", organization: "Organização dos estudos",
  }[tab];
  if (tab === "dashboard") renderDashboard();
  if (tab === "contents") renderContents();
  if (tab === "questions") renderQuestions();
  if (tab === "mindmaps") renderMindmaps();
  if (tab === "flashcards") renderFlashcards();
  if (tab === "organization") renderOrganization();
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("mobile-scrim").classList.remove("visible");
}

function setSubject(subjectId) {
  state.subjectId = subjectId;
  document.querySelectorAll(".subject-link").forEach((button) => button.classList.toggle("selected", button.dataset.subjectId === subjectId));
  state.activeMaterialId = null;
  state.questionIndex = 0;
  state.randomQuestionIds = null;
  state.randomAnsweredIds = new Set();
  state.questionMode = "practice";
  state.simulation = null;
  state.flashcardIndex = 0;
  if (state.activeTab === "contents") renderContents();
  if (state.activeTab === "questions") renderQuestions();
  if (state.activeTab === "mindmaps") renderMindmaps();
  if (state.activeTab === "flashcards") renderFlashcards();
}

function buildNavigation() {
  const subjects = state.manifest.subjects;
  document.getElementById("subject-count").textContent = subjects.length;
  document.getElementById("question-count").textContent = state.manifest.totals.questions.toLocaleString("pt-BR");
  document.getElementById("subject-list").innerHTML = subjects.map((subject) =>
    `<button class="subject-link ${subject.id === state.subjectId ? "selected" : ""}" data-subject-id="${subject.id}" title="${escapeHtml(subject.name)}"><span class="subject-dot"></span><span>${escapeHtml(subject.name)}</span></button>`
  ).join("");
  document.querySelectorAll(".subject-link").forEach((button) => button.addEventListener("click", () => setSubject(button.dataset.subjectId)));
}

async function renderDashboard() {
  view.innerHTML = '<div class="loading-state"><span class="spinner"></span><span>Preparando seus indicadores...</span></div>';
  const [storedAttempts, questionIndex] = await Promise.all([Promise.resolve(getAttempts()), loadQuestionIndex()]);
  if (state.activeTab !== "dashboard") return;
  const attempts = storedAttempts.map((attempt) => {
    const metadata = questionIndex.get(attempt.questionId) || {};
    return {
      ...metadata,
      ...attempt,
      topic: attempt.topic || metadata.topic || "",
      bank: attempt.bank || metadata.bank || "",
    };
  });
  const correct = attempts.filter((item) => item.correct).length;
  const wrong = attempts.length - correct;
  const accuracy = attempts.length ? Math.round((correct / attempts.length) * 100) : 0;
  const subjectById = new Map(state.manifest.subjects.map((subject) => [subject.id, subject]));
  const groupAttempts = (items, getKey) => {
    const groups = new Map();
    for (const item of items) {
      const key = getKey(item);
      if (!key) continue;
      const group = groups.get(key) || { key, total: 0, correct: 0 };
      group.total += 1;
      if (item.correct) group.correct += 1;
      groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({
      ...group,
      accuracy: Math.round(group.correct / group.total * 100),
    }));
  };
  const subjectMetrics = groupAttempts(attempts, (attempt) => attempt.subjectId)
    .map((metric) => ({ ...metric, name: subjectById.get(metric.key)?.name || "Disciplina não identificada" }))
    .sort((a, b) => b.accuracy - a.accuracy || b.total - a.total);
  const subjectPerformance = subjectMetrics.length
    ? subjectMetrics.map(({ name, total, accuracy: rate }) => `<div class="performance-row"><div class="performance-label"><span title="${escapeHtml(name)}">${escapeHtml(name)}</span><strong>${rate}% · ${total}</strong></div><div class="progress-track"><div class="progress-fill" style="width:${rate}%"></div></div></div>`).join("")
    : '<div class="empty-chart">Responda questões para ver seu desempenho por disciplina.</div>';
  const topicMetrics = groupAttempts(
    attempts,
    (attempt) => attempt.topic ? `${attempt.subjectId}\u0000${attempt.topic}` : "",
  ).map((metric) => {
    const [subjectId, topic] = metric.key.split("\u0000");
    return { ...metric, topic, subjectName: subjectById.get(subjectId)?.name || "Disciplina não identificada" };
  }).sort((a, b) => b.total - a.total || a.accuracy - b.accuracy);
  const bankMetrics = groupAttempts(attempts, (attempt) => attempt.bank)
    .sort((a, b) => a.accuracy - b.accuracy || b.total - a.total);
  const topicPerformance = topicMetrics.length
    ? [...topicMetrics].sort((a, b) => a.accuracy - b.accuracy || b.total - a.total).slice(0, 10).map((metric) => `<div class="performance-row"><div class="performance-label"><span title="${escapeHtml(metric.topic)}">${escapeHtml(metric.topic)} <small>· ${escapeHtml(metric.subjectName)}</small></span><strong>${metric.accuracy}% · ${metric.total}</strong></div><div class="progress-track"><div class="progress-fill" style="width:${metric.accuracy}%"></div></div></div>`).join("")
    : '<div class="empty-chart">Os assuntos aparecem quando o índice de materiais for atualizado e houver questões respondidas.</div>';
  const bankPerformance = bankMetrics.length
    ? bankMetrics.map((metric) => `<div class="performance-row"><div class="performance-label"><span>${escapeHtml(metric.key)}</span><strong>${metric.accuracy}% · ${metric.total}</strong></div><div class="progress-track"><div class="progress-fill" style="width:${metric.accuracy}%"></div></div></div>`).join("")
    : '<div class="empty-chart">Sem banca identificada no histórico. A classificação depende do formato dos arquivos de origem.</div>';
  const datedAttempts = attempts.map((attempt) => ({ ...attempt, date: new Date(attempt.answeredAt) }))
    .filter((attempt) => Number.isFinite(attempt.date.getTime()));
  const now = new Date();
  const currentWeekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const weekStartAt = (weeksAgo) => {
    const date = new Date(currentWeekStart);
    date.setDate(date.getDate() - weeksAgo * 7);
    return date;
  };
  const weekStats = (weeksAgo) => {
    const start = weekStartAt(weeksAgo);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const items = datedAttempts.filter((attempt) => attempt.date >= start && attempt.date < end);
    const hits = items.filter((attempt) => attempt.correct).length;
    return { start, total: items.length, correct: hits, accuracy: items.length ? Math.round(hits / items.length * 100) : null };
  };
  const currentWeek = weekStats(0);
  const previousWeek = weekStats(1);
  const weekDelta = currentWeek.accuracy !== null && previousWeek.accuracy !== null
    ? currentWeek.accuracy - previousWeek.accuracy
    : null;
  const trend = Array.from({ length: 8 }, (_, index) => weekStats(7 - index));
  const trendChart = datedAttempts.length
    ? `<div class="trend-chart" role="img" aria-label="Taxa de acerto semanal nas últimas oito semanas">${trend.map((week) => `<div class="trend-column" title="${week.accuracy === null ? "Sem respostas" : `${week.accuracy}% em ${week.total} questões`}"><strong>${week.accuracy === null ? "—" : `${week.accuracy}%`}</strong><div class="trend-track"><span class="trend-bar" style="height:${week.accuracy === null ? 3 : Math.max(week.accuracy, 4)}%"></span></div><small>${week.start.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}</small></div>`).join("")}</div>`
    : '<div class="empty-chart">A evolução aparece quando houver tentativas com data registrada.</div>';
  const timeSamples = attempts
    .filter((attempt) => attempt.durationSeconds !== null && attempt.durationSeconds !== undefined && attempt.durationSeconds !== "")
    .map((attempt) => Number(attempt.durationSeconds))
    .filter((seconds) => Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600);
  const averageSeconds = timeSamples.length
    ? Math.round(timeSamples.reduce((sum, seconds) => sum + seconds, 0) / timeSamples.length)
    : null;
  const formatDuration = (seconds) => `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  const heatmap = topicMetrics.length
    ? `<div class="topic-heatmap">${topicMetrics.slice(0, 30).map((metric) => {
      const level = metric.total < 3 ? "practice" : metric.accuracy >= 75 ? "mastered" : metric.accuracy < 50 ? "attention" : "developing";
      const status = { practice: "Em prática", mastered: "Dominado", attention: "Atenção", developing: "Em desenvolvimento" }[level];
      return `<div class="heat-cell ${level}" title="${escapeHtml(metric.subjectName)} · ${escapeHtml(metric.topic)}"><span>${escapeHtml(metric.topic)}</span><strong>${metric.accuracy}%</strong><small>${metric.total} questões · ${status}</small></div>`;
    }).join("")}</div>`
    : '<div class="empty-chart">Sem dados por assunto para montar o mapa de calor.</div>';
  const prediction = attempts.length >= 10
    ? `${Math.round((correct + 1) / (attempts.length + 2) * 100)}%`
    : "Aguardando histórico";
  const predictionNote = attempts.length >= 10
    ? `Estimativa suavizada com ${attempts.length} respostas; não é garantia de resultado.`
    : `São necessárias ao menos 10 respostas; há ${attempts.length} no histórico.`;
  const weekCard = (label, metric) => `<div class="period-stat"><span>${label}</span><strong>${metric.accuracy === null ? "—" : `${metric.accuracy}%`}</strong><small>${metric.correct} acertos · ${metric.total} questões</small></div>`;
  const periodChange = weekDelta === null
    ? "Sem dados suficientes nas duas semanas para calcular a variação."
    : `${weekDelta > 0 ? "+" : ""}${weekDelta} p.p. em relação à semana passada.`;
  view.innerHTML = `
    <div class="page-heading"><div><p class="eyebrow">PLATAFORMA DE CONCURSO</p><div class="page-badge">SEFAZ-SP</div><h1>Preparação estratégica</h1><p class="page-subtitle">Acompanhe seu ritmo, revise conteúdos e converta estudo em desempenho real na prova.</p></div><button class="button" data-action="continue">Continuar rotina <span>→</span></button></div>
    <div class="stats-grid">
      <article class="card stat-card"><div class="stat-top"><span>Taxa geral de acertos</span><span class="stat-icon">↗</span></div><div class="stat-value">${accuracy}%</div><div class="stat-note">${correct} acertos · ${wrong} erros</div></article>
      <article class="card stat-card"><div class="stat-top"><span>Questões respondidas</span><span class="stat-icon">☑</span></div><div class="stat-value">${attempts.length.toLocaleString("pt-BR")}</div><div class="stat-note">Histórico salvo neste dispositivo</div></article>
      <article class="card stat-card"><div class="stat-top"><span>Tempo médio por questão</span><span class="stat-icon">◷</span></div><div class="stat-value">${averageSeconds === null ? "—" : formatDuration(averageSeconds)}</div><div class="stat-note">${timeSamples.length ? `${timeSamples.length} tempos registrados` : "Disponível nas novas respostas"}</div></article>
      <article class="card stat-card"><div class="stat-top"><span>Previsão de desempenho</span><span class="stat-icon">⌁</span></div><div class="stat-value prediction-value">${prediction}</div><div class="stat-note">${predictionNote}</div></article>
    </div>
    <div class="dashboard-insights-grid">
      <article class="card panel"><div class="panel-heading"><div><h2>Desempenho por disciplina</h2><p>Precisão nas matérias praticadas · acertos / respostas</p></div></div><div class="subject-performance">${subjectPerformance}</div></article>
      <article class="card panel"><div class="panel-heading"><div><h2>Comparação de períodos</h2><p>Semana atual versus semana anterior</p></div></div><div class="period-comparison">${weekCard("Esta semana", currentWeek)}${weekCard("Semana passada", previousWeek)}</div><p class="period-delta">${periodChange}</p></article>
      <article class="card panel"><div class="panel-heading"><div><h2>Desempenho por assunto</h2><p>Assuntos com maior volume de respostas</p></div></div><div class="subject-performance">${topicPerformance}</div></article>
      <article class="card panel"><div class="panel-heading"><div><h2>Desempenho por banca</h2><p>Taxa de acerto por banca identificada</p></div></div><div class="subject-performance">${bankPerformance}</div><p class="analytics-note">Questões sem banca reconhecida são omitidas desta comparação.</p></article>
    </div>
    <article class="card panel dashboard-wide"><div class="panel-heading"><div><h2>Evolução dos acertos</h2><p>Percentual de acerto por semana · últimas oito semanas</p></div></div>${trendChart}</article>
    <article class="card panel dashboard-wide"><div class="panel-heading"><div><h2>Mapa de calor por assunto</h2><p>Verde: ≥75% após 3 respostas · vermelho: &lt;50% · amarelo: em desenvolvimento · cinza: poucas respostas</p></div></div>${heatmap}</article>
    <div class="dashboard-footer"><span>✦</span><span><strong>Seu progresso fica privado.</strong> As respostas e os mapas salvos ficam apenas neste navegador.</span></div>
    <div class="quick-grid">
      <button class="quick-card" data-go="contents"><span class="quick-icon">▤</span><span><strong>Revisar conteúdos</strong><small>Leia os materiais por disciplina</small></span></button>
      <button class="quick-card" data-go="questions"><span class="quick-icon">☑</span><span><strong>Praticar questões</strong><small>Teste seus conhecimentos</small></span></button>
      <button class="quick-card" data-go="flashcards"><span class="quick-icon">▱</span><span><strong>Estudar flashcards</strong><small>Revise conceitos importantes</small></span></button>
    </div>`;
  view.querySelector('[data-action="continue"]').addEventListener("click", () => setTab("questions"));
  view.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.go)));
}

const WEEKDAYS = [
  { value: 1, label: "Segunda" },
  { value: 2, label: "Terça" },
  { value: 3, label: "Quarta" },
  { value: 4, label: "Quinta" },
  { value: 5, label: "Sexta" },
  { value: 6, label: "Sábado" },
  { value: 0, label: "Domingo" },
];
const REVIEW_INTERVALS = [1, 3, 7, 14, 30];

function localDateKey(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getStudyMinutesForDate(attempts, sessions, dateKey) {
  const intervals = [];
  for (const attempt of attempts) {
    const seconds = Number(attempt.durationSeconds);
    if (!attempt.answeredAt || !Number.isFinite(seconds) || seconds <= 0) continue;
    const end = new Date(attempt.answeredAt);
    const endTime = end.getTime();
    if (!Number.isFinite(endTime) || localDateKey(end) !== dateKey) continue;
    intervals.push({ start: endTime - seconds * 1000, end: endTime });
  }
  for (const session of sessions) {
    if (session.date !== dateKey || !session.completedAt || !Number.isFinite(Number(session.minutes))) continue;
    const end = new Date(session.completedAt).getTime();
    if (!Number.isFinite(end)) continue;
    intervals.push({ start: end - Number(session.minutes) * 60000, end });
  }
  intervals.sort((a, b) => a.start - b.start);
  let totalMilliseconds = 0;
  let current = null;
  for (const interval of intervals) {
    if (!current || interval.start > current.end) {
      if (current) totalMilliseconds += current.end - current.start;
      current = { ...interval };
    } else {
      current.end = Math.max(current.end, interval.end);
    }
  }
  if (current) totalMilliseconds += current.end - current.start;
  return Math.round(totalMilliseconds / 60000);
}

function daysUntilNextReview(interval) {
  return REVIEW_INTERVALS.find((days) => days > interval) || REVIEW_INTERVALS[REVIEW_INTERVALS.length - 1];
}

function scheduleQuestionReview(questionId, correct, previous = null, reviewedAt = new Date()) {
  const intervalDays = correct
    ? (previous ? daysUntilNextReview(previous.intervalDays || 1) : 3)
    : 1;
  const reviews = readStorage(STORAGE_KEYS.questionReviews, {});
  reviews[questionId] = {
    intervalDays,
    repetitions: correct ? (previous?.repetitions || 0) + 1 : 0,
    lastReviewedAt: reviewedAt.toISOString(),
    dueAt: addDays(reviewedAt, intervalDays).toISOString(),
  };
  writeStorage(STORAGE_KEYS.questionReviews, reviews);
}

function bootstrapQuestionReviews() {
  const reviews = readStorage(STORAGE_KEYS.questionReviews, {});
  const attempts = getAttempts();
  let changed = false;
  for (const attempt of attempts) {
    if (reviews[attempt.questionId] || !attempt.answeredAt) continue;
    const answeredAt = new Date(attempt.answeredAt);
    if (!Number.isFinite(answeredAt.getTime())) continue;
    const intervalDays = attempt.correct ? 3 : 1;
    reviews[attempt.questionId] = {
      intervalDays,
      repetitions: 0,
      lastReviewedAt: answeredAt.toISOString(),
      dueAt: addDays(answeredAt, intervalDays).toISOString(),
    };
    changed = true;
  }
  if (changed) writeStorage(STORAGE_KEYS.questionReviews, reviews);
  return reviews;
}

function getSubjectWeights() {
  const saved = readStorage(STORAGE_KEYS.studyWeights, {});
  return Object.fromEntries(state.manifest.subjects.map((subject) => [
    subject.id,
    Math.max(0, Number(saved[subject.id] ?? 1) || 0),
  ]));
}

function distributeWeightedSlots(subjects, weights, slots) {
  const totalWeight = subjects.reduce((total, subject) => total + weights[subject.id], 0);
  if (!totalWeight || slots < 1) return [];
  const allocations = subjects.map((subject) => {
    const exact = slots * weights[subject.id] / totalWeight;
    return { subject, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = slots - allocations.reduce((total, item) => total + item.count, 0);
  allocations.sort((a, b) => b.remainder - a.remainder);
  for (let index = 0; index < allocations.length && remaining > 0; index += 1, remaining -= 1) {
    allocations[index].count += 1;
  }
  const schedule = [];
  const currentWeights = Object.fromEntries(subjects.map((subject) => [subject.id, 0]));
  const counts = Object.fromEntries(subjects.map((subject) => [subject.id, 0]));
  const sortedByWeight = [...subjects].sort((a, b) => weights[b.id] - weights[a.id]);
  const eligible = sortedByWeight.filter((subject) => allocations.find((item) => item.subject.id === subject.id)?.count);
  for (let slot = 0; slot < slots; slot += 1) {
    for (const subject of eligible) currentWeights[subject.id] += weights[subject.id];
    const selected = eligible.reduce((best, subject) => (
      !best || currentWeights[subject.id] > currentWeights[best.id] ? subject : best
    ), null);
    if (!selected) break;
    schedule.push(selected);
    counts[selected.id] += 1;
    currentWeights[selected.id] -= totalWeight;
    const allocation = allocations.find((item) => item.subject.id === selected.id);
    if (counts[selected.id] >= allocation.count) {
      eligible.splice(eligible.indexOf(selected), 1);
    }
  }
  return schedule;
}

function buildOrganizationCalendar(month, schedule, events, plan, questionReviews, materialReviews) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstDay = new Date(year, monthIndex, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const subjectNames = new Map(state.manifest.subjects.map((subject) => [subject.id, subject.name]));
  const eventByDate = new Map();
  const addEvent = (date, title, type) => {
    if (!eventByDate.has(date)) eventByDate.set(date, []);
    eventByDate.get(date).push({ title, type });
  };
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, monthIndex, day);
    for (const entry of schedule) {
      if (Number(entry.weekday) === date.getDay()) {
        addEvent(localDateKey(date), `${entry.startTime} · ${subjectNames.get(entry.subjectId) || "Estudo"} (${entry.minutes} min)`, "study");
      }
    }
    for (const entry of plan?.entries || []) {
      if (Number(entry.weekday) === date.getDay()) {
        addEvent(localDateKey(date), `Ciclo · ${entry.startTime} · ${subjectNames.get(entry.subjectId) || "Estudo"}`, "plan");
      }
    }
  }
  for (const [questionId, review] of Object.entries(questionReviews)) {
    const metadata = state.questionIndexCache?.get(questionId);
    if (review.dueAt) addEvent(localDateKey(new Date(review.dueAt)), `Revisar questão · ${metadata?.topic || "questão"}`, "review");
  }
  for (const review of Object.values(materialReviews)) {
    if (review.dueAt) addEvent(localDateKey(new Date(review.dueAt)), `Revisar conteúdo · ${review.title || "material"}`, "review");
  }
  for (const event of events) addEvent(event.date, event.title, event.type);
  const headers = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
  const cells = headers.map((header) => `<div class="calendar-weekday">${header}</div>`).join("");
  const blanks = Array.from({ length: startOffset }, () => '<div class="calendar-day empty"></div>').join("");
  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const date = localDateKey(new Date(year, monthIndex, day));
    const entries = eventByDate.get(date) || [];
    const todayClass = date === localDateKey() ? " today" : "";
    return `<div class="calendar-day${todayClass}"><strong>${day}</strong><div class="calendar-day-events">${entries.slice(0, 3).map((item) => `<span class="calendar-event ${escapeHtml(item.type)}" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>`).join("")}${entries.length > 3 ? `<small>+${entries.length - 3} itens</small>` : ""}</div></div>`;
  }).join("");
  return `<div class="calendar-grid">${cells}${blanks}${days}</div>`;
}

async function renderOrganization() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  await loadQuestionIndex();
  if (state.activeTab !== "organization") return;
  const subjects = state.manifest.subjects;
  if (!subjects.length) {
    view.innerHTML = '<div class="empty-state">Não há disciplinas disponíveis para montar um plano.</div>';
    return;
  }
  const subjectOptions = subjects.map((subject) => `<option value="${subject.id}">${escapeHtml(subject.name)}</option>`).join("");
  const weights = getSubjectWeights();
  const schedule = readStorage(STORAGE_KEYS.weeklySchedule, []);
  const events = readStorage(STORAGE_KEYS.studyEvents, []);
  const plan = readStorage(STORAGE_KEYS.automaticPlan, null);
  const goalsByDate = readStorage(STORAGE_KEYS.studyGoals, {});
  const todayKey = localDateKey();
  const todayGoal = goalsByDate[todayKey] || { questions: 20, hours: 3 };
  const sessions = readStorage(STORAGE_KEYS.pomodoroSessions, []);
  const attempts = getAttempts();
  const attemptsToday = attempts.filter((attempt) => attempt.answeredAt && localDateKey(new Date(attempt.answeredAt)) === todayKey).length;
  const todayMinutes = getStudyMinutesForDate(attempts, sessions, todayKey);
  const reviewSchedules = bootstrapQuestionReviews();
  const metadataByQuestion = state.questionIndexCache || new Map();
  const questionReviewsDue = Object.entries(reviewSchedules)
    .filter(([, review]) => new Date(review.dueAt) <= new Date())
    .map(([questionId, review]) => ({ questionId, review, metadata: metadataByQuestion.get(questionId) }))
    .sort((a, b) => new Date(a.review.dueAt) - new Date(b.review.dueAt));
  const completedMaterials = readStorage(STORAGE_KEYS.completedMaterials, {});
  const materialReviews = readStorage(STORAGE_KEYS.materialReviews, {});
  for (const material of state.manifest.materials) {
    if (!completedMaterials[material.id] || materialReviews[material.id]) continue;
    const subject = state.manifest.subjects.find((item) => item.name === material.subject);
    materialReviews[material.id] = {
      title: material.title,
      subjectId: subject?.id || "",
      intervalDays: 1,
      studiedAt: new Date().toISOString(),
      dueAt: addDays(new Date(), 1).toISOString(),
    };
  }
  writeStorage(STORAGE_KEYS.materialReviews, materialReviews);
  const dueMaterialReviews = Object.entries(materialReviews).filter(([, review]) => new Date(review.dueAt) <= new Date());
  const timer = readStorage(STORAGE_KEYS.studyTimer, { kind: "focus", remainingSeconds: 25 * 60, running: false, endsAt: null });
  const timerRemaining = timer.running && timer.endsAt
    ? Math.max(0, Math.ceil((new Date(timer.endsAt).getTime() - Date.now()) / 1000))
    : Math.max(0, timer.remainingSeconds || 0);
  const monthLabel = state.calendarMonth.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  const diary = readStorage(STORAGE_KEYS.studyDiary, []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);

  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">ROTINA, FOCO E CONSTÂNCIA</p><h1>Organização dos estudos</h1><p class="page-subtitle">Monte seu ciclo com pesos por disciplina, acompanhe metas e organize revisões em um só lugar.</p></div></div>
    <div class="organization-summary">
      <article class="card organization-summary-card"><span>Revisões de questões pendentes</span><strong>${questionReviewsDue.length}</strong></article>
      <article class="card organization-summary-card"><span>Revisões de conteúdo pendentes</span><strong>${dueMaterialReviews.length}</strong></article>
      <article class="card organization-summary-card"><span>Questões hoje</span><strong>${attemptsToday} / ${todayGoal.questions}</strong></article>
      <article class="card organization-summary-card"><span>Estudo hoje</span><strong>${(todayMinutes / 60).toFixed(1)} / ${Number(todayGoal.hours).toFixed(1)} h</strong></article>
    </div>
    <div class="organization-grid">
      <section class="card panel organization-section cycle-section">
        <div class="panel-heading"><div><p class="eyebrow">PRIORIDADES EDITÁVEIS</p><h2>Ciclo de estudos e plano automático</h2><p>Defina o peso de cada matéria. Quanto maior o peso, maior a parte do ciclo reservada à disciplina.</p></div></div>
        <form id="automatic-plan-form" class="organization-form">
          <div class="plan-settings">
            <label class="form-label">Concurso desejado<input class="form-control" id="plan-exam" maxlength="100" value="${escapeHtml(plan?.exam || "SEFAZ-SP")}"></label>
            <label class="form-label">Data da prova<input class="form-control" id="plan-date" type="date" value="${escapeHtml(plan?.examDate || "")}"></label>
            <label class="form-label">Horas por dia<input class="form-control" id="plan-hours" type="number" min="0.5" max="16" step="0.5" value="${Number(plan?.hoursPerDay || 3)}" required></label>
            <label class="form-label">Dias por semana<input class="form-control" id="plan-days" type="number" min="1" max="7" step="1" value="${Number(plan?.daysPerWeek || 6)}" required></label>
            <label class="form-label">Início do estudo<input class="form-control" id="plan-start" type="time" value="${escapeHtml(plan?.startTime || "08:00")}" required></label>
          </div>
          <div class="weight-editor"><div class="weight-editor-heading"><strong>Peso por disciplina</strong><small>Use 0 para pausar uma matéria; valores maiores recebem mais tempo.</small></div>
            <div class="weight-grid">${subjects.map((subject) => `<label class="weight-field"><span>${escapeHtml(subject.name)}</span><input class="form-control" type="number" min="0" max="100" step="0.5" name="weight-${subject.id}" value="${weights[subject.id]}" aria-label="Peso de ${escapeHtml(subject.name)}"></label>`).join("")}</div>
          </div>
          <button class="button" type="submit">Salvar pesos e gerar plano automático</button>
        </form>
        <div id="cycle-preview" class="cycle-preview">${renderCyclePreview(plan, weights)}</div>
      </section>
      <section class="card panel organization-section">
        <div class="panel-heading"><div><p class="eyebrow">ROTINA SEMANAL</p><h2>Cronograma de estudos</h2><p>Adicione blocos recorrentes à sua semana.</p></div></div>
        <form id="weekly-schedule-form" class="organization-form compact-form">
          <label class="form-label">Dia<select class="form-control" id="schedule-weekday">${WEEKDAYS.map((day) => `<option value="${day.value}">${day.label}</option>`).join("")}</select></label>
          <label class="form-label">Disciplina<select class="form-control" id="schedule-subject">${subjectOptions}</select></label>
          <div class="form-row"><label class="form-label">Horário<input class="form-control" type="time" id="schedule-time" value="08:00" required></label><label class="form-label">Duração (min)<input class="form-control" id="schedule-minutes" type="number" min="15" max="480" step="15" value="60" required></label></div>
          <button class="button" type="submit">Adicionar à rotina</button>
        </form>
        <div class="schedule-list">${renderWeeklySchedule(schedule)}</div>
      </section>
      <section class="card panel organization-section">
        <div class="panel-heading"><div><p class="eyebrow">CONSTÂNCIA DIÁRIA</p><h2>Metas diárias</h2><p>Defina sua meta de questões e horas de estudo para hoje.</p></div></div>
        <form id="daily-goals-form" class="organization-form">
          <div class="form-row"><label class="form-label">Questões por dia<input class="form-control" id="goal-questions" type="number" min="1" max="1000" value="${Number(todayGoal.questions)}" required></label><label class="form-label">Horas por dia<input class="form-control" id="goal-hours" type="number" min="0.5" max="16" step="0.5" value="${Number(todayGoal.hours)}" required></label></div>
          <button class="button secondary" type="submit">Salvar metas de hoje</button>
        </form>
        <div class="goal-progress"><div><span>Questões</span><strong>${attemptsToday} / ${Number(todayGoal.questions)}</strong></div><div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, attemptsToday / Math.max(1, Number(todayGoal.questions)) * 100)}%"></div></div><div><span>Tempo estudado</span><strong>${(todayMinutes / 60).toFixed(1)} / ${Number(todayGoal.hours).toFixed(1)} h</strong></div><div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, todayMinutes / Math.max(0.5, Number(todayGoal.hours) * 60) * 100)}%"></div></div></div>
      </section>
      <section class="card panel organization-section pomodoro-section">
        <div class="panel-heading"><div><p class="eyebrow">SESSÕES DE FOCO</p><h2>Pomodoro</h2><p>Estude em blocos e intercale pausas.</p></div></div>
        <div class="pomodoro-controls"><label>Foco<select class="form-control" id="pomodoro-focus"><option value="25">25 min</option><option value="50">50 min</option></select></label><label>Pausa<select class="form-control" id="pomodoro-break"><option value="5">5 min</option><option value="10">10 min</option></select></label></div>
        <div class="pomodoro-display ${timer.kind === "break" ? "break" : ""}"><span id="pomodoro-kind">${timer.kind === "break" ? "PAUSA" : "FOCO"}</span><strong id="pomodoro-clock">${formatClock(timerRemaining)}</strong><small id="pomodoro-state">${timer.running ? "Sessão em andamento" : timer.hasStarted ? "Sessão pausada" : timer.kind === "break" ? "Pausa pronta" : "Pronto para começar"}</small></div>
        <div class="pomodoro-actions"><button class="button" id="pomodoro-toggle">${timer.running ? "Pausar" : "Iniciar"}</button><button class="button secondary" id="pomodoro-reset">Reiniciar</button></div>
      </section>
      <section class="card panel organization-section calendar-section">
        <div class="panel-heading"><div><p class="eyebrow">AGENDA VISUAL</p><h2>Calendário de estudos</h2><p>Rotina, plano automático, revisões e simulados.</p></div><div class="calendar-navigation"><button class="button secondary" id="calendar-prev" aria-label="Mês anterior">‹</button><strong>${escapeHtml(monthLabel)}</strong><button class="button secondary" id="calendar-next" aria-label="Próximo mês">›</button></div></div>
        ${buildOrganizationCalendar(state.calendarMonth, schedule, events, plan, reviewSchedules, materialReviews)}
        <form id="calendar-event-form" class="organization-form calendar-event-form"><label class="form-label">Adicionar meta, revisão ou simulado<input class="form-control" id="event-title" maxlength="100" placeholder="Ex.: Simulado de Direito Tributário" required></label><div class="form-row"><label class="form-label">Data<input class="form-control" id="event-date" type="date" value="${todayKey}" required></label><label class="form-label">Tipo<select class="form-control" id="event-type"><option value="goal">Meta</option><option value="review">Revisão</option><option value="simulation">Simulado</option></select></label></div><button class="button secondary" type="submit">Adicionar ao calendário</button></form>
        ${events.length ? `<div class="schedule-list">${renderCalendarEvents(events)}</div>` : ""}
      </section>
      <section class="card panel organization-section review-section">
        <div class="panel-heading"><div><p class="eyebrow">REVISÃO ESPAÇADA</p><h2>Lembretes de revisão</h2><p>Questões erradas voltam em 1 dia; acertos, em 3 dias. Os intervalos aumentam com os acertos consecutivos.</p></div></div>
        ${renderDueReviews(questionReviewsDue, dueMaterialReviews)}
      </section>
      <section class="card panel organization-section">
        <div class="panel-heading"><div><p class="eyebrow">REGISTRO PESSOAL</p><h2>Diário de estudos</h2><p>Anote o que estudou, dificuldades e próximos passos.</p></div></div>
        <form id="study-diary-form" class="organization-form">
          <div class="form-row"><label class="form-label">Data<input class="form-control" id="diary-date" type="date" value="${todayKey}" required></label><label class="form-label">Disciplina<select class="form-control" id="diary-subject"><option value="">Geral</option>${subjectOptions}</select></label></div>
          <label class="form-label">Registro<textarea class="form-control diary-textarea" id="diary-entry" maxlength="2000" placeholder="O que estudou hoje? O que precisa revisar?" required></textarea></label>
          <button class="button secondary" type="submit">Salvar registro</button>
        </form>
        <div class="diary-list">${renderDiaryEntries(diary)}</div>
      </section>
    </div>`;
  bindOrganizationEvents();
  startPomodoroTicker();
}

function formatClock(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderCyclePreview(plan, weights) {
  if (!plan?.entries?.length) {
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    return `<div class="empty-state">${total ? "Salve os pesos e gere um plano para ver a distribuição semanal." : "Informe pesos maiores que zero para gerar o ciclo."}</div>`;
  }
  const subjectNames = new Map(state.manifest.subjects.map((subject) => [subject.id, subject.name]));
  const totalMinutes = plan.entries.reduce((sum, entry) => sum + entry.minutes, 0);
  const grouped = new Map();
  for (const entry of plan.entries) {
    grouped.set(entry.subjectId, (grouped.get(entry.subjectId) || 0) + entry.minutes);
  }
  const examDate = plan.examDate
    ? ` · prova em ${new Date(`${plan.examDate}T12:00:00`).toLocaleDateString("pt-BR")}`
    : "";
  const sequence = plan.entries.slice(0, 14).map((entry, index) => `<span class="cycle-sequence-item"><small>${index + 1}</small>${escapeHtml(subjectNames.get(entry.subjectId) || "Disciplina")}</span>`).join("");
  return `<div class="cycle-preview-header"><strong>${escapeHtml(plan.exam || "Plano de estudos")}</strong><span>${plan.entries.length} blocos · ${(totalMinutes / 60).toFixed(1)} h por semana${examDate}</span></div><div class="cycle-allocation">${[...grouped].map(([subjectId, minutes]) => `<div class="cycle-allocation-row"><span>${escapeHtml(subjectNames.get(subjectId) || "Disciplina")}</span><strong>${(minutes / 60).toFixed(1)} h/semana</strong><div class="progress-track"><div class="progress-fill" style="width:${Math.round(minutes / Math.max(1, totalMinutes) * 100)}%"></div></div></div>`).join("")}</div><h3 class="cycle-sequence-heading">Próximos blocos do ciclo</h3><div class="cycle-sequence">${sequence}</div><p class="analytics-note">Distribuição proporcional aos pesos informados. Ajuste o ciclo quando suas prioridades mudarem.</p>`;
}

function renderWeeklySchedule(schedule) {
  if (!schedule.length) return '<div class="empty-state">Sua rotina semanal ainda está vazia.</div>';
  const subjectNames = new Map(state.manifest.subjects.map((subject) => [subject.id, subject.name]));
  return schedule.slice().sort((a, b) => WEEKDAYS.findIndex((day) => day.value === Number(a.weekday)) - WEEKDAYS.findIndex((day) => day.value === Number(b.weekday)) || a.startTime.localeCompare(b.startTime)).map((item) => `<div class="organization-list-item"><span class="organization-item-date">${WEEKDAYS.find((day) => day.value === Number(item.weekday))?.label || "Dia"} · ${escapeHtml(item.startTime)}</span><strong>${escapeHtml(subjectNames.get(item.subjectId) || "Disciplina")}</strong><small>${item.minutes} minutos</small><button type="button" class="delete-map" data-delete-schedule="${escapeHtml(item.id)}" aria-label="Remover bloco de estudo">×</button></div>`).join("");
}

function renderCalendarEvents(events) {
  return events.slice().sort((a, b) => a.date.localeCompare(b.date)).map((event) => `<div class="organization-list-item"><span class="organization-item-date">${new Date(`${event.date}T12:00:00`).toLocaleDateString("pt-BR")}</span><strong>${escapeHtml(event.title)}</strong><small>${event.type === "simulation" ? "Simulado" : event.type === "review" ? "Revisão" : "Meta"}</small><button type="button" class="delete-map" data-delete-event="${escapeHtml(event.id)}" aria-label="Remover evento">×</button></div>`).join("");
}

function renderDueReviews(questionReviewsDue, dueMaterialReviews) {
  const questionItems = questionReviewsDue.map(({ questionId, review, metadata }) => `
    <div class="organization-list-item review-reminder">
      <span class="organization-item-date">Questão · ${metadata?.bank ? `${escapeHtml(metadata.bank)} · ` : ""}${new Date(review.dueAt).toLocaleDateString("pt-BR")}</span>
      <strong>${escapeHtml(metadata?.topic || metadata?.materialTitle || "Questão para revisar")}</strong>
      <small>${escapeHtml(metadata?.subjectName || state.manifest.subjects.find((subject) => subject.id === metadata?.subjectId)?.name || "Disciplina")} · intervalo ${review.intervalDays} dia(s)</small>
      <button type="button" class="button secondary review-question-button" data-review-question="${escapeHtml(questionId)}">Revisar questão</button>
    </div>`).join("");
  const materialItems = dueMaterialReviews.map(([materialId, review]) => `
    <div class="organization-list-item review-reminder">
      <span class="organization-item-date">Conteúdo · ${new Date(review.dueAt).toLocaleDateString("pt-BR")}</span>
      <strong>${escapeHtml(review.title || "Material estudado")}</strong>
      <small>${escapeHtml(state.manifest.subjects.find((subject) => subject.id === review.subjectId)?.name || "Disciplina")}</small>
      <button type="button" class="button secondary review-material-button" data-review-material="${escapeHtml(materialId)}">Revisar conteúdo</button>
    </div>`).join("");
  if (!questionItems && !materialItems) return '<div class="empty-state">Nenhuma revisão pendente. Questões respondidas e materiais estudados serão agendados automaticamente.</div>';
  return `<div class="review-list">${questionItems}${materialItems}</div>`;
}

function renderDiaryEntries(entries) {
  if (!entries.length) return '<div class="empty-state">Seus registros aparecerão aqui.</div>';
  return entries.map((entry) => `<article class="diary-entry"><div><strong>${new Date(`${entry.date}T12:00:00`).toLocaleDateString("pt-BR")}</strong><small>${escapeHtml(state.manifest.subjects.find((subject) => subject.id === entry.subjectId)?.name || "Geral")}</small><button type="button" class="delete-map" data-delete-diary="${escapeHtml(entry.id)}" aria-label="Remover registro">×</button></div><p>${escapeHtml(entry.text)}</p></article>`).join("");
}

function bindOrganizationEvents() {
  document.getElementById("automatic-plan-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const weights = Object.fromEntries(state.manifest.subjects.map((subject) => [
      subject.id,
      Math.max(0, Number(event.currentTarget.elements[`weight-${subject.id}`].value) || 0),
    ]));
    if (!Object.values(weights).some((weight) => weight > 0)) {
      showNotice("Informe um peso maior que zero em ao menos uma disciplina.");
      return;
    }
    const studyDays = Number(document.getElementById("plan-days").value);
    const hoursPerDay = Number(document.getElementById("plan-hours").value);
    if (!Number.isInteger(studyDays) || studyDays < 1 || studyDays > 7 || !Number.isFinite(hoursPerDay) || hoursPerDay <= 0 || hoursPerDay > 16) {
      showNotice("Informe de 1 a 7 dias por semana e de 0,5 a 16 horas por dia.");
      return;
    }
    writeStorage(STORAGE_KEYS.studyWeights, weights);
    const activeSubjects = state.manifest.subjects.filter((subject) => weights[subject.id] > 0);
    const slotCount = studyDays * Math.floor(hoursPerDay * 2);
    const sequence = distributeWeightedSlots(activeSubjects, weights, slotCount);
    if (!sequence.length) {
      showNotice("Não foi possível gerar um ciclo com os pesos e a disponibilidade informados.");
      return;
    }
    const activeWeekdays = [1, 2, 3, 4, 5, 6, 0].slice(0, studyDays);
    const [startHour, startMinute] = document.getElementById("plan-start").value.split(":").map(Number);
    const startMinutes = startHour * 60 + startMinute;
    if (startMinutes + Math.ceil(sequence.length / studyDays) * 30 > 24 * 60) {
      showNotice("O horário de início e a carga diária ultrapassam meia-noite. Escolha um início mais cedo ou reduza as horas por dia.");
      return;
    }
    const entries = sequence.map((subject, index) => {
      const dayIndex = index % studyDays;
      const blockIndex = Math.floor(index / studyDays);
      const minuteOfDay = startMinutes + blockIndex * 30;
      return {
        id: `${Date.now()}-${index}`,
        weekday: activeWeekdays[dayIndex],
        subjectId: subject.id,
        startTime: `${String(Math.floor(minuteOfDay / 60) % 24).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`,
        minutes: 30,
      };
    });
    const nextPlan = {
      exam: document.getElementById("plan-exam").value.trim(),
      examDate: document.getElementById("plan-date").value,
      hoursPerDay,
      daysPerWeek: studyDays,
      startTime: document.getElementById("plan-start").value,
      entries,
      generatedAt: new Date().toISOString(),
    };
    writeStorage(STORAGE_KEYS.automaticPlan, nextPlan);
    document.getElementById("cycle-preview").innerHTML = renderCyclePreview(nextPlan, weights);
    showNotice("Pesos e plano automático salvos neste navegador.");
  });

  document.getElementById("weekly-schedule-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const entries = readStorage(STORAGE_KEYS.weeklySchedule, []);
    entries.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      weekday: Number(document.getElementById("schedule-weekday").value),
      subjectId: document.getElementById("schedule-subject").value,
      startTime: document.getElementById("schedule-time").value,
      minutes: Number(document.getElementById("schedule-minutes").value),
    });
    writeStorage(STORAGE_KEYS.weeklySchedule, entries);
    renderOrganization();
  });
  view.querySelectorAll("[data-delete-schedule]").forEach((button) => button.addEventListener("click", () => {
    writeStorage(STORAGE_KEYS.weeklySchedule, readStorage(STORAGE_KEYS.weeklySchedule, []).filter((item) => item.id !== button.dataset.deleteSchedule));
    renderOrganization();
  }));

  document.getElementById("daily-goals-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const goals = readStorage(STORAGE_KEYS.studyGoals, {});
    goals[localDateKey()] = {
      questions: Number(document.getElementById("goal-questions").value),
      hours: Number(document.getElementById("goal-hours").value),
    };
    writeStorage(STORAGE_KEYS.studyGoals, goals);
    renderOrganization();
  });

  document.getElementById("calendar-event-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const nextEvents = readStorage(STORAGE_KEYS.studyEvents, []);
    nextEvents.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: document.getElementById("event-title").value.trim(),
      date: document.getElementById("event-date").value,
      type: document.getElementById("event-type").value,
    });
    writeStorage(STORAGE_KEYS.studyEvents, nextEvents);
    renderOrganization();
  });
  document.querySelectorAll("[data-delete-event]").forEach((button) => button.addEventListener("click", () => {
    writeStorage(STORAGE_KEYS.studyEvents, readStorage(STORAGE_KEYS.studyEvents, []).filter((item) => item.id !== button.dataset.deleteEvent));
    renderOrganization();
  }));
  document.getElementById("calendar-prev").addEventListener("click", () => {
    state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
    renderOrganization();
  });
  document.getElementById("calendar-next").addEventListener("click", () => {
    state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
    renderOrganization();
  });

  document.getElementById("pomodoro-focus").value = String(readStorage(STORAGE_KEYS.studyTimer, {}).focusMinutes || 25);
  document.getElementById("pomodoro-break").value = String(readStorage(STORAGE_KEYS.studyTimer, {}).breakMinutes || 5);
  document.getElementById("pomodoro-toggle").addEventListener("click", () => {
    const timer = readStorage(STORAGE_KEYS.studyTimer, { kind: "focus", remainingSeconds: 25 * 60, running: false });
    if (timer.running) {
      timer.remainingSeconds = Math.max(0, Math.ceil((new Date(timer.endsAt).getTime() - Date.now()) / 1000));
      timer.running = false;
      timer.endsAt = null;
    } else {
      const hasSettings = Number(timer.focusMinutes) > 0 && Number(timer.breakMinutes) > 0;
      timer.focusMinutes = Number(document.getElementById("pomodoro-focus").value);
      timer.breakMinutes = Number(document.getElementById("pomodoro-break").value);
      if (!hasSettings) {
        timer.remainingSeconds = (timer.kind === "break" ? timer.breakMinutes : timer.focusMinutes) * 60;
      }
      timer.running = true;
      timer.hasStarted = true;
      timer.endsAt = new Date(Date.now() + timer.remainingSeconds * 1000).toISOString();
    }
    writeStorage(STORAGE_KEYS.studyTimer, timer);
    renderOrganization();
  });
  document.getElementById("pomodoro-reset").addEventListener("click", () => {
    const timer = readStorage(STORAGE_KEYS.studyTimer, {});
    timer.running = false;
    timer.endsAt = null;
    timer.kind = "focus";
    timer.remainingSeconds = Number(document.getElementById("pomodoro-focus").value) * 60;
    timer.hasStarted = false;
    timer.focusMinutes = Number(document.getElementById("pomodoro-focus").value);
    timer.breakMinutes = Number(document.getElementById("pomodoro-break").value);
    writeStorage(STORAGE_KEYS.studyTimer, timer);
    renderOrganization();
  });

  document.getElementById("study-diary-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const entries = readStorage(STORAGE_KEYS.studyDiary, []);
    entries.unshift({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      date: document.getElementById("diary-date").value,
      subjectId: document.getElementById("diary-subject").value,
      text: document.getElementById("diary-entry").value.trim(),
    });
    writeStorage(STORAGE_KEYS.studyDiary, entries);
    renderOrganization();
  });
  document.querySelectorAll("[data-delete-diary]").forEach((button) => button.addEventListener("click", () => {
    writeStorage(STORAGE_KEYS.studyDiary, readStorage(STORAGE_KEYS.studyDiary, []).filter((item) => item.id !== button.dataset.deleteDiary));
    renderOrganization();
  }));
  view.querySelectorAll("[data-review-question]").forEach((button) => button.addEventListener("click", () => openSpacedReview(button.dataset.reviewQuestion)));
  view.querySelectorAll("[data-review-material]").forEach((button) => button.addEventListener("click", () => openMaterialReview(button.dataset.reviewMaterial)));
}

function startPomodoroTicker() {
  const timer = readStorage(STORAGE_KEYS.studyTimer, null);
  if (!timer?.running) return;
  const update = () => {
    const remaining = Math.max(0, Math.ceil((new Date(timer.endsAt).getTime() - Date.now()) / 1000));
    const clock = document.getElementById("pomodoro-clock");
    if (clock) clock.textContent = formatClock(remaining);
    if (remaining > 0) return;
    timer.running = false;
    timer.endsAt = null;
    if (timer.kind === "focus") {
      const sessions = readStorage(STORAGE_KEYS.pomodoroSessions, []);
      sessions.unshift({ date: localDateKey(), minutes: timer.focusMinutes || 25, completedAt: new Date().toISOString() });
      writeStorage(STORAGE_KEYS.pomodoroSessions, sessions);
      timer.kind = "break";
      timer.remainingSeconds = (timer.breakMinutes || 5) * 60;
      timer.hasStarted = false;
      showNotice("Sessão de foco concluída. Hora de fazer uma pausa.");
    } else {
      timer.kind = "focus";
      timer.remainingSeconds = (timer.focusMinutes || 25) * 60;
      timer.hasStarted = false;
      showNotice("Pausa concluída. Pronto para uma nova sessão de foco.");
    }
    writeStorage(STORAGE_KEYS.studyTimer, timer);
    clearInterval(state.timerInterval);
    state.timerInterval = null;
    if (state.activeTab === "organization") renderOrganization();
  };
  update();
  if (timer.running) state.timerInterval = setInterval(update, 1000);
}

async function openSpacedReview(questionId) {
  const metadata = (await loadQuestionIndex()).get(questionId);
  if (!metadata) {
    showNotice("Não foi possível encontrar a questão para revisão. Atualize os dados com python extractor.py.");
    return;
  }
  try {
    const data = await loadSubject(metadata.subjectId);
    const materials = data.materials;
    const questions = materials.flatMap((material) => material.questions);
    const index = questions.findIndex((question) => question.id === questionId);
    if (index < 0) throw new Error("Questão não encontrada no material.");
    state.subjectId = metadata.subjectId;
    state.questionIndex = index;
    state.questionMode = "practice";
    state.reviewQuestionId = questionId;
    setTab("questions");
  } catch (error) {
    console.error(error);
    showNotice(`Não foi possível abrir a questão para revisão: ${error.message}`);
  }
}

async function openMaterialReview(materialId) {
  const review = readStorage(STORAGE_KEYS.materialReviews, {})[materialId];
  if (review) {
    const interval = daysUntilNextReview(review.intervalDays || 1);
    const reviews = readStorage(STORAGE_KEYS.materialReviews, {});
    reviews[materialId] = {
      ...review,
      intervalDays: interval,
      dueAt: addDays(new Date(), interval).toISOString(),
    };
    writeStorage(STORAGE_KEYS.materialReviews, reviews);
  }
  state.subjectId = review?.subjectId || state.subjectId;
  state.activeMaterialId = materialId;
  setTab("contents");
}

async function renderContents() {
  view.innerHTML = '<div class="loading-state"><span class="spinner"></span><span>Carregando conteúdos...</span></div>';
  try {
    const data = await loadSubject();
    if (!data.materials.some((item) => item.id === state.activeMaterialId)) {
      state.activeMaterialId = data.materials[0]?.id || null;
    }
    const activeMaterial = data.materials.find((item) => item.id === state.activeMaterialId);
    if (!activeMaterial) {
      view.innerHTML = '<div class="empty-state">Esta disciplina ainda não possui arquivos Markdown.</div>';
      return;
    }
    const completed = readStorage(STORAGE_KEYS.completedMaterials, {});
    const completedCount = data.materials.filter((material) => completed[material.id]).length;
    view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">BIBLIOTECA DE MATERIAIS</p><h1>Conteúdos</h1><p class="page-subtitle">${escapeHtml(data.subject.name)} · ${data.materials.length} materiais para estudar no seu ritmo.</p></div></div>
      <div class="content-toolbar card">
        <label class="content-subject-label" for="content-subject">Estudando agora</label>
        <select class="select-control" id="content-subject" aria-label="Selecionar disciplina para estudar">${state.manifest.subjects.map((subject) => `<option value="${subject.id}" ${subject.id === data.subject.id ? "selected" : ""}>${escapeHtml(subject.name)}</option>`).join("")}</select>
        <div class="content-completion" aria-live="polite"><strong id="completed-count">${completedCount} / ${data.materials.length}</strong><span>materiais estudados</span></div>
      </div>
      <div class="content-layout"><aside class="card content-list" id="content-material-list"><div class="list-header"><div class="list-header-title"><h2>Materiais da disciplina</h2><div class="list-header-actions"><button class="list-view-button" id="collapse-material-list" type="button" aria-controls="material-list" aria-expanded="true" title="Reduzir lista">−</button><button class="list-view-button" id="hide-material-list" type="button" aria-controls="content-material-list" title="Ocultar lista" aria-label="Ocultar lista de materiais">×</button></div></div><input class="search-input" id="material-search" placeholder="Buscar conteúdo..." aria-label="Buscar conteúdo"></div><div class="material-list" id="material-list"></div></aside>
      <article class="card reader"><button class="show-material-list" id="show-material-list" type="button" hidden>☷ Mostrar materiais</button><div class="reader-head"><div class="reader-title"><h2>${escapeHtml(activeMaterial.title)}</h2><div class="reader-meta">${escapeHtml(data.subject.name)} · ${activeMaterial.questions.length} questões associadas</div></div>
        <label class="material-study-toggle ${completed[activeMaterial.id] ? "completed" : ""}" id="material-study-label" for="material-studied"><input id="material-studied" type="checkbox" ${completed[activeMaterial.id] ? "checked" : ""}><span id="material-study-state">${completed[activeMaterial.id] ? "Conteúdo estudado" : "Marcar como estudado"}</span></label>
      </div><div class="markdown-body">${renderMarkdown(activeMaterial.content)}</div></article></div>`;
    const listView = readStorage(STORAGE_KEYS.contentListView, {});
    const contentLayout = view.querySelector(".content-layout");
    const contentList = view.querySelector(".content-list");
    const collapseButton = document.getElementById("collapse-material-list");
    const hideButton = document.getElementById("hide-material-list");
    const showButton = document.getElementById("show-material-list");
    const updateListView = () => {
      contentLayout.classList.toggle("list-collapsed", listView.collapsed === true);
      contentLayout.classList.toggle("list-hidden", listView.hidden === true);
      contentList.hidden = listView.hidden === true;
      collapseButton.setAttribute("aria-expanded", String(listView.collapsed !== true));
      collapseButton.title = listView.collapsed ? "Expandir lista" : "Reduzir lista";
      collapseButton.setAttribute("aria-label", collapseButton.title);
      collapseButton.textContent = listView.collapsed ? "+" : "−";
      showButton.hidden = listView.hidden !== true;
      writeStorage(STORAGE_KEYS.contentListView, listView);
    };
    collapseButton.addEventListener("click", () => {
      listView.collapsed = !listView.collapsed;
      listView.hidden = false;
      updateListView();
    });
    hideButton.addEventListener("click", () => {
      listView.hidden = true;
      updateListView();
    });
    showButton.addEventListener("click", () => {
      listView.hidden = false;
      updateListView();
    });
    updateListView();
    document.getElementById("content-subject").addEventListener("change", (event) => setSubject(event.target.value));
    const list = document.getElementById("material-list");
    let materialFilter = "";
    const updateList = (filter = materialFilter) => {
      materialFilter = filter;
      const filtered = data.materials.filter((material) => material.title.toLocaleLowerCase("pt-BR").includes(filter.toLocaleLowerCase("pt-BR")));
      list.innerHTML = filtered.length ? filtered.map((material) =>
        `<button class="material-item ${material.id === activeMaterial.id ? "active" : ""}" data-material-id="${material.id}"><span class="material-item-title">${escapeHtml(material.title)}</span><small>${material.questions.length} questões · ${material.flashcards.length} cartões</small><span class="material-status ${completed[material.id] ? "done" : ""}">${completed[material.id] ? "Estudado" : "Pendente"}</span></button>`
      ).join("") : '<div class="empty-state">Nenhum material encontrado.</div>';
      list.querySelectorAll("[data-material-id]").forEach((button) => button.addEventListener("click", () => {
        state.activeMaterialId = button.dataset.materialId;
        renderContents();
      }));
    };
    updateList();
    document.getElementById("material-search").addEventListener("input", (event) => updateList(event.target.value));
    document.getElementById("material-studied").addEventListener("change", (event) => {
      const nextCompleted = readStorage(STORAGE_KEYS.completedMaterials, {});
      if (event.target.checked) nextCompleted[activeMaterial.id] = true;
      else delete nextCompleted[activeMaterial.id];
      writeStorage(STORAGE_KEYS.completedMaterials, nextCompleted);
      const reviews = readStorage(STORAGE_KEYS.materialReviews, {});
      if (event.target.checked) {
        reviews[activeMaterial.id] = {
          title: activeMaterial.title,
          subjectId: data.subject.id,
          intervalDays: 1,
          studiedAt: new Date().toISOString(),
          dueAt: addDays(new Date(), 1).toISOString(),
        };
      } else {
        delete reviews[activeMaterial.id];
      }
      writeStorage(STORAGE_KEYS.materialReviews, reviews);
      completed[activeMaterial.id] = event.target.checked;
      if (!event.target.checked) delete completed[activeMaterial.id];
      document.getElementById("material-study-label").classList.toggle("completed", event.target.checked);
      document.getElementById("material-study-state").textContent = event.target.checked ? "Conteúdo estudado" : "Marcar como estudado";
      document.getElementById("completed-count").textContent = `${data.materials.filter((material) => completed[material.id]).length} / ${data.materials.length}`;
      updateList();
    });
  } catch (error) {
    console.error(error);
    view.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}<br><br>Rode o extrator e abra o site por um servidor local. Consulte o README.</div>`;
  }
}

function questionModeSwitcher() {
  const isSimulation = state.questionMode !== "practice";
  return `<div class="question-mode-tabs" role="tablist" aria-label="Modo de questões">
    <button class="mode-tab ${isSimulation ? "" : "active"}" data-question-mode="practice" role="tab" aria-selected="${!isSimulation}">Treino por disciplina</button>
    <button class="mode-tab ${isSimulation ? "active" : ""}" data-question-mode="setup" role="tab" aria-selected="${isSimulation}">Simulado</button>
  </div>`;
}

function bindQuestionModeSwitcher() {
  view.querySelectorAll("[data-question-mode]").forEach((button) => button.addEventListener("click", () => {
    const mode = button.dataset.questionMode;
    if (mode === "practice") {
      state.questionMode = "practice";
      state.simulation = null;
      state.questionIndex = 0;
      state.randomQuestionIds = null;
      state.randomAnsweredIds = new Set();
    } else if (state.questionMode === "practice") {
      state.randomQuestionIds = null;
      state.randomAnsweredIds = new Set();
      state.questionMode = "setup";
    }
    renderQuestions();
  }));
}

function shuffleQuestions(questions) {
  const shuffled = [...questions];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function bindRandomQuestionMode(questions) {
  const button = document.getElementById("random-question-mode");
  if (!button) return;
  button.addEventListener("click", () => {
    if (state.randomQuestionIds) {
      state.randomQuestionIds = null;
      state.randomAnsweredIds = new Set();
      state.questionIndex = 0;
    } else {
      const eligibleQuestions = questions.filter((question) => question.answer && question.options.length >= 2);
      if (!eligibleQuestions.length) {
        showNotice("Não há questões com gabarito e alternativas para embaralhar nesta disciplina.");
        return;
      }
      state.randomQuestionIds = shuffleQuestions(eligibleQuestions).map((question) => question.id);
      state.randomAnsweredIds = new Set();
      state.questionIndex = 0;
    }
    renderQuestions();
  });
}

function getEliminatedOptions(questionId) {
  const eliminated = readStorage(STORAGE_KEYS.eliminated, {});
  const options = eliminated[questionId];
  return Array.isArray(options) ? options : [];
}

function bindEliminationControls(questionId) {
  view.querySelectorAll("[data-eliminate]").forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.eliminate;
    const eliminated = readStorage(STORAGE_KEYS.eliminated, {});
    const selected = new Set(Array.isArray(eliminated[questionId]) ? eliminated[questionId] : []);
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    eliminated[questionId] = [...selected];
    writeStorage(STORAGE_KEYS.eliminated, eliminated);
    const row = button.closest(".option-row");
    const crossed = selected.has(key);
    row.classList.toggle("eliminated", crossed);
    button.classList.toggle("active", crossed);
    button.setAttribute("aria-pressed", String(crossed));
    button.textContent = crossed ? "Desfazer" : "Tachar";
    button.title = crossed ? "Desfazer eliminação" : "Tachar alternativa";
  }));
}

function renderOptionRows(question, { selected = null, answerKey = null, revealed = false, canAnswer = true } = {}) {
  const eliminated = new Set(getEliminatedOptions(question.id));
  return question.options.map((option) => {
    let classes = "option-button";
    if (revealed && option.key === answerKey) classes += " correct";
    else if (revealed && option.key === selected && selected !== answerKey) classes += " incorrect";
    else if (selected === option.key) classes += " selected";
    const isEliminated = eliminated.has(option.key);
    return `<div class="option-row ${isEliminated ? "eliminated" : ""}">
      <button class="${classes}" data-answer="${escapeHtml(option.key)}" ${canAnswer ? "" : "disabled"}>
        <span class="option-key">${escapeHtml(option.key)}</span><span class="option-text">${inlineMarkdown(option.text)}</span>
      </button>
      <button class="eliminate-button ${isEliminated ? "active" : ""}" type="button" data-eliminate="${escapeHtml(option.key)}" aria-pressed="${isEliminated}" aria-label="${isEliminated ? "Desfazer eliminação" : "Tachar alternativa"}" title="${isEliminated ? "Desfazer eliminação" : "Tachar alternativa"}">${isEliminated ? "Desfazer" : "Tachar"}</button>
    </div>`;
  }).join("");
}

async function loadQuestionBank(subjectId = null) {
  const cacheKey = subjectId || "all";
  if (state.questionBankCache.has(cacheKey)) return state.questionBankCache.get(cacheKey);
  const subjects = state.manifest.subjects.filter((subject) => !subjectId || subject.id === subjectId);
  const datasets = await Promise.all(subjects.map((subject) => loadSubject(subject.id)));
  const allQuestions = datasets.flatMap((data) => data.materials.flatMap((material) =>
    material.questions.map((question) => ({
      ...question,
      materialTitle: material.title,
      materialId: material.id,
      subjectId: data.subject.id,
      subjectName: data.subject.name,
      topic: question.topic || "",
      bank: question.bank || "",
    }))
  ));
  const uniqueQuestions = [];
  const positions = new Map();
  for (const question of allQuestions) {
    const externalId = question.number.match(/\d{6,}/)?.[0];
    const key = externalId ? `external:${externalId}` : `local:${question.id}`;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, uniqueQuestions.length);
      uniqueQuestions.push(question);
      continue;
    }
    const previous = uniqueQuestions[position];
    if (question.statement.length + question.solution.length > previous.statement.length + previous.solution.length) {
      uniqueQuestions[position] = question;
    }
  }
  state.questionBankCache.set(cacheKey, uniqueQuestions);
  return uniqueQuestions;
}

async function renderQuestions() {
  if (state.questionMode === "setup") {
    renderSimulationSetup();
    return;
  }
  if (state.questionMode === "simulation") {
    renderSimulationQuestion();
    return;
  }
  if (state.questionMode === "simulation-review") {
    renderSimulationQuestion(true);
    return;
  }
  if (state.questionMode === "simulation-result") {
    renderSimulationResult();
    return;
  }

  view.innerHTML = '<div class="loading-state"><span class="spinner"></span><span>Preparando questões...</span></div>';
  try {
    const data = await loadSubject();
    const allQuestions = data.materials.flatMap((material) => material.questions.map((question) => ({
      ...question,
      materialTitle: material.title,
      materialId: material.id,
      subjectId: data.subject.id,
      subjectName: data.subject.name,
    })));
    const questionById = new Map(allQuestions.map((question) => [question.id, question]));
    const questions = state.randomQuestionIds
      ? state.randomQuestionIds.map((questionId) => questionById.get(questionId)).filter(Boolean)
      : allQuestions;
    if (state.randomQuestionIds && state.questionIndex >= questions.length) {
      view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">PRÁTICA INTELIGENTE</p><h1>Questões aleatórias</h1><p class="page-subtitle">${escapeHtml(data.subject.name)} · sessão concluída</p></div></div>${questionModeSwitcher()}<article class="card random-complete"><span class="random-complete-icon">✓</span><h2>Você concluiu o conjunto aleatório!</h2><p>Foram respondidas ${state.randomAnsweredIds.size} de ${questions.length} questões desta sessão.</p><div class="random-complete-actions"><button class="button" id="restart-random-questions">Novo conjunto aleatório</button><button class="button secondary" id="exit-random-questions">Voltar à lista normal</button></div></article>`;
      bindQuestionModeSwitcher();
      document.getElementById("restart-random-questions").addEventListener("click", () => {
        state.randomQuestionIds = shuffleQuestions(allQuestions.filter((question) => question.answer && question.options.length >= 2)).map((question) => question.id);
        state.randomAnsweredIds = new Set();
        state.questionIndex = 0;
        renderQuestions();
      });
      document.getElementById("exit-random-questions").addEventListener("click", () => {
        state.randomQuestionIds = null;
        state.randomAnsweredIds = new Set();
        state.questionIndex = 0;
        renderQuestions();
      });
      return;
    }
    if (!questions.length) {
      view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">PRÁTICA INTELIGENTE</p><h1>Questões</h1><p class="page-subtitle">${escapeHtml(data.subject.name)}</p></div></div>${questionModeSwitcher()}<article class="card empty-state">Não encontramos questões identificadas nesta disciplina.<br>Selecione outra disciplina ou confira os formatos reconhecidos pelo extrator.</article>`;
      bindQuestionModeSwitcher();
      return;
    }
    state.questionIndex = Math.min(state.questionIndex, questions.length - 1);
    const question = questions[state.questionIndex];
    const attempts = getAttempts();
    const isSpacedReview = state.reviewQuestionId === question.id;
    const isRandomMode = Boolean(state.randomQuestionIds);
    const prior = [...attempts].reverse().find((item) => item.questionId === question.id);
    const currentAttempt = isRandomMode && !state.randomAnsweredIds.has(question.id) ? null : prior;
    if (!prior || isSpacedReview || (isRandomMode && !state.randomAnsweredIds.has(question.id))) {
      startQuestionTimer(question.id, "practice");
    }
    const answerKey = question.answer;
    const selected = isSpacedReview && !isRandomMode ? null : (currentAttempt?.selected || null);
    const isRevealed = Boolean(currentAttempt);
    const keyLabel = answerKey || "";
    view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">PRÁTICA INTELIGENTE</p><h1>Questões</h1><p class="page-subtitle">Resolva, risque alternativas para organizar o raciocínio e revise a explicação.</p></div></div>
      ${questionModeSwitcher()}
      <div class="study-toolbar"><select class="select-control" id="question-subject" aria-label="Selecionar disciplina">${state.manifest.subjects.map((subject) => `<option value="${subject.id}" ${subject.id === data.subject.id ? "selected" : ""}>${escapeHtml(subject.name)}</option>`).join("")}</select><span class="period-pill">${state.questionIndex + 1} de ${questions.length} ${isRandomMode ? "no conjunto aleatório" : "nesta disciplina"}</span><button class="button ${isRandomMode ? "random-mode-active" : "secondary"}" id="random-question-mode" type="button" aria-pressed="${isRandomMode}" title="Embaralha questões com alternativas e gabarito desta disciplina; respostas anteriores podem ser refeitas.">${isRandomMode ? "Sair do modo aleatório" : "Embaralhar questões"}</button></div>
      <div class="question-layout"><article class="card question-card"><div class="question-meta"><span class="question-tag">${escapeHtml(question.number)}</span><span>${escapeHtml(question.materialTitle)}</span></div>
        <div class="markdown-body">${renderMarkdown(question.statement)}</div>
        <div class="option-list">${renderOptionRows(question, { selected, answerKey, revealed: isRevealed && !isRandomMode, canAnswer: !isRevealed || isSpacedReview || isRandomMode })}</div>
        ${isSpacedReview ? '<div class="feedback neutral">Revisão espaçada: responda novamente para programar o próximo intervalo.</div>' : ""}
        ${isRevealed && (!isSpacedReview || isRandomMode) ? `<div class="feedback ${answerKey ? (selected === answerKey ? "success" : "error") : "neutral"}">${answerKey ? (selected === answerKey ? "Resposta correta! Muito bem." : `Não foi dessa vez. O gabarito é ${escapeHtml(keyLabel)}.`) : "Não foi possível identificar um gabarito nesta questão. Consulte a resolução e a fonte original."}</div>${question.solution ? `<div class="solution-box"><h3>Resolução comentada</h3><div class="markdown-body">${renderMarkdown(question.solution)}</div></div>` : ""}` : ""}
        ${question.options.length ? "" : '<div class="feedback neutral">As alternativas não foram identificadas automaticamente neste material.</div>'}
        <div class="question-actions"><button class="button secondary" id="previous-question" ${state.questionIndex === 0 ? "disabled" : ""}>← Anterior</button><button class="button" id="next-question" ${!isRandomMode && state.questionIndex >= questions.length - 1 ? "disabled" : ""}>${state.questionIndex >= questions.length - 1 ? (isRandomMode ? "Concluir sessão" : "Próxima questão →") : "Próxima questão →"}</button></div>
      </article>
      <aside class="card question-side"><h3>Seu ritmo nesta disciplina</h3><div class="side-stat"><span>Respondidas</span><strong>${attempts.filter((item) => item.subjectId === data.subject.id).length}</strong></div><div class="side-stat"><span>Taxa de acerto</span><strong>${subjectAccuracy(attempts, data.subject.id)}%</strong></div><div class="tip-box"><strong>Dica de estudo</strong><br>Leia a resolução mesmo quando acertar. Entender o raciocínio ajuda a fixar o conteúdo.</div></aside></div>`;
    bindQuestionModeSwitcher();
    bindRandomQuestionMode(allQuestions);
    bindEliminationControls(question.id);
    document.getElementById("question-subject").addEventListener("change", (event) => setSubject(event.target.value));
    view.querySelectorAll("[data-answer]").forEach((button) => button.addEventListener("click", () => {
      const chosen = button.dataset.answer;
      if (!answerKey) {
        showQuestionWithoutKey(question, data, questions, chosen);
        return;
      }
      const history = getAttempts();
      const previousReview = readStorage(STORAGE_KEYS.questionReviews, {})[question.id] || null;
      const answeredAt = new Date();
      const attempt = {
          questionId: question.id,
          subjectId: data.subject.id,
          materialTitle: question.materialTitle,
          topic: question.topic || "",
          bank: question.bank || "",
          selected: chosen,
          correct: chosen === answerKey,
          answeredAt: answeredAt.toISOString(),
          durationSeconds: stopQuestionTimer(question.id, "practice"),
        };
      if (isRandomMode) {
        history.push(attempt);
        state.randomAnsweredIds.add(question.id);
        writeStorage(STORAGE_KEYS.attempts, history);
        scheduleQuestionReview(question.id, attempt.correct, previousReview, answeredAt);
      } else if (isSpacedReview || !history.some((item) => item.questionId === question.id)) {
        history.push(attempt);
        writeStorage(STORAGE_KEYS.attempts, history);
        scheduleQuestionReview(question.id, attempt.correct, isSpacedReview ? previousReview : null, answeredAt);
      }
      if (isSpacedReview) state.reviewQuestionId = null;
      renderQuestions();
    }));
    document.getElementById("previous-question").addEventListener("click", () => {
      stopQuestionTimer(question.id, "practice");
      state.reviewQuestionId = null;
      state.questionIndex -= 1;
      renderQuestions();
    });
    document.getElementById("next-question").addEventListener("click", () => {
      if (!isRandomMode && state.questionIndex >= questions.length - 1) return;
      stopQuestionTimer(question.id, "practice");
      state.reviewQuestionId = null;
      state.questionIndex += 1;
      renderQuestions();
    });
  } catch (error) {
    console.error(error);
    view.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function renderSimulationSetup() {
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">TREINO EM CONDIÇÕES DE PROVA</p><h1>Montar simulado</h1><p class="page-subtitle">Monte uma prova aleatória com questões do seu banco. O gabarito só aparece ao finalizar.</p></div></div>
    ${questionModeSwitcher()}
    <section class="card simulation-setup">
      <div class="simulation-setup-icon">✓</div>
      <h2>Configure sua sessão</h2>
      <p>As questões são embaralhadas. Você pode pular, voltar e revisar as respostas antes de entregar.</p>
      <form id="simulation-form" class="simulation-form">
        <label class="form-label" for="simulation-subject">Banco de questões</label>
        <select class="select-control" id="simulation-subject"><option value="all">Todas as disciplinas</option>${state.manifest.subjects.map((subject) => `<option value="${subject.id}" ${subject.id === state.subjectId ? "selected" : ""}>${escapeHtml(subject.name)}</option>`).join("")}</select>
        <label class="form-label" for="simulation-size">Quantidade de questões</label>
        <input class="form-control" id="simulation-size" type="number" min="1" max="100" value="20" required>
        <button class="button" type="submit">Carregar banco e iniciar →</button>
      </form>
      <div class="simulation-notice">O simulado inclui questões com alternativas e gabarito identificados. Seu resultado será salvo neste dispositivo.</div>
    </section>`;
  bindQuestionModeSwitcher();
  document.getElementById("simulation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const requestedSize = Number(document.getElementById("simulation-size").value);
    const subjectValue = document.getElementById("simulation-subject").value;
    if (!Number.isInteger(requestedSize) || requestedSize < 1 || requestedSize > 100) {
      showNotice("Escolha uma quantidade entre 1 e 100 questões.");
      return;
    }
    button.disabled = true;
    button.textContent = "Carregando questões...";
    try {
      const bank = await loadQuestionBank(subjectValue === "all" ? null : subjectValue);
      const eligible = bank.filter((question) => question.answer && question.options.length >= 2);
      if (!eligible.length) {
        showNotice("Não há questões com gabarito e alternativas suficientes nesse filtro.");
        button.disabled = false;
        button.textContent = "Carregar banco e iniciar →";
        return;
      }
      for (let index = eligible.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [eligible[index], eligible[swapIndex]] = [eligible[swapIndex], eligible[index]];
      }
      const questions = eligible.slice(0, requestedSize);
      if (questions.length < requestedSize) showNotice(`O filtro possui ${questions.length} questões válidas; o simulado será criado com esse total.`);
      state.simulation = {
        questions,
        answers: {},
        durationSeconds: {},
        index: 0,
        subjectId: subjectValue === "all" ? null : subjectValue,
        startedAt: new Date().toISOString(),
      };
      state.questionMode = "simulation";
      renderQuestions();
    } catch (error) {
      console.error(error);
      showNotice(`Não foi possível carregar o banco de questões: ${error.message}`);
      button.disabled = false;
      button.textContent = "Carregar banco e iniciar →";
    }
  });
}

function simulationOptionStatus(question, option, answer, revealed) {
  if (revealed && option.key === question.answer) return "correct";
  if (revealed && option.key === answer && answer !== question.answer) return "incorrect";
  return "";
}

function recordSimulationQuestionTime(question) {
  const simulation = state.simulation;
  const seconds = stopQuestionTimer(question.id, "simulation");
  if (!simulation || seconds === null) return;
  simulation.durationSeconds[question.id] = (simulation.durationSeconds[question.id] || 0) + seconds;
}

function renderSimulationQuestion(review = false) {
  const simulation = state.simulation;
  if (!simulation?.questions.length) {
    state.questionMode = "setup";
    renderSimulationSetup();
    return;
  }
  const index = simulation.index;
  const question = simulation.questions[index];
  if (!review) startQuestionTimer(question.id, "simulation");
  const selected = simulation.answers[question.id] || null;
  const answeredCount = Object.keys(simulation.answers).length;
  const progress = Math.round(((index + 1) / simulation.questions.length) * 100);
  const revealed = review;
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">${review ? "REVISÃO DO SIMULADO" : "PROVA EM ANDAMENTO"}</p><h1>${review ? "Revisar resposta" : "Simulado"}</h1><p class="page-subtitle">${review ? "Confira o gabarito e a resolução comentada." : "Marque uma alternativa por questão. O gabarito fica oculto até a entrega."}</p></div></div>
    ${questionModeSwitcher()}
    <div class="simulation-progress"><div><strong>Questão ${index + 1} de ${simulation.questions.length}</strong><span>${answeredCount} respondidas</span></div><div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div></div>
    <article class="card question-card simulation-question"><div class="question-meta"><span class="question-tag">${escapeHtml(question.number)}</span><span>${escapeHtml(question.subjectName)} · ${escapeHtml(question.materialTitle)}</span></div>
      <div class="markdown-body">${renderMarkdown(question.statement)}</div>
      <div class="option-list">${question.options.map((option) => {
        const status = simulationOptionStatus(question, option, selected, revealed);
        const classes = ["option-button", status, selected === option.key && !revealed ? "selected" : ""].filter(Boolean).join(" ");
        const isEliminated = getEliminatedOptions(question.id).includes(option.key);
        return `<div class="option-row ${isEliminated ? "eliminated" : ""}"><button class="${classes}" data-answer="${escapeHtml(option.key)}" ${review ? "disabled" : ""}><span class="option-key">${escapeHtml(option.key)}</span><span class="option-text">${inlineMarkdown(option.text)}</span></button><button class="eliminate-button ${isEliminated ? "active" : ""}" type="button" data-eliminate="${escapeHtml(option.key)}" aria-pressed="${isEliminated}" aria-label="${isEliminated ? "Desfazer eliminação" : "Tachar alternativa"}" title="${isEliminated ? "Desfazer eliminação" : "Tachar alternativa"}">${isEliminated ? "Desfazer" : "Tachar"}</button></div>`;
      }).join("")}</div>
      ${revealed ? `<div class="feedback ${selected === question.answer ? "success" : selected ? "error" : "neutral"}">${selected ? (selected === question.answer ? "Resposta correta." : `Resposta incorreta. Gabarito: ${escapeHtml(question.answer)}.`) : `Questão não respondida. Gabarito: ${escapeHtml(question.answer)}.`}</div>${question.solution ? `<div class="solution-box"><h3>Resolução comentada</h3><div class="markdown-body">${renderMarkdown(question.solution)}</div></div>` : ""}` : ""}
      <div class="simulation-question-nav">${simulation.questions.map((item, itemIndex) => `<button type="button" class="simulation-index ${itemIndex === index ? "current" : ""} ${simulation.answers[item.id] ? "answered" : ""}" data-simulation-index="${itemIndex}" aria-label="Ir para questão ${itemIndex + 1}">${itemIndex + 1}</button>`).join("")}</div>
      <div class="question-actions"><button class="button secondary" id="simulation-previous" ${index === 0 ? "disabled" : ""}>← Anterior</button>${review ? `<button class="button" id="simulation-result">Voltar ao resultado</button>` : `<button class="button danger-button" id="finish-simulation">Finalizar simulado</button><button class="button secondary" id="simulation-next" ${index >= simulation.questions.length - 1 ? "disabled" : ""}>Próxima →</button>`}</div>
    </article>`;
  bindQuestionModeSwitcher();
  bindEliminationControls(question.id);
  if (review) {
    view.querySelectorAll("[data-answer]").forEach((button) => { button.disabled = true; });
    document.getElementById("simulation-result").addEventListener("click", () => {
      state.questionMode = "simulation-result";
      renderQuestions();
    });
  } else {
    view.querySelectorAll("[data-answer]").forEach((button) => button.addEventListener("click", () => {
      recordSimulationQuestionTime(question);
      simulation.answers[question.id] = button.dataset.answer;
      renderSimulationQuestion();
    }));
    document.getElementById("simulation-next").addEventListener("click", () => {
      recordSimulationQuestionTime(question);
      simulation.index += 1;
      renderSimulationQuestion();
    });
    document.getElementById("finish-simulation").addEventListener("click", finishSimulation);
  }
  document.getElementById("simulation-previous").addEventListener("click", () => {
    if (!review) recordSimulationQuestionTime(question);
    simulation.index -= 1;
    renderSimulationQuestion(review);
  });
  view.querySelectorAll("[data-simulation-index]").forEach((button) => button.addEventListener("click", () => {
    if (!review) recordSimulationQuestionTime(question);
    simulation.index = Number(button.dataset.simulationIndex);
    renderSimulationQuestion(review);
  }));
}

function finishSimulation() {
  const simulation = state.simulation;
  if (!simulation) return;
  const unanswered = simulation.questions.length - Object.keys(simulation.answers).length;
  if (unanswered && !window.confirm(`Você deixou ${unanswered} questão(ões) sem resposta. Finalizar mesmo assim?`)) return;
  recordSimulationQuestionTime(simulation.questions[simulation.index]);
  const correct = simulation.questions.filter((question) => simulation.answers[question.id] === question.answer).length;
  const result = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    startedAt: simulation.startedAt,
    finishedAt: new Date().toISOString(),
    total: simulation.questions.length,
    answered: Object.keys(simulation.answers).length,
    correct,
    wrong: Object.entries(simulation.answers).filter(([id, answer]) => {
      const question = simulation.questions.find((item) => item.id === id);
      return question && answer !== question.answer;
    }).length,
    score: Math.round(correct / simulation.questions.length * 100),
    answers: simulation.answers,
    questionIds: simulation.questions.map((question) => question.id),
  };
  simulation.result = result;
  const simulations = readStorage(STORAGE_KEYS.simulations, []);
  simulations.unshift(result);
  writeStorage(STORAGE_KEYS.simulations, simulations);
  const attempts = getAttempts();
  for (const question of simulation.questions) {
    const selected = simulation.answers[question.id];
    if (!selected || attempts.some((attempt) => attempt.questionId === question.id)) continue;
    const attempt = {
      questionId: question.id,
      subjectId: question.subjectId,
      materialTitle: question.materialTitle,
      topic: question.topic || "",
      bank: question.bank || "",
      selected,
      correct: selected === question.answer,
      answeredAt: result.finishedAt,
      durationSeconds: simulation.durationSeconds[question.id] ?? null,
      simulationId: result.id,
    };
    attempts.push(attempt);
    scheduleQuestionReview(question.id, attempt.correct, null, new Date(result.finishedAt));
  }
  writeStorage(STORAGE_KEYS.attempts, attempts);
  state.questionMode = "simulation-result";
  renderQuestions();
}

function renderSimulationResult() {
  const simulation = state.simulation;
  const result = simulation?.result;
  if (!result) {
    state.questionMode = "setup";
    renderSimulationSetup();
    return;
  }
  const questions = simulation.questions;
  view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">RESULTADO DA SESSÃO</p><h1>Simulado concluído</h1><p class="page-subtitle">Revise os itens e use os erros como guia para sua próxima revisão.</p></div></div>
    ${questionModeSwitcher()}
    <section class="simulation-result-grid">
      <article class="card simulation-score"><span>APROVEITAMENTO</span><strong>${result.score}%</strong><div class="progress-track"><div class="progress-fill" style="width:${result.score}%"></div></div><small>${result.correct} acertos de ${result.total} questões</small></article>
      <article class="card simulation-result-stat"><span>Respondidas</span><strong>${result.answered}</strong><small>de ${result.total} questões</small></article>
      <article class="card simulation-result-stat"><span>Erros</span><strong>${result.wrong}</strong><small>${result.total - result.answered} em branco</small></article>
    </section>
    <section class="card simulation-review-list"><div class="panel-heading"><div><h2>Revisão por questão</h2><p>O gabarito e os comentários ficam disponíveis após finalizar.</p></div></div>
      ${questions.map((question, index) => {
        const selected = result.answers[question.id] || null;
        const correct = selected === question.answer;
        return `<button type="button" class="simulation-review-row" data-review-index="${index}"><span class="review-status ${correct ? "success" : selected ? "error" : "neutral"}">${correct ? "✓" : selected ? "×" : "—"}</span><span class="review-question"><strong>Questão ${index + 1} · ${escapeHtml(question.number)}</strong><small>${escapeHtml(question.subjectName)} · ${selected ? `Sua resposta: ${escapeHtml(selected)} · Gabarito: ${escapeHtml(question.answer)}` : `Em branco · Gabarito: ${escapeHtml(question.answer)}`}</small></span><span class="review-arrow">Revisar →</span></button>`;
      }).join("")}
    </section>
    <div class="simulation-result-actions"><button class="button secondary" id="new-simulation">Montar outro simulado</button><button class="button" id="review-first">Revisar questões</button></div>`;
  bindQuestionModeSwitcher();
  view.querySelectorAll("[data-review-index]").forEach((button) => button.addEventListener("click", () => {
    simulation.index = Number(button.dataset.reviewIndex);
    state.questionMode = "simulation-review";
    renderQuestions();
  }));
  document.getElementById("new-simulation").addEventListener("click", () => {
    state.simulation = null;
    state.questionMode = "setup";
    renderQuestions();
  });
  document.getElementById("review-first").addEventListener("click", () => {
    simulation.index = 0;
    state.questionMode = "simulation-review";
    renderQuestions();
  });
}

function showQuestionWithoutKey(question, data, questions, chosen) {
  const feedback = view.querySelector(".feedback");
  const solution = question.solution
    ? `<div class="solution-box"><h3>Resolução comentada</h3><div class="markdown-body">${renderMarkdown(question.solution)}</div></div>` : "";
  view.querySelectorAll("[data-answer]").forEach((button) => {
    button.disabled = true;
    if (button.dataset.answer === chosen) button.classList.add("incorrect");
  });
  if (feedback) feedback.remove();
  const options = view.querySelector(".option-list");
  options.insertAdjacentHTML("afterend", `<div class="feedback neutral">Resposta registrada para revisão, mas o arquivo não contém um gabarito reconhecível.${solution}</div>`);
}

function subjectAccuracy(attempts, subjectId) {
  const subjectAttempts = attempts.filter((item) => item.subjectId === subjectId);
  return subjectAttempts.length ? Math.round(subjectAttempts.filter((item) => item.correct).length / subjectAttempts.length * 100) : 0;
}

async function renderMindmaps() {
  view.innerHTML = '<div class="loading-state"><span class="spinner"></span><span>Organizando conceitos...</span></div>';
  try {
    const data = await loadSubject();
    const material = data.materials.find((item) => item.id === state.activeMaterialId) || data.materials[0];
    const headings = material ? [...material.content.matchAll(/^\s{0,3}#{1,4}\s+(.+)$/gm)].map((match) => match[1].replace(/[*_`]/g, "").trim()).filter(Boolean).slice(0, 16) : [];
    const maps = readStorage(STORAGE_KEYS.maps, []);
    view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">VISUALIZE AS CONEXÕES</p><h1>Mapas mentais</h1><p class="page-subtitle">Explore os tópicos de cada material ou salve seus mapas e referências favoritos.</p></div></div>
      <div class="mindmap-layout"><section class="card map-canvas"><div class="map-center">${escapeHtml(material?.title || "Selecione um material")}</div><div class="map-branches">${headings.length ? headings.map((heading) => `<div class="map-node">${escapeHtml(heading)}</div>`).join("") : '<div class="empty-state">Este material não possui títulos para montar o mapa.</div>'}</div></section>
        <aside class="card map-tools"><h2>Seu acervo visual</h2><p>Adicione links para mapas externos ou imagens. Os dados ficam salvos só neste navegador.</p><form id="map-form"><label class="form-label" for="map-title">Nome do mapa</label><input class="form-control" id="map-title" required maxlength="100" placeholder="Ex.: Princípios tributários"><label class="form-label" for="map-url">Link ou imagem (URL)</label><input class="form-control" id="map-url" required type="url" placeholder="https://..."><button class="button" style="margin-top:12px;width:100%" type="submit">＋ Salvar referência</button></form>
        <div class="saved-maps"><h3>Referências salvas</h3><div id="saved-map-list">${renderSavedMaps(maps)}</div></div></aside></div>`;
    document.getElementById("map-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const title = document.getElementById("map-title").value.trim();
      const url = safeHref(document.getElementById("map-url").value.trim());
      if (!url) { showNotice("Informe um link http ou https válido."); return; }
      maps.unshift({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, title, url, subjectId: data.subject.id });
      writeStorage(STORAGE_KEYS.maps, maps);
      renderMindmaps();
    });
    view.querySelectorAll("[data-delete-map]").forEach((button) => button.addEventListener("click", () => {
      const next = readStorage(STORAGE_KEYS.maps, []).filter((item) => item.id !== button.dataset.deleteMap);
      writeStorage(STORAGE_KEYS.maps, next);
      renderMindmaps();
    }));
  } catch (error) {
    console.error(error);
    view.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function renderSavedMaps(maps) {
  if (!maps.length) return '<div class="empty-state">Nenhuma referência salva ainda.</div>';
  return maps.map((item) => {
    const isImage = /\.(png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(item.url);
    const subjectName = state.manifest?.subjects.find((subject) => subject.id === item.subjectId)?.name || "Referência pessoal";
    return `<div class="saved-map-item"><div><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>${isImage ? `<div><img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.title)}" loading="lazy" style="max-height:90px;max-width:150px;margin-top:8px;border-radius:5px"></div>` : ""}<small>${escapeHtml(subjectName)}</small></div><button class="delete-map" data-delete-map="${escapeHtml(item.id)}" aria-label="Remover ${escapeHtml(item.title)}">×</button></div>`;
  }).join("");
}

async function renderFlashcards() {
  view.innerHTML = '<div class="loading-state"><span class="spinner"></span><span>Preparando seus cartões...</span></div>';
  try {
    const data = await loadSubject();
    const cards = data.materials.flatMap((material) => material.flashcards.map((card) => ({ ...card, materialTitle: material.title })));
    if (!cards.length) {
      view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">REVISÃO ATIVA</p><h1>Flashcards</h1><p class="page-subtitle">${escapeHtml(data.subject.name)}</p></div></div><article class="card empty-state">Ainda não foi possível gerar cartões a partir dos títulos dos materiais nesta disciplina.</article>`;
      return;
    }
    state.flashcardIndex = Math.min(state.flashcardIndex, cards.length - 1);
    const card = cards[state.flashcardIndex];
    view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">REVISÃO ATIVA</p><h1>Flashcards</h1><p class="page-subtitle">Recupere o conceito antes de virar o cartão para conferir.</p></div><select class="select-control" id="flashcard-subject" aria-label="Selecionar disciplina">${state.manifest.subjects.map((subject) => `<option value="${subject.id}" ${subject.id === data.subject.id ? "selected" : ""}>${escapeHtml(subject.name)}</option>`).join("")}</select></div>
      <div class="flashcard-wrap"><button class="flashcard ${state.flashcardFlipped ? "flipped" : ""}" id="flashcard" aria-label="Virar flashcard"><span class="flashcard-label">${state.flashcardFlipped ? "RESPOSTA" : "CONCEITO"}</span><span class="flashcard-text">${escapeHtml(state.flashcardFlipped ? card.back : card.front)}</span><span class="flashcard-source">${escapeHtml(card.materialTitle)} · clique para virar</span></button><div class="flashcard-controls"><button class="button secondary" id="previous-card" ${state.flashcardIndex === 0 ? "disabled" : ""}>← Anterior</button><span class="card-progress">${state.flashcardIndex + 1} / ${cards.length}</span><button class="button" id="next-card" ${state.flashcardIndex >= cards.length - 1 ? "disabled" : ""}>Próximo →</button></div><p class="keyboard-hint">Dica: use ← e → para navegar e espaço para virar o cartão.</p></div>`;
    document.getElementById("flashcard-subject").addEventListener("change", (event) => setSubject(event.target.value));
    document.getElementById("flashcard").addEventListener("click", () => { state.flashcardFlipped = !state.flashcardFlipped; renderFlashcards(); });
    document.getElementById("previous-card").addEventListener("click", () => { state.flashcardIndex -= 1; state.flashcardFlipped = false; renderFlashcards(); });
    document.getElementById("next-card").addEventListener("click", () => { state.flashcardIndex += 1; state.flashcardFlipped = false; renderFlashcards(); });
  } catch (error) {
    console.error(error);
    view.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

document.querySelectorAll(".nav-link").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
document.getElementById("mobile-menu").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("mobile-scrim").classList.toggle("visible");
});
document.getElementById("mobile-scrim").addEventListener("click", () => {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("mobile-scrim").classList.remove("visible");
});
document.getElementById("help-button").addEventListener("click", () => {
  showNotice(state.authUser && state.cloudReady
    ? "Conteúdos são públicos. Seu histórico é sincronizado com sua conta Supabase e também mantido neste navegador enquanto você estiver conectado."
    : "Conteúdos importados dos arquivos Markdown locais. Sem uma conta conectada, seu progresso fica armazenado apenas neste navegador.");
});
document.addEventListener("keydown", (event) => {
  if (state.activeTab !== "flashcards" || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (event.code === "Space") {
    event.preventDefault();
    state.flashcardFlipped = !state.flashcardFlipped;
    renderFlashcards();
  } else if (event.key === "ArrowRight") {
    state.flashcardIndex += 1;
    state.flashcardFlipped = false;
    renderFlashcards();
  } else if (event.key === "ArrowLeft" && state.flashcardIndex > 0) {
    state.flashcardIndex -= 1;
    state.flashcardFlipped = false;
    renderFlashcards();
  }
});

async function start() {
  try {
    await initializeAuth();
    const response = await fetch("data/manifest.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Índice de materiais não encontrado (${response.status}).`);
    state.manifest = await response.json();
    state.subjectId = state.manifest.subjects[0]?.id || null;
    buildNavigation();
    renderDashboard();
  } catch (error) {
    console.error(error);
    view.innerHTML = `<div class="empty-state">Não foi possível carregar os materiais. ${escapeHtml(error.message)}<br><br>Execute <code>python extractor.py</code> e depois <code>python -m http.server 8000</code> nesta pasta.</div>`;
  }
}

start();
