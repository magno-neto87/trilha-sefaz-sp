"use strict";

const AUTHORIZED_EMAIL = "magno.sneto@yahoo.com.br";
const AUTHORIZED_USER_ID = "c8ec6d1a-b031-42f9-8ef5-98a6dfcc6313";
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
  readingPositions: "trilha-reading-positions-v1",
  calendarCompletions: "trilha-calendar-completions-v1",
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
  questionMaterialId: "all",
  questionStatusFilter: "all",
  selectedAnswer: null,
  randomQuestionIds: null,
  randomAnsweredIds: new Set(),
  questionBankCache: new Map(),
  simulation: null,
  flashcardIndex: 0,
  flashcardFlipped: false,
  questionTimer: null,
  calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  calendarSelectedDate: null,
  calendarViewMode: "month",
  calendarFilter: "all",
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
  authLoadPromise: null,
  materialsLoadPromise: null,
  authError: null,
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

function sanitizeAttemptHistory(attempts) {
  if (!Array.isArray(attempts)) return [];
  const validQuestionIds = state.questionIndexCache ? new Set(state.questionIndexCache.keys()) : null;
  const filtered = attempts.filter((attempt) => {
    if (!attempt || typeof attempt !== "object") return false;
    if (typeof attempt.questionId !== "string" || !attempt.questionId.trim()) return false;
    if (validQuestionIds && !validQuestionIds.has(attempt.questionId)) return false;
    return true;
  });
  if (filtered.length !== attempts.length) {
    writeStorage(STORAGE_KEYS.attempts, filtered);
  }
  return filtered;
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

function isAuthorizedEmail(email) {
  return String(email || "").trim().toLowerCase() === AUTHORIZED_EMAIL;
}

function isAuthorizedUser(user) {
  return user?.id === AUTHORIZED_USER_ID;
}

function updateAccountUi() {
  const configured = Boolean(state.supabase);
  const hasUser = Boolean(state.authUser);
  const hasAccess = hasUser && state.authLoaded && state.cloudReady && Boolean(state.manifest);
  const recovering = state.authMode === "recovery";

  const authGate = document.getElementById("auth-gate");
  if (authGate) authGate.hidden = hasAccess;
  document.body.classList.toggle("authenticated", hasAccess);

  const authSetup = document.getElementById("auth-setup");
  if (authSetup) authSetup.hidden = configured;

  const authGuest = document.getElementById("auth-guest");
  if (authGuest) authGuest.hidden = !configured || (hasUser && !recovering);

  const authSubmit = document.getElementById("auth-submit");
  if (authSubmit) authSubmit.disabled = !configured || state.authLoading;

  const authWaiting = document.getElementById("auth-waiting");
  if (authWaiting) authWaiting.hidden = !configured || (!hasUser && !recovering) || hasAccess || recovering || Boolean(state.authError);

  const accessError = document.getElementById("auth-access-error");
  if (accessError) {
    accessError.hidden = !state.authError;
    accessError.textContent = state.authError || "";
  }

  const authRetry = document.getElementById("auth-retry");
  if (authRetry) authRetry.hidden = !state.authError;

  const authUser = document.getElementById("auth-user");
  if (authUser) authUser.hidden = !configured || !hasUser;

  const accountBtn = document.getElementById("account-button");
  if (accountBtn) accountBtn.textContent = hasUser ? "Minha conta" : "Entrar";

  const accountName = document.getElementById("account-name");
  if (accountName) {
    accountName.textContent = hasUser
      ? state.authUser.email || "Minha conta"
      : "Meu espaço";
  }

  const storageLabel = document.getElementById("account-storage-label");
  if (storageLabel) {
    storageLabel.textContent = hasUser && state.cloudReady
      ? "Histórico sincronizado"
      : "Progresso neste dispositivo";
  }

  const storageIndicator = document.getElementById("account-storage-indicator");
  if (storageIndicator) {
    storageIndicator.title = hasUser && state.cloudReady
      ? "Histórico sincronizado com sua conta"
      : "Dados salvos localmente";
  }

  if (!hasUser) return;

  const authEmail = document.getElementById("auth-user-email");
  if (authEmail) authEmail.textContent = state.authUser.email || "Conta conectada";

  const pendingImport = state.cloudReady && state.pendingImportKey && localStorage.getItem(state.pendingImportKey);
  const importLocal = document.getElementById("import-local-history");
  if (importLocal) importLocal.hidden = !pendingImport;

  const cloudMsg = document.getElementById("auth-cloud-message");
  if (cloudMsg) {
    cloudMsg.textContent = pendingImport
      ? "Há um histórico deste dispositivo preservado separadamente. Você pode mesclá-lo com o histórico da conta."
      : state.cloudReady
        ? "Seu progresso é sincronizado com esta conta."
        : "A conta está conectada, mas o histórico ainda não foi carregado. Verifique a configuração do Supabase.";
  }
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
  password.autocomplete = recovery ? "new-password" : "current-password";
  password.minLength = recovery ? 8 : 0;
  document.getElementById("auth-submit").textContent = recovery ? "Salvar nova senha" : "Entrar";
  document.getElementById("auth-reset-password").hidden = mode !== "login";
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
  if (nextUser && !isAuthorizedUser(nextUser)) {
    ++state.authGeneration;
    state.authUser = null;
    state.authLoaded = true;
    state.cloudReady = false;
    state.authLoading = false;
    state.authLoadPromise = null;
    state.materialsLoadPromise = null;
    state.pendingImportKey = null;
    state.authError = null;
    state.manifest = null;
    state.subjectCache.clear();
    state.questionIndexCache = null;
    view.replaceChildren();
    updateAccountUi();
    const { error } = await state.supabase.auth.signOut();
    if (error) throw error;
    setSyncStatus("Acesso restrito");
    showAuthMessage("auth-message", "Esta conta não está autorizada a acessar o site.");
    return;
  }
  if (nextUser && state.authUser?.id === nextUser.id && state.authLoading) {
    if (state.authLoadPromise) await state.authLoadPromise;
    return;
  }
  if (nextUser && state.authUser?.id === nextUser.id && state.cloudReady) return;
  const generation = ++state.authGeneration;
  if (!nextUser) {
    if (state.authUser && state.clearLocalOnSignOut && state.cloudReady) {
      for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
    }
    state.authUser = null;
    state.authLoaded = true;
    state.cloudReady = false;
    state.authLoading = false;
    state.authLoadPromise = null;
    state.materialsLoadPromise = null;
    state.clearLocalOnSignOut = false;
    state.pendingImportKey = null;
    state.authError = null;
    state.manifest = null;
    state.subjectCache.clear();
    state.questionIndexCache = null;
    view.replaceChildren();
    updateAccountUi();
    setSyncStatus("Salvo neste dispositivo");
    return;
  }

  state.authUser = nextUser;
  state.authError = null;
  state.pendingImportKey = pendingImportStorageKey(nextUser.id);
  state.authLoaded = false;
  state.cloudReady = false;
  state.authLoading = true;
  updateAccountUi();
  setSyncStatus("Carregando seu histórico...");
  const progressPromise = loadCloudProgress(nextUser, generation);
  state.authLoadPromise = progressPromise;
  try {
    await progressPromise;
    if (state.authGeneration !== generation || state.authUser?.id !== nextUser.id) return;
    state.authLoaded = true;
    setSyncStatus(localStorage.getItem(state.pendingImportKey)
      ? "Histórico local aguardando importação"
      : "Histórico sincronizado", "cloud");
  } catch (error) {
    if (state.authGeneration !== generation || state.authUser?.id !== nextUser.id) return;
    console.error("Não foi possível carregar o histórico da conta.", error);
    state.authError = `Não foi possível validar esta conta: ${error.message}`;
    state.authLoaded = true;
    setSyncStatus("Falha ao carregar histórico", "error");
  } finally {
    if (state.authGeneration === generation) {
      state.authLoading = false;
      state.authLoadPromise = null;
    }
  }
  updateAccountUi();
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

async function loadPrivateJson(path) {
  if (!state.supabase || !state.authUser) {
    throw new Error("Entre na sua conta para acessar os materiais.");
  }
  const userId = state.authUser.id;
  const bucket = window.TRILHA_SUPABASE_CONFIG.materialsBucket || "study-materials";
  const { data, error } = await state.supabase.storage.from(bucket).download(path);
  if (error) throw error;
  if (state.authUser?.id !== userId || !state.cloudReady) {
    throw new Error("A sessão terminou antes que o material fosse carregado.");
  }
  return JSON.parse(await data.text());
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
      handleAuthSession(session)
        .then(() => {
          if (state.cloudReady && !state.manifest) return loadStudyMaterials();
        })
        .catch((error) => {
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
    state.authError = `Não foi possível iniciar o login: ${error.message}`;
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
  document.getElementById("auth-retry").addEventListener("click", () => window.location.reload());
  document.getElementById("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.supabase) return;
    const email = document.getElementById("auth-email").value.trim();
    if (state.authMode !== "recovery" && !isAuthorizedEmail(email)) {
      showAuthMessage("auth-message", "Este site está reservado à conta autorizada.");
      return;
    }
    const password = document.getElementById("auth-password").value;
    const submit = document.getElementById("auth-submit");
    submit.disabled = true;
    document.getElementById("auth-message").hidden = true;
    state.authLoading = true;
    updateAccountUi();
    try {
      if (state.authMode === "recovery") {
        const { error } = await state.supabase.auth.updateUser({ password });
        if (error) throw error;
        setAuthMode("login");
        await loadStudyMaterials();
        showAuthMessage("auth-message", "Senha alterada. Agora você já pode entrar.");
        return;
      }
      const { data, error } = await state.supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await handleAuthSession(data.session);
      await loadStudyMaterials();
      const dialog = document.getElementById("account-dialog");
      if (dialog.open) dialog.close();
    } catch (error) {
      console.error("A autenticação falhou.", error);
      showAuthMessage("auth-message", error.message);
    } finally {
      state.authLoading = false;
      updateAccountUi();
    }
  });
  document.getElementById("auth-reset-password").addEventListener("click", async () => {
    if (!state.supabase) return;
    const emailInput = document.getElementById("auth-email");
    if (!emailInput.reportValidity()) return;
    if (!isAuthorizedEmail(emailInput.value)) {
      showAuthMessage("auth-message", "A redefinição está disponível apenas para a conta autorizada.");
      return;
    }
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

function renderStudyHeading(level, text) {
  const cleanText = text.trim();
  const plainText = cleanText.replace(/[*_`]/g, "").trim();
  if (isAnswerLine(plainText)) {
    return `<p class="content-answer"><strong>${inlineMarkdown(cleanText)}</strong></p>`;
  }

  // Detect exam question markers (e.g. "1. (FGV/PC-AM/Investigador...)", "(FGV/...)")
  const isExamQuestionHeading = /^\(?\d+[.)]?\s*\([A-Z0-9/ -]+\)/i.test(plainText)
    || /^\([A-Z0-9/ -]+\)/.test(plainText)
    || /^\d+[.)]?\s*(?:quest[aã]o|banca\b)/i.test(plainText);

  const numberedHeading = plainText.match(/^(\d+(?:\.\d+)*)(?:\s*[:.)-]\s*|\s+)(.+)$/);
  if (isExamQuestionHeading && numberedHeading) {
    const [, number, headingText] = numberedHeading;
    return `<div class="question-exam-heading"><span class="question-exam-badge">${number}</span><span class="question-exam-title">${inlineMarkdown(headingText)}</span></div>`;
  }
  if (isExamQuestionHeading) {
    return `<div class="question-exam-heading"><span class="question-exam-title">${inlineMarkdown(cleanText)}</span></div>`;
  }

  if (numberedHeading) {
    const [, number, headingText] = numberedHeading;
    const depth = number.split(".").length;
    if (depth === 1 && level < 3) {
      return `<h1 class="chapter-heading"><span class="chapter-number">${number}</span><span class="chapter-text">${inlineMarkdown(headingText)}</span></h1>`;
    }
    if (depth > 1 && level < 4) {
      return `<h2 class="section-heading"><span class="section-badge">${number}</span><span class="section-text">${inlineMarkdown(headingText)}</span></h2>`;
    }
    const semanticLevel = Math.min(Math.max(level, 2), 4);
    return `<h${semanticLevel}><span class="section-badge">${number}</span> <span class="section-text">${inlineMarkdown(headingText)}</span></h${semanticLevel}>`;
  }
  const semanticLevel = Math.min(level, 4);
  return `<h${semanticLevel}>${inlineMarkdown(cleanText)}</h${semanticLevel}>`;
}

function isAnswerLine(text) {
  const plainText = text.replace(/[*_`]/g, "").trim();
  return /^(?:a\s+letra\s+[a-e]\s+está\s+(?:correta|incorreta)|a\s+alternativa\s+[a-e]\s+(?:está\s+)?(?:correta|incorreta|errada)|alternativa\s+(?:correta|incorreta|errada)|resposta(?:\s+correta)?|gabarito)\b/i.test(plainText);
}

function normalizeContentMarkdown(markdown) {
  const entityDecoder = document.createElement("textarea");
  const decodeEntities = (value) => value.replace(
    /&(?:#(?:x[\da-f]{1,6}|\d{1,7})|[a-z][a-z0-9]+);/gi,
    (entity) => {
      entityDecoder.innerHTML = entity;
      return entityDecoder.value;
    },
  );
  // Replace unicode replacement characters (\ufffd):
  let sanitized = markdown.replace(/\r\n?/g, "\n");
  sanitized = sanitized.replace(/^([ \t]*[-*•]?[ \t]*)[\ufffd\uFFFD][ \t]*/gm, "- ");
  sanitized = sanitized.replace(/[ \t]*[\ufffd\uFFFD][ \t]*/g, " → ");

  // Prevent table rows from breaking on <br>
  sanitized = sanitized.replace(/^\|[^\n]+\|$/gm, (row) => row.replace(/<br\s*\/?>/gi, " "));
  sanitized = sanitized.replace(/^(\d+(?:\.\d+)*\s+.+\|)$/gm, "|$1");

  const lines = sanitized.split("\n");
  const repeatedHeaders = new Map();
  for (const line of lines) {
    const match = line.match(/^\s*(?:\*\*|__)\s*(\d{1,3}\.\s+.+?)\s*(?:\*\*|__)\s*$/);
    if (match) {
      const key = match[1].replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR");
      repeatedHeaders.set(key, (repeatedHeaders.get(key) || 0) + 1);
    }
  }
  const contentLines = lines.filter((line) => {
    const trimmed = line.trim();
    const plain = trimmed.replace(/[*_`#]/g, "").trim();
    const numberedHeader = trimmed.match(/^\s*(?:\*\*|__)\s*(\d{1,3}\.\s+.+?)\s*(?:\*\*|__)\s*$/);
    const markupPlaceholder = /(?:<|&lt;)\/?(?:mark|u)(?:\s|>|&gt;)/i.test(trimmed)
      && !trimmed.replace(/<[^>]*>|&lt;[^&]*?&gt;/gi, "").replace(/[#*_~`\s]/g, "");
    // Detect and strip Table of Contents / Sumário / Índice lines with dots or page numbers
    const isTocHeader = /^(?:#+\s*)?(?:\*{1,2}|_{1,2})?\s*(?:sum[aá]rio|[ií]ndice|tabela\s+de\s+conte[uú]dos?)\b(?:\*{1,2}|_{1,2})?\s*[:：.]?$/i.test(trimmed);
    const isDottedTocLine = /(?:\.{3,}|…{2,})\s*(?:\*{1,2})?\s*\d+\s*(?:\*{1,2})?\s*$/i.test(trimmed)
      || /^\s*(?:\*{1,2})?\s*\d+(?:\.\d+)+\s*(?:\*{1,2})?.*(?:\.{3,}|…{2,})/i.test(trimmed);
    return !(
      isTocHeader
      || isDottedTocLine
      || /^(?:>|&gt;)?\s*(?:\d+(?:\.\d+)*\s+)?(?:estratégia\s*concursos|estratégiaconcursos)\b/i.test(trimmed)
      || /^[:：]?\s*<sup>Estrat[eé]gia<\/sup>\s*Concursos$/i.test(trimmed)
      || /^\d{1,3}\s*\/\s*\d{1,3}$/.test(plain)
      || markupPlaceholder
      || (numberedHeader && repeatedHeaders.get(numberedHeader[1].replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR")) > 1)
      || (/^(?:\*\*|__)?\s*Prof\.?\s+.+?(?:\*\*|__)?$/i.test(trimmed) && plain.length < 140)
      || (/^(?:>|&gt;)?\s*(?:\*\*|__)?[^*_]*\b(?:SEFAZ-SP|Auditor Fiscal)\b.*\d{1,3}\s*\/\s*\d{1,3}/i.test(trimmed))
      || (/^(?:>|&gt;)?\s*(?:\*\*|__)?[^*_]*\b(?:SEFAZ-SP|Auditor Fiscal)\b[^*_]*\bProf\.?\s+.+?(?:\*\*|__)?$/i.test(trimmed))
      || (/^(?:>|&gt;)?\s*(?:\*\*|__)?\s*\d{1,3}\.\s+[^*_\n]+\b(?:usuári|legislaç|administraç)\b(?:\*\*|__)?$/i.test(trimmed))
      || (/^(?:agora,?\s*)?(?:vamos\s+resolver\s+(?:algumas\s+)?questões|veja\s+como\s+(?:esse\s+assunto\s+|isso\s+)?(?:já\s+)?foi\s+cobrado)\s*[:：.]?$/i.test(trimmed))
    );
  });
  return contentLines.join("\n")
    .replace(/<!--\s*(?:Start|End) of picture text\s*-->/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(?:sup|sub|mark|u)\b[^>]*>/gi, "")
    .replace(/&lt;\/?(?:mark|sup|sub|u)\b[^&]*?&gt;/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/&(?:#(?:x[\da-f]{1,6}|\d{1,7})|[a-z][a-z0-9]+);/gi, decodeEntities);
}

function renderStudyCallout(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  if (/fun[cç][aã]o\s+da\s+contabilidade|objetivo\s+da\s+contabilidade/i.test(lower)) {
    return `<div class="content-callout concept"><span class="callout-label">Conceito-chave</span><div class="callout-text">${inlineMarkdown(normalized)}</div></div>`;
  }
  if (/credibilidade.*demonstra[cç][aã]o|demonstra[cç][aã]o.*credibilidade|credibilidade.*cont[aá]bil/i.test(lower)) {
    return `<div class="content-callout attention"><span class="callout-label">Atenção</span><div class="callout-text">${inlineMarkdown(normalized)}</div></div>`;
  }
  if (/princ[ií]pios\s+cont[aá]beis|princ[ií]pios\s+da\s+contabilidade/i.test(lower)) {
    return `<div class="content-callout summary"><span class="callout-label">Resumindo</span><div class="callout-text">${inlineMarkdown(normalized)}</div></div>`;
  }
  return null;
}

function parseContentsEntry(cells) {
  const parts = cells.map((cell) => cell
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/[*_`|]/g, "")
    .replace(/\.{2,}|…+/g, " ")
    .replace(/\s+/g, " ")
    .trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const fullText = parts.join(" ").replace(/\s+/g, " ").trim();
  // Match section numbers like 1.1, 1.2.1, 14.1
  const numberMatch = fullText.match(/^(\d+(?:\.\d+)+)(?:[.)])?\s+(.+)$/);
  if (numberMatch) {
    return extractTitleAndPage(numberMatch[1], numberMatch[2]);
  }
  const singleMatch = fullText.match(/^(\d+)(?:[.)])\s+(.+)$/);
  if (singleMatch) {
    return extractTitleAndPage(singleMatch[1], singleMatch[2]);
  }
  return null;
}

function extractTitleAndPage(number, rest) {
  let text = rest.replace(/\.{2,}|…+/g, " ").replace(/\s+/g, " ").trim();
  let page = "";
  const leadingPage = text.match(/^(\d{1,4})\s+(.+)$/);
  const trailingPage = text.match(/^(.+?)\s+(\d{1,4})$/);
  if (leadingPage && !/^\d+$/.test(leadingPage[2])) {
    page = leadingPage[1];
    text = leadingPage[2];
  } else if (trailingPage) {
    page = trailingPage[2];
    text = trailingPage[1];
  }
  text = text.replace(/^[|\s-]+|[|\s-]+$/g, "").trim();
  return text ? { number, page, title: text } : null;
}

function renderMarkdownTable(tableRows) {
  const rows = tableRows.filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line));
  if (!rows.length) return "";
  const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  const parsedRows = rows.map(cells);
  if (parsedRows.length === 1) {
    const singleToc = parseContentsEntry(parsedRows[0]);
    if (singleToc) {
      // Omit table of contents entry
      return "";
    }
    const text = parsedRows[0].filter(Boolean).join(" ").replace(/^[|\s-]+|[|\s-]+$/g, "");
    return `<p class="table-continuation">${inlineMarkdown(text)}</p>`;
  }
  const tocEntries = parsedRows.map(parseContentsEntry);
  const matchingEntries = tocEntries.filter(Boolean);
  const hasTocDottedPattern = parsedRows.some((row) => {
    const str = row.join(" ");
    return /(?:\.{3,}|…{2,})\s*(?:\*{1,2})?\s*\d+/i.test(str) || /^\s*(?:\*{1,2})?\d+(\.\d+)+\s*\)?.*(?:\d{1,4}\b|\.{3,})/i.test(str);
  });
  if (matchingEntries.length >= 1 && (matchingEntries.length >= 2 || matchingEntries.length / parsedRows.length >= 0.4 || hasTocDottedPattern)) {
    // Omit table of contents table completely per user request
    return "";
  }
  const header = parsedRows[0];
  const body = parsedRows.slice(1);
  return `<div class="study-table-wrap"><table class="study-table"><thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function renderMarkdown(markdown) {
  if (!markdown?.trim()) return '<p class="empty-state">Este material ainda não possui texto teórico separado.</p>';
  const normalizedMarkdown = normalizeContentMarkdown(markdown);
  const lines = normalizedMarkdown.split("\n");
  const html = [];
  let paragraph = [];
  let listType = "";
  let tableRows = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    const numberedTitle = text.match(/^\*{1,2}(\d+(?:\.\d+)*)(?:\s*[:.)-]\s*|\s+)(.+?)\*{1,2}\s*$/);
    if (numberedTitle) {
      const number = numberedTitle[1];
      const headingLevel = number.includes(".") ? 2 : 1;
      html.push(renderStudyHeading(headingLevel, `${number} ${numberedTitle[2]}`));
      paragraph = [];
      return;
    }
    const pictureRemainder = text.match(/^Usuários da contabilidade\b(?=.*Investidores atuais)(?=.*Empregados)(?=.*Credores)[\s\S]*$/i);
    if (pictureRemainder) {
      html.push(renderAccountingUsersDiagram());
      paragraph = [];
      return;
    }
    if (isAnswerLine(text)) {
      html.push(`<p class="content-answer"><strong>${inlineMarkdown(text)}</strong></p>`);
      paragraph = [];
      return;
    }
    const callout = renderStudyCallout(text);
    if (callout) {
      html.push(callout);
    } else {
      html.push(`<p>${inlineMarkdown(text)}</p>`);
    }
    paragraph = [];
  };
  const flushList = () => {
    if (listType) html.push(`</${listType}>`);
    listType = "";
  };
  const flushTable = () => {
    if (!tableRows.length) return;
    html.push(renderMarkdownTable(tableRows));
    tableRows = [];
  };
  const tableSeparator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    const list = line.match(/^([-*+]|\d+[.)])\s+(.+)$/);
    const nextLineIsSeparator = tableSeparator.test(lines[index + 1] || "");
    const isDelimitedTableRow = line.includes("|") && (line.startsWith("|") || line.endsWith("|"));
    if (line.includes("|") && (isDelimitedTableRow || tableRows.length > 0 || nextLineIsSeparator || tableSeparator.test(line))) {
      flushParagraph(); flushList(); tableRows.push(line); continue;
    }
    flushTable();
    if (!line) { flushParagraph(); flushList(); continue; }
    if (heading) {
      flushParagraph(); flushList();
      const level = Math.min(heading[1].length, 4);
      html.push(renderStudyHeading(level, heading[2]));
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

function renderAccountingUsersDiagram() {
  const users = [
    "Investidores atuais",
    "Investidores potenciais",
    "Empregados",
    "Credores",
    "Fornecedores",
    "Clientes",
    "Governos e agências",
    "Público",
  ];
  return `<div class="accounting-users-structure">
    <div class="users-header">Usuários da contabilidade</div>
    <div class="user-connector"><span class="connector-line"></span><div class="user-group">Usuários externos</div><span class="connector-line"></span></div>
    <div class="users-grid">${users.map((user) => `<div class="user-pill">${user}</div>`).join("")}</div>
  </div>`;
}

function getAttempts() {
  const attempts = readStorage(STORAGE_KEYS.attempts, []);
  return sanitizeAttemptHistory(attempts);
}

async function loadQuestionIndex() {
  if (state.questionIndexCache) return state.questionIndexCache;
  const file = state.manifest.questionIndexFile || "question-index.json";
  try {
    const data = await loadPrivateJson(file);
    state.questionIndexCache = new Map((data.questions || []).map((question) => [question.id, question]));
    const attempts = readStorage(STORAGE_KEYS.attempts, []);
    sanitizeAttemptHistory(attempts);
  } catch (error) {
    console.error(error);
    state.questionIndexCache = new Map();
    showNotice(`Não foi possível carregar o índice privado de assuntos e bancas: ${error.message}`);
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
  const data = await loadPrivateJson(subject.file);
  state.subjectCache.set(subjectId, data);
  return data;
}

function setTab(tab) {
  if (!state.manifest || !state.authUser || !state.cloudReady) return;
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
  state.questionMaterialId = "all";
  state.selectedAnswer = null;
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
      <article class="card stat-card"><div class="stat-top"><span>Questões respondidas</span><span class="stat-icon">☑</span></div><div class="stat-value">${attempts.length.toLocaleString("pt-BR")}</div><div class="stat-note">${state.authUser && state.cloudReady ? "Histórico sincronizado com sua conta" : "Histórico salvo neste dispositivo"}</div></article>
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
    <div class="dashboard-footer"><span>✦</span><span><strong>${state.authUser && state.cloudReady ? "Seu progresso está vinculado à sua conta." : "Seu progresso fica neste dispositivo."}</strong> ${state.authUser && state.cloudReady ? "Somente sua conta autenticada pode acessar seu histórico." : "Entre ou crie uma conta para sincronizar o histórico entre dispositivos."}</span></div>
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

function formatCalendarLongDate(dateKey) {
  if (!dateKey) return "";
  const parts = dateKey.split("-").map(Number);
  if (parts.length < 3) return dateKey;
  const date = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
  const weekday = date.toLocaleDateString("pt-BR", { weekday: "long" });
  const day = date.getDate();
  const month = date.toLocaleDateString("pt-BR", { month: "long" });
  const year = date.getFullYear();
  return `${weekday.charAt(0).toUpperCase() + weekday.slice(1)}, ${day} de ${month} de ${year}`;
}

function formatCalendarShortDate(dateKey) {
  if (!dateKey) return "";
  const parts = dateKey.split("-").map(Number);
  if (parts.length < 3) return dateKey;
  return `${String(parts[2]).padStart(2, "0")}/${String(parts[1]).padStart(2, "0")}/${parts[0]}`;
}

function getCalendarRelativeBadge(dateKey) {
  const today = localDateKey();
  if (dateKey === today) return "Hoje";
  const tomorrow = localDateKey(addDays(new Date(), 1));
  if (dateKey === tomorrow) return "Amanhã";
  const yesterday = localDateKey(addDays(new Date(), -1));
  if (dateKey === yesterday) return "Ontem";
  return "";
}

function collectCalendarItems(targetMonth, schedule, events, plan, questionReviews, materialReviews, completions) {
  const itemsByDate = new Map();
  const addItem = (item) => {
    if (!itemsByDate.has(item.date)) itemsByDate.set(item.date, []);
    itemsByDate.get(item.date).push(item);
  };

  const subjectNames = new Map(state.manifest.subjects.map((s) => [s.id, s.name]));
  const year = targetMonth.getFullYear();
  const month = targetMonth.getMonth();

  // Cobrir desde 14 dias antes do 1º dia do mês até 21 dias depois do fim
  const startDate = new Date(year, month, 1 - 14);
  const endDate = new Date(year, month + 1, 21);

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateKey = localDateKey(d);
    const dayOfWeek = d.getDay();

    for (const entry of plan?.entries || []) {
      if (Number(entry.weekday) === dayOfWeek) {
        const id = `plan-${dateKey}-${entry.id || entry.startTime}-${entry.subjectId}`;
        addItem({
          id,
          date: dateKey,
          time: entry.startTime || "08:00",
          minutes: entry.minutes || 30,
          title: subjectNames.get(entry.subjectId) || "Estudo do Ciclo",
          type: "plan",
          category: "plan",
          typeLabel: "Ciclo de Estudos",
          subjectId: entry.subjectId,
          subjectName: subjectNames.get(entry.subjectId) || "Disciplina",
          materialId: null,
          questionId: null,
          completed: !!completions[id],
          isCustom: false,
        });
      }
    }

    for (const entry of schedule) {
      if (Number(entry.weekday) === dayOfWeek) {
        const id = `sched-${dateKey}-${entry.id || entry.startTime}`;
        addItem({
          id,
          date: dateKey,
          time: entry.startTime || "08:00",
          minutes: entry.minutes || 60,
          title: subjectNames.get(entry.subjectId) || "Rotina de Estudos",
          type: "study",
          category: "plan",
          typeLabel: "Rotina Semanal",
          subjectId: entry.subjectId,
          subjectName: subjectNames.get(entry.subjectId) || "Disciplina",
          materialId: null,
          questionId: null,
          completed: !!completions[id],
          isCustom: false,
        });
      }
    }
  }

  for (const [questionId, review] of Object.entries(questionReviews)) {
    if (!review.dueAt) continue;
    const dateKey = localDateKey(new Date(review.dueAt));
    const metadata = state.questionIndexCache?.get(questionId);
    const id = `rev-q-${questionId}-${dateKey}`;
    addItem({
      id,
      date: dateKey,
      time: "09:00",
      minutes: 15,
      title: metadata?.topic ? `Questão: ${metadata.topic}` : (metadata?.bank ? `Questão ${metadata.bank}` : "Revisão de Questão"),
      type: "review",
      category: "review",
      typeLabel: "Revisão de Questão",
      subjectId: metadata?.subjectId || null,
      subjectName: metadata?.subjectName || (metadata?.subjectId ? subjectNames.get(metadata.subjectId) : null),
      materialId: null,
      questionId,
      completed: !!completions[id],
      isCustom: false,
    });
  }

  for (const [materialId, review] of Object.entries(materialReviews)) {
    if (!review.dueAt) continue;
    const dateKey = localDateKey(new Date(review.dueAt));
    const id = `rev-m-${materialId}-${dateKey}`;
    addItem({
      id,
      date: dateKey,
      time: "09:30",
      minutes: 25,
      title: review.title ? `Conteúdo: ${review.title}` : "Revisão de Conteúdo",
      type: "review",
      category: "review",
      typeLabel: "Revisão de Conteúdo",
      subjectId: review.subjectId || null,
      subjectName: review.subjectId ? subjectNames.get(review.subjectId) : null,
      materialId,
      questionId: null,
      completed: !!completions[id],
      isCustom: false,
    });
  }

  for (const event of events) {
    if (!event.date) continue;
    const id = `event-${event.id}`;
    const typeLabel = event.type === "simulation" ? "Simulado" : (event.type === "review" ? "Revisão" : "Meta / Lembrete");
    addItem({
      id,
      date: event.date,
      time: event.time || "08:00",
      minutes: event.minutes || 60,
      title: event.title,
      type: event.type || "goal",
      category: "custom",
      typeLabel,
      subjectId: null,
      subjectName: null,
      materialId: null,
      questionId: null,
      completed: !!completions[id],
      isCustom: true,
      originalId: event.id,
    });
  }

  for (const list of itemsByDate.values()) {
    list.sort((a, b) => a.time.localeCompare(b.time) || a.title.localeCompare(b.title));
  }

  return itemsByDate;
}

function filterCalendarItems(items, filter) {
  if (!filter || filter === "all") return items;
  if (filter === "plan") return items.filter((i) => i.category === "plan");
  if (filter === "review") return items.filter((i) => i.category === "review");
  if (filter === "custom") return items.filter((i) => i.category === "custom" || i.type === "simulation" || i.type === "goal");
  if (filter === "pending") return items.filter((i) => !i.completed);
  if (filter === "completed") return items.filter((i) => i.completed);
  return items;
}

function renderCalendarMonthView(month, itemsByDate) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstDay = new Date(year, monthIndex, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const todayKey = localDateKey();

  const headers = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
  const headerHtml = headers.map((h) => `<div class="cal-col-header">${h}</div>`).join("");
  const blankHtml = Array.from({ length: startOffset }, () => '<div class="cal-day-cell empty"></div>').join("");

  const daysHtml = Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1;
    const dateKey = localDateKey(new Date(year, monthIndex, day));
    const allItems = itemsByDate.get(dateKey) || [];
    const filtered = filterCalendarItems(allItems, state.calendarFilter);
    const completedCount = allItems.filter((item) => item.completed).length;
    const isSelected = dateKey === state.calendarSelectedDate;
    const isToday = dateKey === todayKey;

    const planItems = filtered.filter((item) => item.category === "plan");
    const reviewItems = filtered.filter((item) => item.category === "review");
    const customItems = filtered.filter((item) => item.category === "custom");

    const planMinutes = planItems.reduce((sum, item) => sum + (item.minutes || 30), 0);
    const allDone = allItems.length > 0 && completedCount === allItems.length;

    let cellClasses = "cal-day-cell";
    if (isToday) cellClasses += " today";
    if (isSelected) cellClasses += " selected";
    if (allItems.length) cellClasses += " has-events";
    if (allDone) cellClasses += " all-done";

    return `
      <div class="${cellClasses}" data-calendar-date="${dateKey}" role="button" tabindex="0" aria-label="Dia ${day}, ${allItems.length} atividades">
        <div class="cal-day-cell-top">
          <span class="cal-day-num">${day}</span>
          ${allItems.length ? `
            <span class="cal-day-counter ${allDone ? 'done' : ''}" title="${completedCount} de ${allItems.length} concluídas">
              ${allDone ? '✓ ' : ''}${completedCount}/${allItems.length}
            </span>
          ` : ""}
        </div>
        <div class="cal-day-badges-list">
          ${planItems.length ? `
            <div class="cal-badge plan" title="${planItems.length} blocos de estudo no ciclo (${(planMinutes / 60).toFixed(1)} h)">
              <span class="badge-dot"></span>
              <span class="badge-label">${planItems.length} blocos (${(planMinutes / 60).toFixed(1)}h)</span>
            </div>
          ` : ""}
          ${reviewItems.length ? `
            <div class="cal-badge review" title="${reviewItems.length} revisões agendadas">
              <span class="badge-dot"></span>
              <span class="badge-label">🔄 ${reviewItems.length} revisão(ões)</span>
            </div>
          ` : ""}
          ${customItems.slice(0, 2).map((item) => `
            <div class="cal-badge ${item.type === 'simulation' ? 'simulation' : 'custom'}" title="${escapeHtml(item.title)}">
              <span class="badge-dot"></span>
              <span class="badge-label">${item.type === 'simulation' ? '🎯' : '⭐'} ${escapeHtml(item.title)}</span>
            </div>
          `).join("")}
          ${customItems.length > 2 ? `<span class="cal-badge-more">+${customItems.length - 2} mais</span>` : ""}
        </div>
      </div>
    `;
  }).join("");

  return `<div class="calendar-month-grid">${headerHtml}${blankHtml}${daysHtml}</div>`;
}

function renderCalendarWeekView(itemsByDate) {
  const selectedDate = state.calendarSelectedDate
    ? new Date(`${state.calendarSelectedDate}T12:00:00`)
    : new Date();
  const dayOfWeek = selectedDate.getDay();
  const mondayOffset = (dayOfWeek + 6) % 7;
  const monday = new Date(selectedDate);
  monday.setDate(selectedDate.getDate() - mondayOffset);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }

  const todayKey = localDateKey();
  const weekdayNames = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];

  const columnsHtml = days.map((d, index) => {
    const dateKey = localDateKey(d);
    const allItems = itemsByDate.get(dateKey) || [];
    const filtered = filterCalendarItems(allItems, state.calendarFilter);
    const completedCount = allItems.filter((i) => i.completed).length;
    const isToday = dateKey === todayKey;
    const isSelected = dateKey === state.calendarSelectedDate;

    return `
      <div class="cal-week-col ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}" data-calendar-date="${dateKey}">
        <div class="cal-week-col-head">
          <span class="cal-week-day-name">${weekdayNames[index]}</span>
          <span class="cal-week-date-num">${d.getDate()}/${d.getMonth() + 1}</span>
          ${allItems.length ? `
            <small class="cal-week-progress">${completedCount}/${allItems.length} feitos</small>
          ` : `<small class="cal-week-empty-hint">Livre</small>`}
        </div>
        <div class="cal-week-tasks-stack">
          ${filtered.length ? filtered.map((item) => `
            <div class="cal-week-task-item ${item.completed ? 'completed' : ''} ${item.type}">
              <label class="task-check-mini">
                <input type="checkbox" class="cal-task-checkbox" data-task-id="${item.id}" ${item.completed ? 'checked' : ''}>
                <span class="check-box"></span>
              </label>
              <div class="task-week-content">
                <span class="task-week-time">${escapeHtml(item.time)} (${item.minutes}m)</span>
                <span class="task-week-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
              </div>
            </div>
          `).join("") : `
            <div class="cal-week-empty">Sem tarefas</div>
          `}
        </div>
        <button class="cal-week-add-btn" type="button" data-quick-date="${dateKey}" title="Adicionar atividade neste dia">
          ＋ Adicionar
        </button>
      </div>
    `;
  }).join("");

  return `
    <div class="calendar-week-wrap">
      <div class="calendar-week-grid">${columnsHtml}</div>
    </div>
  `;
}

function renderCalendarAgendaView(itemsByDate) {
  const dates = [...itemsByDate.keys()].sort();
  const todayKey = localDateKey();
  const relevantDates = dates.filter((d) => {
    const list = filterCalendarItems(itemsByDate.get(d) || [], state.calendarFilter);
    return list.length > 0;
  });

  if (!relevantDates.length) {
    return `<div class="empty-state">Nenhuma atividade encontrada com o filtro selecionado.</div>`;
  }

  return `
    <div class="calendar-agenda-list">
      ${relevantDates.slice(0, 15).map((dateKey) => {
        const items = filterCalendarItems(itemsByDate.get(dateKey) || [], state.calendarFilter);
        const isToday = dateKey === todayKey;
        const relBadge = getCalendarRelativeBadge(dateKey);

        return `
          <div class="cal-agenda-day-card ${isToday ? 'today' : ''}">
            <div class="cal-agenda-day-header">
              <div class="cal-agenda-day-title">
                <strong>${formatCalendarLongDate(dateKey)}</strong>
                ${relBadge ? `<span class="day-relative-badge ${isToday ? 'today' : ''}">${relBadge}</span>` : ""}
              </div>
              <span class="cal-agenda-count">${items.length} atividade(s)</span>
            </div>
            <div class="cal-agenda-items">
              ${items.map((item) => `
                <div class="day-task-card ${item.completed ? 'completed' : ''} ${item.type}">
                  <label class="task-check-wrap">
                    <input type="checkbox" class="cal-task-checkbox" data-task-id="${item.id}" ${item.completed ? 'checked' : ''}>
                    <span class="task-checkmark"></span>
                  </label>
                  <div class="task-info-main">
                    <div class="task-meta-row">
                      <span class="task-badge ${item.type}">${escapeHtml(item.typeLabel)}</span>
                      <span class="task-time">🕒 ${escapeHtml(item.time)} (${item.minutes} min)</span>
                      ${item.completed ? '<span class="task-status-done">✓ Concluído</span>' : ''}
                    </div>
                    <div class="task-title-text ${item.completed ? 'strikethrough' : ''}">
                      ${escapeHtml(item.title)}
                    </div>
                  </div>
                  <div class="task-card-actions">
                    ${item.subjectId ? `
                      <button type="button" class="button secondary btn-sm" data-study-subject="${escapeHtml(item.subjectId)}" title="Abrir material desta disciplina">▶ Estudar</button>
                    ` : ""}
                    ${item.questionId ? `
                      <button type="button" class="button secondary btn-sm" data-review-question="${escapeHtml(item.questionId)}" title="Abrir questão para revisão">🔍 Revisar</button>
                    ` : ""}
                    ${item.materialId ? `
                      <button type="button" class="button secondary btn-sm" data-review-material="${escapeHtml(item.materialId)}" title="Abrir conteúdo para revisão">📖 Revisar</button>
                    ` : ""}
                    ${item.isCustom ? `
                      <button type="button" class="btn-icon-danger" data-delete-event="${escapeHtml(item.originalId)}" title="Excluir este evento">🗑️</button>
                    ` : ""}
                  </div>
                </div>
              `).join("")}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderSelectedDayPanel(itemsByDate) {
  const selectedDate = state.calendarSelectedDate || localDateKey();
  const allItems = itemsByDate.get(selectedDate) || [];
  const filtered = filterCalendarItems(allItems, state.calendarFilter);
  const completedCount = allItems.filter((i) => i.completed).length;
  const totalMinutes = allItems.reduce((sum, item) => sum + (item.minutes || 0), 0);
  const pct = allItems.length ? Math.round((completedCount / allItems.length) * 100) : 0;
  const relBadge = getCalendarRelativeBadge(selectedDate);

  return `
    <section class="card calendar-day-panel" id="calendar-day-panel">
      <div class="day-panel-header">
        <div class="day-panel-title">
          <h3>📅 Detalhes do Dia: ${formatCalendarLongDate(selectedDate)}</h3>
          ${relBadge ? `<span class="day-relative-badge ${relBadge === 'Hoje' ? 'today' : ''}">${relBadge}</span>` : ""}
        </div>
        <div class="day-panel-stats">
          <div class="day-stat-chip">
            <span>Atividades:</span> <strong>${allItems.length}</strong>
          </div>
          <div class="day-stat-chip">
            <span>Concluídas:</span> <strong class="${completedCount === allItems.length && allItems.length > 0 ? 'text-done' : ''}">${completedCount}</strong>
          </div>
          <div class="day-stat-chip">
            <span>Tempo planejado:</span> <strong>${(totalMinutes / 60).toFixed(1)} h</strong>
          </div>
        </div>
      </div>

      ${allItems.length ? `
        <div class="day-progress-bar-row">
          <div class="progress-track">
            <div class="progress-fill ${pct === 100 ? 'done' : ''}" style="width: ${pct}%"></div>
          </div>
          <span class="day-progress-pct">${pct}% concluído (${completedCount}/${allItems.length})</span>
        </div>
      ` : ""}

      <div class="day-tasks-list">
        ${filtered.length ? filtered.map((item) => `
          <div class="day-task-card ${item.completed ? 'completed' : ''} ${item.type}">
            <label class="task-check-wrap" title="${item.completed ? 'Marcar como pendente' : 'Marcar como concluída'}">
              <input type="checkbox" class="cal-task-checkbox" data-task-id="${item.id}" ${item.completed ? 'checked' : ''}>
              <span class="task-checkmark"></span>
            </label>
            <div class="task-info-main">
              <div class="task-meta-row">
                <span class="task-badge ${item.type}">${escapeHtml(item.typeLabel)}</span>
                <span class="task-time">🕒 ${escapeHtml(item.time)} (${item.minutes} min)</span>
                ${item.completed ? '<span class="task-status-done">✓ Concluído</span>' : ''}
              </div>
              <div class="task-title-text ${item.completed ? 'strikethrough' : ''}">
                ${escapeHtml(item.title)}
              </div>
            </div>
            <div class="task-card-actions">
              ${item.subjectId ? `
                <button type="button" class="button secondary btn-sm" data-study-subject="${escapeHtml(item.subjectId)}" title="Abrir material desta disciplina">
                  ▶ Estudar
                </button>
              ` : ""}
              ${item.questionId ? `
                <button type="button" class="button secondary btn-sm" data-review-question="${escapeHtml(item.questionId)}" title="Abrir questão para revisão">
                  🔍 Revisar
                </button>
              ` : ""}
              ${item.materialId ? `
                <button type="button" class="button secondary btn-sm" data-review-material="${escapeHtml(item.materialId)}" title="Abrir conteúdo para revisão">
                  📖 Revisar
                </button>
              ` : ""}
              ${item.isCustom ? `
                <button type="button" class="btn-icon-danger" data-delete-event="${escapeHtml(item.originalId)}" title="Excluir este evento">
                  🗑️
                </button>
              ` : ""}
            </div>
          </div>
        `).join("") : `
          <div class="empty-state compact">
            ${allItems.length ? "Nenhuma atividade corresponde ao filtro selecionado." : "Nenhuma atividade agendada para este dia."}
          </div>
        `}
      </div>

      <div class="day-add-form-wrap">
        <div class="day-add-form-title">
          <strong>＋ Adicionar atividade em ${formatCalendarShortDate(selectedDate)}:</strong>
        </div>
        <form id="calendar-day-quick-add-form" class="day-quick-add-form">
          <input class="form-control" id="day-add-title" placeholder="Ex.: Simulado 50 questões, Revisão de Custos, Meta..." required maxlength="120">
          <div class="form-row-quick">
            <select class="form-control" id="day-add-type">
              <option value="goal">Meta / Lembrete</option>
              <option value="simulation">Simulado</option>
              <option value="review">Revisão</option>
            </select>
            <input class="form-control" type="time" id="day-add-time" value="08:00">
            <button class="button" type="submit">＋ Salvar atividade</button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function buildInteractiveCalendar(month, schedule, events, plan, questionReviews, materialReviews, completions) {
  const itemsByDate = collectCalendarItems(month, schedule, events, plan, questionReviews, materialReviews, completions);

  const monthLabel = month.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  const capitalizedMonth = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);

  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  let totalMonthItems = 0;
  let totalPlan = 0;
  let totalReviews = 0;
  let totalCustom = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const k = localDateKey(new Date(year, monthIndex, day));
    const items = itemsByDate.get(k) || [];
    totalMonthItems += items.length;
    for (const item of items) {
      if (item.category === "plan") totalPlan++;
      else if (item.category === "review") totalReviews++;
      else if (item.category === "custom") totalCustom++;
    }
  }

  let viewContent = "";
  if (state.calendarViewMode === "week") {
    viewContent = renderCalendarWeekView(itemsByDate);
  } else if (state.calendarViewMode === "agenda") {
    viewContent = renderCalendarAgendaView(itemsByDate);
  } else {
    viewContent = renderCalendarMonthView(month, itemsByDate);
  }

  const dayPanelContent = renderSelectedDayPanel(itemsByDate);

  return `
    <div class="interactive-calendar-wrapper">
      <div class="calendar-top-bar">
        <div class="calendar-nav-group">
          <div class="calendar-nav-buttons">
            <button class="calendar-nav-btn" id="calendar-prev" type="button" title="Mês anterior" aria-label="Mês anterior">‹</button>
            <button class="calendar-today-btn" id="calendar-today" type="button" title="Ir para o dia de hoje">Hoje</button>
            <button class="calendar-nav-btn" id="calendar-next" type="button" title="Próximo mês" aria-label="Próximo mês">›</button>
          </div>
          <div class="calendar-title-display">
            <h3 class="calendar-period-heading">${escapeHtml(capitalizedMonth)}</h3>
            <span class="calendar-period-sub">${totalMonthItems} atividades no mês</span>
          </div>
        </div>

        <div class="calendar-view-switcher">
          <button class="cal-view-tab ${state.calendarViewMode === "month" ? "active" : ""}" data-cal-view="month" type="button">
            <span>🗓️</span> Mês
          </button>
          <button class="cal-view-tab ${state.calendarViewMode === "week" ? "active" : ""}" data-cal-view="week" type="button">
            <span>📅</span> Semana
          </button>
          <button class="cal-view-tab ${state.calendarViewMode === "agenda" ? "active" : ""}" data-cal-view="agenda" type="button">
            <span>📋</span> Agenda
          </button>
        </div>
      </div>

      <div class="calendar-filter-bar">
        <div class="filter-pills-group">
          <span class="filter-label">Filtrar:</span>
          <button class="filter-pill ${state.calendarFilter === "all" ? "active" : ""}" data-cal-filter="all" type="button">Todas (${totalMonthItems})</button>
          <button class="filter-pill ${state.calendarFilter === "plan" ? "active" : ""}" data-cal-filter="plan" type="button">📘 Ciclo (${totalPlan})</button>
          <button class="filter-pill ${state.calendarFilter === "review" ? "active" : ""}" data-cal-filter="review" type="button">🔄 Revisões (${totalReviews})</button>
          <button class="filter-pill ${state.calendarFilter === "custom" ? "active" : ""}" data-cal-filter="custom" type="button">🎯 Simulados / Metas (${totalCustom})</button>
          <button class="filter-pill ${state.calendarFilter === "pending" ? "active" : ""}" data-cal-filter="pending" type="button">⏳ Pendentes</button>
          <button class="filter-pill ${state.calendarFilter === "completed" ? "active" : ""}" data-cal-filter="completed" type="button">✅ Concluídas</button>
        </div>
      </div>

      <div class="calendar-main-view">
        ${viewContent}
      </div>

      ${dayPanelContent}
    </div>
  `;
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
  const calendarCompletions = readStorage(STORAGE_KEYS.calendarCompletions, {});
  state.calendarSelectedDate = state.calendarSelectedDate || localDateKey();
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
        <div class="panel-heading">
          <div>
            <p class="eyebrow">AGENDA INTERATIVA</p>
            <h2>Calendário de estudos</h2>
            <p>Rotina semanal, plano automático, revisões e simulados com acompanhamento dinâmico.</p>
          </div>
        </div>
        ${buildInteractiveCalendar(state.calendarMonth, schedule, events, plan, reviewSchedules, materialReviews, calendarCompletions)}
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

  // Interatividade do Calendário
  view.querySelectorAll("[data-cal-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.calendarViewMode = btn.dataset.calView;
      renderOrganization();
    });
  });

  view.querySelectorAll("[data-cal-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.calendarFilter = btn.dataset.calFilter;
      renderOrganization();
    });
  });

  view.querySelectorAll("[data-calendar-date]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".cal-task-checkbox") || e.target.closest("button") || e.target.closest("input")) return;
      state.calendarSelectedDate = el.dataset.calendarDate;
      renderOrganization();
      const panel = document.getElementById("calendar-day-panel");
      if (panel && window.innerWidth < 900) {
        panel.scrollIntoView({ behavior: "smooth" });
      }
    });
  });

  view.querySelectorAll(".cal-task-checkbox").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const taskId = e.target.dataset.taskId;
      const completions = readStorage(STORAGE_KEYS.calendarCompletions, {});
      if (e.target.checked) completions[taskId] = true;
      else delete completions[taskId];
      writeStorage(STORAGE_KEYS.calendarCompletions, completions);
      renderOrganization();
    });
  });

  view.querySelectorAll("[data-quick-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.calendarSelectedDate = btn.dataset.quickDate;
      renderOrganization();
      document.getElementById("day-add-title")?.focus();
    });
  });

  const calendarPrev = document.getElementById("calendar-prev");
  if (calendarPrev) {
    calendarPrev.addEventListener("click", () => {
      state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
      renderOrganization();
    });
  }

  const calendarNext = document.getElementById("calendar-next");
  if (calendarNext) {
    calendarNext.addEventListener("click", () => {
      state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
      renderOrganization();
    });
  }

  const calendarToday = document.getElementById("calendar-today");
  if (calendarToday) {
    calendarToday.addEventListener("click", () => {
      const now = new Date();
      state.calendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      state.calendarSelectedDate = localDateKey(now);
      renderOrganization();
    });
  }

  const quickAddForm = document.getElementById("calendar-day-quick-add-form");
  if (quickAddForm) {
    quickAddForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const title = document.getElementById("day-add-title").value.trim();
      const type = document.getElementById("day-add-type").value;
      const time = document.getElementById("day-add-time").value || "08:00";
      if (!title) return;
      const nextEvents = readStorage(STORAGE_KEYS.studyEvents, []);
      nextEvents.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        title,
        date: state.calendarSelectedDate || localDateKey(),
        type,
        time,
      });
      writeStorage(STORAGE_KEYS.studyEvents, nextEvents);
      showNotice(`Atividade adicionada para ${formatCalendarShortDate(state.calendarSelectedDate || localDateKey())}!`);
      renderOrganization();
    });
  }

  view.querySelectorAll("[data-study-subject]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setSubject(btn.dataset.studySubject);
      setTab("contents");
    });
  });

  view.querySelectorAll("[data-delete-event]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.deleteEvent;
    if (window.confirm("Deseja excluir esta atividade do calendário?")) {
      writeStorage(STORAGE_KEYS.studyEvents, readStorage(STORAGE_KEYS.studyEvents, []).filter((item) => item.id !== id));
      renderOrganization();
    }
  }));

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

function formatDateTimePtBr(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} às ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getReadingBookmark(materialId) {
  const positions = readStorage(STORAGE_KEYS.readingPositions, {});
  return positions && typeof positions === "object" ? positions[materialId] || null : null;
}

function getLastGlobalBookmark() {
  const positions = readStorage(STORAGE_KEYS.readingPositions, {});
  return positions && typeof positions === "object" ? positions._last || null : null;
}

function calculateReadingProgress() {
  const doc = document.documentElement;
  const body = document.body;
  const scrollTop = window.scrollY || doc.scrollTop || body.scrollTop || 0;
  const scrollHeight = Math.max(doc.scrollHeight, body.scrollHeight);
  const clientHeight = window.innerHeight || doc.clientHeight || 0;
  const maxScroll = scrollHeight - clientHeight;
  if (maxScroll <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((scrollTop / maxScroll) * 100)));
}

function saveReadingBookmark(material, subject) {
  const positions = readStorage(STORAGE_KEYS.readingPositions, {});
  const now = new Date();
  const formatted = formatDateTimePtBr(now);
  const currentScrollY = Math.max(0, Math.round(window.scrollY));
  const percentage = calculateReadingProgress();
  const bookmark = {
    materialId: material.id,
    materialTitle: material.title,
    subjectId: subject.id,
    subjectName: subject.name,
    scrollY: currentScrollY,
    percentage,
    savedAt: now.toISOString(),
    savedAtFormatted: formatted,
  };
  positions[material.id] = bookmark;
  positions._last = bookmark;
  writeStorage(STORAGE_KEYS.readingPositions, positions);
  return bookmark;
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
    const currentBookmark = getReadingBookmark(activeMaterial.id);
    const lastGlobalBookmark = getLastGlobalBookmark();

    // Limpar estado legado de coluna colapsada para evitar coluna vazia
    const listView = readStorage(STORAGE_KEYS.contentListView, {});
    if (listView.collapsed !== undefined) {
      delete listView.collapsed;
      writeStorage(STORAGE_KEYS.contentListView, listView);
    }

    view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">BIBLIOTECA DE MATERIAIS</p><h1>Conteúdos</h1><p class="page-subtitle">${escapeHtml(data.subject.name)} · ${data.materials.length} materiais para estudar no seu ritmo.</p></div></div>
      ${lastGlobalBookmark && lastGlobalBookmark.materialId !== activeMaterial.id ? `
        <div class="last-reading-banner">
          <div class="last-reading-info">
            <span>📍</span>
            <span>Último ponto gravado: <strong>${escapeHtml(lastGlobalBookmark.materialTitle)}</strong> <small>(${escapeHtml(lastGlobalBookmark.savedAtFormatted)})</small></span>
          </div>
          <button class="last-reading-btn" id="go-to-last-bookmark-btn" type="button">Ir para onde parei →</button>
        </div>
      ` : ""}
      <div class="content-toolbar card">
        <label class="content-subject-label" for="content-subject">Estudando agora</label>
        <select class="select-control" id="content-subject" aria-label="Selecionar disciplina para estudar">${state.manifest.subjects.map((subject) => `<option value="${subject.id}" ${subject.id === data.subject.id ? "selected" : ""}>${escapeHtml(subject.name)}</option>`).join("")}</select>
        <div class="content-completion" aria-live="polite"><strong id="completed-count">${completedCount} / ${data.materials.length}</strong><span>materiais estudados</span></div>
      </div>
      <div class="content-layout">
        <aside class="card content-list" id="content-material-list">
          <div class="list-header">
            <div class="list-header-title">
              <h2>Materiais da disciplina</h2>
              <div class="list-header-actions">
                <button class="list-view-button" id="hide-material-list" type="button" aria-controls="content-material-list" title="Ocultar lista" aria-label="Ocultar lista de materiais">×</button>
              </div>
            </div>
            <input class="search-input" id="material-search" placeholder="Buscar conteúdo..." aria-label="Buscar conteúdo">
          </div>
          <div class="material-list" id="material-list"></div>
        </aside>
        <article class="card reader">
          <button class="show-material-list" id="show-material-list" type="button" hidden>☷ Mostrar materiais</button>
          <div class="reader-head">
            <div class="reader-title">
              <h2>${escapeHtml(activeMaterial.title)}</h2>
              <div class="reader-meta">${escapeHtml(data.subject.name)} · ${activeMaterial.questions.length} questões associadas</div>
            </div>
            <label class="material-study-toggle ${completed[activeMaterial.id] ? "completed" : ""}" id="material-study-label" for="material-studied">
              <input id="material-studied" type="checkbox" ${completed[activeMaterial.id] ? "checked" : ""}>
              <span id="material-study-state">${completed[activeMaterial.id] ? "Conteúdo estudado" : "Marcar como estudado"}</span>
            </label>
          </div>

          ${currentBookmark ? `
            <div class="reader-bookmark-banner" id="reader-bookmark-banner">
              <div class="reader-bookmark-banner-info">
                <span class="bookmark-icon">📍</span>
                <span>Ponto gravado neste material: <strong>${currentBookmark.percentage ?? 0}% lido</strong> <small>(${escapeHtml(currentBookmark.savedAtFormatted)})</small></span>
              </div>
              <button class="button bookmark-return-btn" id="banner-return-btn" type="button">
                Voltar para onde parei →
              </button>
            </div>
          ` : ""}

          <div class="markdown-body" id="reader-markdown">${renderMarkdown(activeMaterial.content)}</div>
        </article>
      </div>

      <aside class="reading-companion-dock" id="reading-companion-dock" aria-label="Acompanhamento de leitura">
        <div class="companion-dock-content">
          <div class="companion-progress-badge">
            <span class="companion-icon">📖</span>
            <span class="companion-progress-text" id="reading-progress-pill">${calculateReadingProgress()}% lido</span>
          </div>
          <div class="companion-divider"></div>
          <button class="companion-btn companion-save-btn" id="dock-save-btn" type="button" title="Gravar o ponto exato da sua leitura agora com data e hora">
            <span class="btn-icon">📌</span>
            <span class="btn-text">Gravar onde parei</span>
          </button>
          <button class="companion-btn companion-return-btn ${currentBookmark ? "" : "hidden"}" id="dock-return-btn" type="button" title="${currentBookmark ? `Voltar ao ponto gravado (${currentBookmark.percentage ?? 0}% - ${escapeHtml(currentBookmark.savedAtFormatted)})` : "Nenhum ponto gravado"}">
            <span class="btn-icon">📍</span>
            <span class="btn-text">${currentBookmark ? `Voltar (${currentBookmark.percentage ?? 0}%)` : "Voltar"}</span>
          </button>
          <button class="companion-btn companion-top-btn" id="dock-top-btn" type="button" title="Voltar ao início da página">
            <span>↑ Topo</span>
          </button>
        </div>
        <div class="companion-toast" id="dock-toast" hidden></div>
      </aside>`;

    const contentLayout = view.querySelector(".content-layout");
    const contentList = view.querySelector(".content-list");
    const hideButton = document.getElementById("hide-material-list");
    const showButton = document.getElementById("show-material-list");
    const updateListView = () => {
      contentLayout.classList.toggle("list-hidden", listView.hidden === true);
      contentList.hidden = listView.hidden === true;
      showButton.hidden = listView.hidden !== true;
      writeStorage(STORAGE_KEYS.contentListView, listView);
    };
    if (hideButton) {
      hideButton.addEventListener("click", () => {
        listView.hidden = true;
        updateListView();
      });
    }
    if (showButton) {
      showButton.addEventListener("click", () => {
        listView.hidden = false;
        updateListView();
      });
    }
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

    // Acompanhamento e marcador dinâmico de leitura
    const progressPill = document.getElementById("reading-progress-pill");
    const updateProgress = () => {
      if (progressPill) {
        const pct = calculateReadingProgress();
        progressPill.textContent = `${pct}% lido`;
      }
    };

    if (state._readerScrollHandler) {
      window.removeEventListener("scroll", state._readerScrollHandler);
    }
    state._readerScrollHandler = updateProgress;
    window.addEventListener("scroll", state._readerScrollHandler, { passive: true });
    updateProgress();

    const scrollToBookmark = (bookmark) => {
      if (!bookmark) return;
      const targetY = typeof bookmark.scrollY === "number" ? bookmark.scrollY : 0;
      window.scrollTo({ top: targetY, behavior: "smooth" });
    };

    const bannerReturnBtn = document.getElementById("banner-return-btn");
    if (bannerReturnBtn && currentBookmark) {
      bannerReturnBtn.addEventListener("click", () => scrollToBookmark(currentBookmark));
    }

    const dockSaveBtn = document.getElementById("dock-save-btn");
    const dockReturnBtn = document.getElementById("dock-return-btn");
    const dockToast = document.getElementById("dock-toast");
    const dockTopBtn = document.getElementById("dock-top-btn");

    if (dockTopBtn) {
      dockTopBtn.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    }

    if (dockReturnBtn) {
      dockReturnBtn.addEventListener("click", () => {
        const bookmark = getReadingBookmark(activeMaterial.id);
        if (bookmark) scrollToBookmark(bookmark);
      });
    }

    if (dockSaveBtn) {
      dockSaveBtn.addEventListener("click", () => {
        const saved = saveReadingBookmark(activeMaterial, data.subject);
        if (dockToast) {
          dockToast.textContent = `✓ Gravado em ${saved.percentage}% (${saved.savedAtFormatted})`;
          dockToast.hidden = false;
          setTimeout(() => {
            if (dockToast) dockToast.hidden = true;
          }, 4500);
        }
        if (dockReturnBtn) {
          dockReturnBtn.classList.remove("hidden");
          dockReturnBtn.title = `Voltar ao ponto gravado (${saved.percentage}% - ${saved.savedAtFormatted})`;
          const textSpan = dockReturnBtn.querySelector(".btn-text");
          if (textSpan) textSpan.textContent = `Voltar (${saved.percentage}%)`;
        }

        const existingBanner = document.getElementById("reader-bookmark-banner");
        if (!existingBanner) {
          const banner = document.createElement("div");
          banner.className = "reader-bookmark-banner";
          banner.id = "reader-bookmark-banner";
          banner.innerHTML = `
            <div class="reader-bookmark-banner-info">
              <span class="bookmark-icon">📍</span>
              <span>Ponto gravado neste material: <strong>${saved.percentage}% lido</strong> <small>(${escapeHtml(saved.savedAtFormatted)})</small></span>
            </div>
            <button class="button bookmark-return-btn" id="banner-return-btn" type="button">Voltar para onde parei →</button>
          `;
          const readerHead = view.querySelector(".reader-head");
          if (readerHead) {
            readerHead.insertAdjacentElement("afterend", banner);
            banner.querySelector("#banner-return-btn")?.addEventListener("click", () => scrollToBookmark(saved));
          }
        } else {
          existingBanner.innerHTML = `
            <div class="reader-bookmark-banner-info">
              <span class="bookmark-icon">📍</span>
              <span>Ponto gravado neste material: <strong>${saved.percentage}% lido</strong> <small>(${escapeHtml(saved.savedAtFormatted)})</small></span>
            </div>
            <button class="button bookmark-return-btn" id="banner-return-btn" type="button">Voltar para onde parei →</button>
          `;
          existingBanner.querySelector("#banner-return-btn")?.addEventListener("click", () => scrollToBookmark(saved));
        }
      });
    }

    const goToLastBookmarkBtn = document.getElementById("go-to-last-bookmark-btn");
    if (goToLastBookmarkBtn && lastGlobalBookmark) {
      goToLastBookmarkBtn.addEventListener("click", async () => {
        if (lastGlobalBookmark.subjectId !== data.subject.id) {
          state.activeMaterialId = lastGlobalBookmark.materialId;
          await setSubject(lastGlobalBookmark.subjectId);
        } else {
          state.activeMaterialId = lastGlobalBookmark.materialId;
          await renderContents();
        }
        setTimeout(() => {
          window.scrollTo({ top: lastGlobalBookmark.scrollY, behavior: "smooth" });
        }, 150);
      });
    }
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
    const attempts = getAttempts();
    const isAnswered = (questionId) => attempts.some((item) => item.questionId === questionId);

    const allSubjectQuestions = data.materials.flatMap((material) => material.questions.map((question) => ({
      ...question,
      materialTitle: material.title,
      materialId: material.id,
      subjectId: data.subject.id,
      subjectName: data.subject.name,
    })));

    let materialQuestions = allSubjectQuestions;
    if (state.questionMaterialId && state.questionMaterialId !== "all") {
      materialQuestions = allSubjectQuestions.filter((q) => q.materialId === state.questionMaterialId);
      if (!materialQuestions.length && allSubjectQuestions.length) {
        state.questionMaterialId = "all";
        materialQuestions = allSubjectQuestions;
      }
    }

    const totalInMaterial = materialQuestions.length;
    const unansweredInMaterial = materialQuestions.filter((q) => !isAnswered(q.id)).length;
    const answeredInMaterial = materialQuestions.filter((q) => isAnswered(q.id)).length;

    let filteredQuestions = materialQuestions;
    if (state.questionStatusFilter === "unanswered") {
      filteredQuestions = materialQuestions.filter((q) => !isAnswered(q.id));
    } else if (state.questionStatusFilter === "answered") {
      filteredQuestions = materialQuestions.filter((q) => isAnswered(q.id));
    }

    const questionById = new Map(filteredQuestions.map((question) => [question.id, question]));
    const questions = state.randomQuestionIds
      ? state.randomQuestionIds.map((questionId) => questionById.get(questionId)).filter(Boolean)
      : filteredQuestions;

    if (state.randomQuestionIds && state.questionIndex >= questions.length) {
      view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">PRÁTICA INTELIGENTE</p><h1>Questões aleatórias</h1><p class="page-subtitle">${escapeHtml(data.subject.name)} · sessão concluída</p></div></div>${questionModeSwitcher()}<article class="card random-complete"><span class="random-complete-icon">✓</span><h2>Você concluiu o conjunto aleatório!</h2><p>Foram respondidas ${state.randomAnsweredIds.size} de ${questions.length} questões desta sessão.</p><div class="random-complete-actions"><button class="button" id="restart-random-questions">Novo conjunto aleatório</button><button class="button secondary" id="exit-random-questions">Voltar à lista normal</button></div></article>`;
      bindQuestionModeSwitcher();
      document.getElementById("restart-random-questions").addEventListener("click", () => {
        state.randomQuestionIds = shuffleQuestions(filteredQuestions.filter((question) => question.answer && question.options.length >= 2)).map((question) => question.id);
        state.randomAnsweredIds = new Set();
        state.questionIndex = 0;
        state.selectedAnswer = null;
        renderQuestions();
      });
      document.getElementById("exit-random-questions").addEventListener("click", () => {
        state.randomQuestionIds = null;
        state.randomAnsweredIds = new Set();
        state.questionIndex = 0;
        state.selectedAnswer = null;
        renderQuestions();
      });
      return;
    }

    if (!questions.length) {
      view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">PRÁTICA INTELIGENTE</p><h1>Questões</h1><p class="page-subtitle">${escapeHtml(data.subject.name)}</p></div></div>
        ${questionModeSwitcher()}
        <div class="study-toolbar">
          <select class="select-control" id="question-subject" aria-label="Selecionar disciplina">${state.manifest.subjects.map((subject) => `<option value="${subject.id}" ${subject.id === data.subject.id ? "selected" : ""}>${escapeHtml(subject.name)}</option>`).join("")}</select>
          <select class="select-control" id="question-material" aria-label="Filtrar por material">
            <option value="all" ${state.questionMaterialId === "all" ? "selected" : ""}>Todos os materiais (${allSubjectQuestions.length})</option>
            ${data.materials.map((m) => `<option value="${m.id}" ${m.id === state.questionMaterialId ? "selected" : ""}>${escapeHtml(m.title)} (${m.questions.length})</option>`).join("")}
          </select>
          <select class="select-control" id="question-status-filter" aria-label="Filtrar por status">
            <option value="all" ${state.questionStatusFilter === "all" ? "selected" : ""}>Todas as questões (${totalInMaterial})</option>
            <option value="unanswered" ${state.questionStatusFilter === "unanswered" ? "selected" : ""}>Não respondidas ainda (${unansweredInMaterial})</option>
            <option value="answered" ${state.questionStatusFilter === "answered" ? "selected" : ""}>Já respondidas (${answeredInMaterial})</option>
          </select>
        </div>
        <article class="card empty-state">
          <h3>Nenhuma questão encontrada com os filtros selecionados</h3>
          <p>${state.questionStatusFilter === "unanswered" ? "Parabéns! Todas as questões deste filtro já foram respondidas." : "Não encontramos questões para os critérios selecionados."}</p>
          <div class="empty-state-actions">
            <button class="button secondary" id="reset-question-filter" type="button">Limpar filtros e ver todas as questões</button>
          </div>
        </article>`;
      bindQuestionModeSwitcher();
      document.getElementById("question-subject").addEventListener("change", (event) => {
        state.questionMaterialId = "all";
        state.selectedAnswer = null;
        setSubject(event.target.value);
      });
      document.getElementById("question-material").addEventListener("change", (event) => {
        state.questionMaterialId = event.target.value;
        state.questionIndex = 0;
        state.selectedAnswer = null;
        renderQuestions();
      });
      document.getElementById("question-status-filter").addEventListener("change", (event) => {
        state.questionStatusFilter = event.target.value;
        state.questionIndex = 0;
        state.selectedAnswer = null;
        renderQuestions();
      });
      document.getElementById("reset-question-filter").addEventListener("click", () => {
        state.questionMaterialId = "all";
        state.questionStatusFilter = "all";
        state.questionIndex = 0;
        state.selectedAnswer = null;
        renderQuestions();
      });
      return;
    }

    state.questionIndex = Math.max(0, Math.min(state.questionIndex, questions.length - 1));
    const question = questions[state.questionIndex];
    const isSpacedReview = state.reviewQuestionId === question.id;
    const isRandomMode = Boolean(state.randomQuestionIds);
    const prior = [...attempts].reverse().find((item) => item.questionId === question.id);
    const currentAttempt = isRandomMode && !state.randomAnsweredIds.has(question.id) ? null : prior;
    if (!prior || isSpacedReview || (isRandomMode && !state.randomAnsweredIds.has(question.id))) {
      startQuestionTimer(question.id, "practice");
    }
    const answerKey = question.answer;
    const isRevealed = Boolean(currentAttempt);
    const selected = isRevealed ? currentAttempt.selected : (state.selectedAnswer || null);
    const keyLabel = answerKey || "";

    view.innerHTML = `<div class="page-heading"><div><p class="eyebrow">PRÁTICA INTELIGENTE</p><h1>Questões</h1><p class="page-subtitle">Resolva, selecione uma alternativa, confirme sua resposta e confira a resolução comentada.</p></div></div>
      ${questionModeSwitcher()}
      <div class="study-toolbar">
        <select class="select-control" id="question-subject" aria-label="Selecionar disciplina">
          ${state.manifest.subjects.map((subject) => `<option value="${subject.id}" ${subject.id === data.subject.id ? "selected" : ""}>${escapeHtml(subject.name)}</option>`).join("")}
        </select>
        <select class="select-control" id="question-material" aria-label="Filtrar por material">
          <option value="all" ${state.questionMaterialId === "all" ? "selected" : ""}>Todos os materiais (${allSubjectQuestions.length})</option>
          ${data.materials.map((m) => `<option value="${m.id}" ${m.id === state.questionMaterialId ? "selected" : ""}>${escapeHtml(m.title)} (${m.questions.length})</option>`).join("")}
        </select>
        <select class="select-control" id="question-status-filter" aria-label="Filtrar por status">
          <option value="all" ${state.questionStatusFilter === "all" ? "selected" : ""}>Todas as questões (${totalInMaterial})</option>
          <option value="unanswered" ${state.questionStatusFilter === "unanswered" ? "selected" : ""}>Não respondidas ainda (${unansweredInMaterial})</option>
          <option value="answered" ${state.questionStatusFilter === "answered" ? "selected" : ""}>Já respondidas (${answeredInMaterial})</option>
        </select>
        <span class="period-pill">
          ${state.questionIndex + 1} de ${questions.length} ${isRandomMode ? "no conjunto aleatório" : (state.questionStatusFilter === "unanswered" ? "não respondidas" : "neste filtro")}
        </span>
        <button class="button ${isRandomMode ? "random-mode-active" : "secondary"}" id="random-question-mode" type="button" aria-pressed="${isRandomMode}" title="Embaralha questões com alternativas e gabarito deste filtro; respostas anteriores podem ser refeitas.">
          ${isRandomMode ? "Sair do modo aleatório" : "Embaralhar questões"}
        </button>
      </div>
      <div class="question-layout">
        <article class="card question-card">
          <div class="question-meta">
            <span class="question-tag">${escapeHtml(question.number)}</span>
            <span>${escapeHtml(question.materialTitle)}</span>
          </div>
          <div class="markdown-body">${renderMarkdown(question.statement)}</div>
          <div class="option-list">${renderOptionRows(question, { selected, answerKey, revealed: isRevealed && !isRandomMode, canAnswer: !isRevealed || isSpacedReview || isRandomMode })}</div>
          ${(!isRevealed || isSpacedReview || (isRandomMode && !state.randomAnsweredIds.has(question.id))) ? `
            <div class="confirm-answer-row">
              <button class="button confirm-answer-btn" id="confirm-answer-btn" ${state.selectedAnswer ? "" : "disabled"} type="button">
                ✓ Confirmar resposta
              </button>
              <span class="confirm-hint" id="confirm-hint">
                ${state.selectedAnswer ? `Alternativa (${escapeHtml(state.selectedAnswer)}) selecionada · Clique em "Confirmar resposta"` : "Escolha uma alternativa acima e confirme"}
              </span>
            </div>
          ` : ""}
          ${isSpacedReview ? '<div class="feedback neutral">Revisão espaçada: selecione uma alternativa e confirme para programar o próximo intervalo.</div>' : ""}
          ${isRevealed && (!isSpacedReview || isRandomMode) ? `<div class="feedback ${answerKey ? (selected === answerKey ? "success" : "error") : "neutral"}">${answerKey ? (selected === answerKey ? "Resposta correta! Muito bem." : `Não foi dessa vez. O gabarito é ${escapeHtml(keyLabel)}.`) : "Não foi possível identificar um gabarito nesta questão. Consulte a resolução e a fonte original."}</div>${question.solution ? `<div class="solution-box"><h3>Resolução comentada</h3><div class="markdown-body">${renderMarkdown(question.solution)}</div></div>` : ""}` : ""}
          ${question.options.length ? "" : '<div class="feedback neutral">As alternativas não foram identificadas automaticamente neste material.</div>'}
          <div class="question-actions">
            <button class="button secondary" id="previous-question" ${state.questionIndex === 0 ? "disabled" : ""}>← Anterior</button>
            <button class="button" id="next-question" ${!isRandomMode && state.questionIndex >= questions.length - 1 ? "disabled" : ""}>${state.questionIndex >= questions.length - 1 ? (isRandomMode ? "Concluir sessão" : "Próxima questão →") : "Próxima questão →"}</button>
          </div>
        </article>
        <aside class="card question-side">
          <h3>Seu ritmo nesta disciplina</h3>
          <div class="side-stat"><span>Respondidas</span><strong>${attempts.filter((item) => item.subjectId === data.subject.id).length}</strong></div>
          <div class="side-stat"><span>Taxa de acerto</span><strong>${subjectAccuracy(attempts, data.subject.id)}%</strong></div>
          <div class="tip-box"><strong>Dica de estudo</strong><br>Leia a resolução mesmo quando acertar. Entender o raciocínio ajuda a fixar o conteúdo.</div>
        </aside>
      </div>`;

    bindQuestionModeSwitcher();
    bindRandomQuestionMode(filteredQuestions);
    bindEliminationControls(question.id);
    document.getElementById("question-subject").addEventListener("change", (event) => {
      state.questionMaterialId = "all";
      state.selectedAnswer = null;
      setSubject(event.target.value);
    });
    document.getElementById("question-material").addEventListener("change", (event) => {
      state.questionMaterialId = event.target.value;
      state.questionIndex = 0;
      state.selectedAnswer = null;
      renderQuestions();
    });
    document.getElementById("question-status-filter").addEventListener("change", (event) => {
      state.questionStatusFilter = event.target.value;
      state.questionIndex = 0;
      state.selectedAnswer = null;
      renderQuestions();
    });

    view.querySelectorAll("[data-answer]").forEach((button) => button.addEventListener("click", () => {
      if (isRevealed && !isSpacedReview && (!isRandomMode || state.randomAnsweredIds.has(question.id))) return;
      const chosen = button.dataset.answer;
      state.selectedAnswer = chosen;
      view.querySelectorAll("[data-answer]").forEach((btn) => {
        btn.classList.toggle("selected", btn.dataset.answer === chosen);
      });
      const confirmBtn = document.getElementById("confirm-answer-btn");
      if (confirmBtn) {
        confirmBtn.disabled = false;
      }
      const hint = document.getElementById("confirm-hint");
      if (hint) {
        hint.textContent = `Alternativa (${chosen}) selecionada · Clique em "Confirmar resposta"`;
      }
    }));

    const confirmBtn = document.getElementById("confirm-answer-btn");
    if (confirmBtn) {
      confirmBtn.addEventListener("click", () => {
        const chosen = state.selectedAnswer;
        if (!chosen) {
          showNotice("Selecione uma alternativa antes de confirmar.");
          return;
        }
        state.selectedAnswer = null;
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
      });
    }

    document.getElementById("previous-question").addEventListener("click", () => {
      stopQuestionTimer(question.id, "practice");
      state.reviewQuestionId = null;
      state.selectedAnswer = null;
      state.questionIndex -= 1;
      renderQuestions();
    });
    document.getElementById("next-question").addEventListener("click", () => {
      if (!isRandomMode && state.questionIndex >= questions.length - 1) return;
      stopQuestionTimer(question.id, "practice");
      state.reviewQuestionId = null;
      state.selectedAnswer = null;
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
  showNotice("Os materiais são carregados do armazenamento privado somente depois que sua conta é autenticada. Seu histórico também é sincronizado com sua conta Supabase.");
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

async function loadStudyMaterials() {
  if (!state.supabase || !state.authUser || !state.cloudReady) return;
  if (state.manifest) return;
  if (state.materialsLoadPromise) return state.materialsLoadPromise;
  state.authError = null;
  const loadPromise = (async () => {
    try {
      state.manifest = await loadPrivateJson("manifest.json");
      state.subjectId = state.manifest.subjects[0]?.id || null;
      buildNavigation();
      updateAccountUi();
      renderDashboard();
    } catch (error) {
      console.error("Não foi possível carregar os materiais privados.", error);
      state.authError = `Não foi possível carregar os materiais privados: ${error.message}`;
      updateAccountUi();
    }
  })();
  state.materialsLoadPromise = loadPromise;
  try {
    await loadPromise;
  } finally {
    if (state.materialsLoadPromise === loadPromise) state.materialsLoadPromise = null;
  }
}

const THEME_STORAGE_KEY = "trilha-theme-mode";
let themeInitialized = false;

function toggleTheme() {
  const current = (document.documentElement.getAttribute("data-theme") || "light") === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
}

function initTheme() {
  let theme = "light";
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    theme = saved === "dark" || saved === "light" ? saved : (prefersDark ? "dark" : "light");
  } catch (e) {
    console.warn("Could not read theme storage:", e);
  }
  applyTheme(theme);

  if (themeInitialized) return;
  themeInitialized = true;

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("#theme-toggle, #sidebar-theme-toggle, #auth-theme-toggle, [data-action='toggle-theme']");
    if (trigger) {
      event.preventDefault();
      event.stopPropagation();
      toggleTheme();
    }
  });

  if (window.matchMedia) {
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
        if (!localStorage.getItem(THEME_STORAGE_KEY)) {
          applyTheme(e.matches ? "dark" : "light");
        }
      });
    } catch (e) {}
  }
}

function applyTheme(theme) {
  const targetTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", targetTheme);
  document.documentElement.classList.toggle("dark-mode", targetTheme === "dark");
  if (document.body) {
    document.body.setAttribute("data-theme", targetTheme);
    document.body.classList.toggle("dark-mode", targetTheme === "dark");
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, targetTheme);
  } catch (e) {}

  const isDark = targetTheme === "dark";
  const icon = isDark ? "☀️" : "🌙";
  const title = isDark ? "Mudar para modo claro" : "Mudar para modo escuro";

  document.querySelectorAll(".theme-icon, #theme-icon, .sidebar-theme-icon, .auth-theme-icon").forEach((el) => {
    el.textContent = icon;
  });

  const buttons = document.querySelectorAll("#theme-toggle, #sidebar-theme-toggle, #auth-theme-toggle, [data-action='toggle-theme']");
  buttons.forEach((btn) => {
    btn.title = title;
    btn.setAttribute("aria-label", title);
  });

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute("content", isDark ? "#090d16" : "#f8fafc");
  }
}

initTheme();

async function start() {
  try {
    await initializeAuth();
    await loadStudyMaterials();
    updateAccountUi();
  } catch (error) {
    console.error(error);
    state.authError = `Não foi possível carregar os materiais privados: ${error.message}`;
    updateAccountUi();
  }
}

start();
