// ===== НАСТРОЙКИ =====
const CONFIG = {
  BASE_URL: "https://gen.pollinations.ai/v1",
  API_KEYS: [
    "sk_LLmFpl6Wy5gz9Z01Z7e0quIDaU9Z6eCM",
    "sk_kBkQGItVNKT2iP9R3gjybMpzRb5xfmOF",
  ],
};
// Модели, которые проверены тестом и отвечают. Они добавляются к списку из API.
const EXTRA_MODELS = [
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-fable-5.2",
  "anthropic/claude-haiku-5.5",
  "openai/gpt-6.2-astra",
  "openai/gpt-6.2-sol",
  "openai/gpt-6.1-terra",
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "google/gemini-4-neon",
  "google/gemini-4-hydrogen",
  "google/gemini-4-carbon",
  "google/gemini-3.1-pro-preview",
  "qwen/qwen4-max",
];
// Модели, которые генерируют картинки (определяются по имени)
const IMAGE_MODEL_RE = /image|flux|midjourney|seedream|turbo|imagen|dall|sdxl|stable-diffusion/i;

const MAX_TEXT_FILE = 200 * 1024; // 200 KB
const STORE_KEY = "redsba_chat_v1";
const TEXT_EXT = /\.(txt|md|csv|json|js|ts|py|html|css|xml|log|java|c|cpp|go|rs|php|sql|yaml|yml)$/i;
const CHECK_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12l5 5 9-10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const FILE_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z M14 3v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
const IMAGE_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M21 16l-5-5-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ===== Запросы с перебором ключей =====
// Если ключ не подошёл (нет баланса, 401/403/429), пробуем следующий.
async function apiFetch(path, init = {}) {
  let last = null;
  for (const key of CONFIG.API_KEYS) {
    const res = await fetch(`${CONFIG.BASE_URL}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${key}` },
    });
    if (res.ok) return res;
    last = res;
    const body = await res.clone().text();
    const retry = [401, 402, 403, 429].includes(res.status) || body.includes("credits");
    if (!retry) return res;
  }
  return last;
}

// Инструкция модели: как создавать файлы
const SYSTEM_PROMPT = `Ты помощник сайта redSBA ai. Если пользователь просит создать файл, код или документ для сохранения, оформи его так: <file name="имя.расширение">содержимое файла</file>. Можно создавать несколько файлов. Всё, что вне тегов <file>, — обычный ответ пользователю.`;

// Достаёт из ответа блоки <file name="...">...</file>
function parseFiles(raw) {
  const files = [];
  const text = raw
    .replace(/<file name="([^"]+)">([\s\S]*?)<\/file>/g, (_, name, content) => {
      files.push({ name, content: content.replace(/^\n/, "").replace(/\n$/, "") });
      return "";
    })
    .trim();
  return { text, files };
}

function formatSize(bytes) {
  return bytes < 1024 ? `${bytes} Б` : `${(bytes / 1024).toFixed(1)} КБ`;
}

function saveText(name, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Карточка файла с кнопкой скачивания
function buildFileCard(f) {
  const card = document.createElement("div");
  card.className = "file-card";
  card.innerHTML = `${FILE_ICON}<div class="file-meta"><span class="file-name"></span><span class="file-size"></span></div><button class="ghost-btn" title="Скачать">${DOWNLOAD_ICON}</button>`;
  card.querySelector(".file-name").textContent = f.name;
  card.querySelector(".file-size").textContent = formatSize(new Blob([f.content]).size);
  card.querySelector("button").addEventListener("click", () => saveText(f.name, f.content));
  return card;
}

// ===== Элементы =====
const $ = (id) => document.getElementById(id);
const modelBtn = $("modelBtn");
const modelName = $("modelName");
const modelPanel = $("modelPanel");
const modelWrap = document.querySelector(".model-wrap");
const input = $("input");
const sendBtn = $("sendBtn");
const clearBtn = $("clearBtn");
const fileInput = $("fileInput");
const fileList = $("fileList");
const messagesEl = $("messages");
const hero = $("hero");
const chat = $("chat");

// messages — то, что видно и сохраняется; history — то, что уходит в API для текстовых моделей
let messages = [];    // {role: 'user'|'bot', text, cls, image}
let history = [];     // {role, content}
let attachments = []; // {name, kind, content} — в сохранение не попадают
let busy = false;
let selectedModel = "";

const shortName = (id) => id.split("/").pop();
const isImageModel = (id) => IMAGE_MODEL_RE.test(id || "");

// ===== Сохранение =====
function saveChat() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ messages, history, selectedModel }));
  } catch (e) {
    console.error("Не удалось сохранить чат", e);
  }
}

function loadChat() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    messages = (data.messages || []).filter((m) => m.cls !== "typing");
    history = data.history || [];
    selectedModel = data.selectedModel || "";
    messages.forEach((m) => renderMessage(m));
  } catch (e) {
    console.error("Не удалось прочитать чат", e);
  }
}

clearBtn.addEventListener("click", () => {
  messages = [];
  history = [];
  attachments = [];
  messagesEl.innerHTML = "";
  renderFiles();
  hero.classList.remove("hidden");
  saveChat();
});

// ===== Модели =====
modelBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  modelWrap.classList.toggle("open");
});
document.addEventListener("click", (e) => {
  if (!modelWrap.contains(e.target)) modelWrap.classList.remove("open");
});

function selectModel(id) {
  selectedModel = id;
  modelName.textContent = shortName(id);
  modelPanel.querySelectorAll(".model-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === id);
  });
  modelWrap.classList.remove("open");
  saveChat();
}

function renderModels(list) {
  modelPanel.innerHTML = `<input type="text" class="model-search" placeholder="Поиск модели..." /><div class="model-list"></div>`;
  const search = modelPanel.querySelector(".model-search");
  const listEl = modelPanel.querySelector(".model-list");
  search.addEventListener("click", (e) => e.stopPropagation());

  const draw = (query) => {
    const q = query.trim().toLowerCase();
    listEl.innerHTML = "";
    list
      .filter((id) => id.toLowerCase().includes(q))
      .forEach((id, i) => {
        const item = document.createElement("div");
        item.className = "model-item" + (id === selectedModel ? " active" : "");
        item.dataset.id = id;
        item.style.setProperty("--i", i);
        item.innerHTML = `<span></span>${CHECK_ICON}`;
        item.querySelector("span").textContent = shortName(id);
        item.addEventListener("click", () => selectModel(id));
        listEl.appendChild(item);
      });
  };
  search.addEventListener("input", () => draw(search.value));
  draw("");
}

async function loadModels() {
  let list = [];
  try {
    const res = await apiFetch("/models", {
      headers: {  },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    list = (data.data || data.models || []).map((m) => m.id || m.name || m);
  } catch (e) {
    console.error(e);
  }
  list = [...new Set([...list, ...EXTRA_MODELS])];
  renderModels(list);
  if (!list.length) {
    modelName.textContent = "Нет моделей";
    return;
  }
  selectModel(list.includes(selectedModel) ? selectedModel : list[0]);
}

// ===== Файлы =====
fileInput.addEventListener("change", async (e) => {
  for (const file of e.target.files) {
    const isImage = file.type.startsWith("image/");
    const isText = TEXT_EXT.test(file.name) || file.type.startsWith("text/");
    let att;
    if (isImage) {
      const dataUrl = await readAs(file, "dataURL");
      att = { name: file.name, kind: "image", content: dataUrl };
    } else if (isText) {
      const text = await readAs(file.slice(0, MAX_TEXT_FILE), "text");
      att = { name: file.name, kind: "text", content: text };
    } else {
      att = { name: file.name, kind: "other", content: "" };
    }
    attachments.push(att);
  }
  fileInput.value = "";
  renderFiles();
});

function readAs(file, mode) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    if (mode === "dataURL") r.readAsDataURL(file);
    else r.readAsText(file);
  });
}

function renderFiles() {
  fileList.innerHTML = "";
  attachments.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    chip.innerHTML = `${a.kind === "image" ? IMAGE_ICON : FILE_ICON}<span></span>`;
    chip.querySelector("span:last-child").textContent = a.name;
    const rm = document.createElement("button");
    rm.textContent = "×";
    rm.onclick = () => {
      attachments.splice(i, 1);
      renderFiles();
    };
    chip.appendChild(rm);
    fileList.appendChild(chip);
  });
}

// ===== Сообщения =====
function renderMessage(m) {
  hero.classList.add("hidden");
  const div = document.createElement("div");
  div.className = `msg ${m.role === "user" ? "user" : "bot"} ${m.cls || ""}`.trim();
  if (m.image) {
    div.classList.add("image-msg");
    div.appendChild(buildImageBlock(m.image, m.text));
  } else {
    div.textContent = m.text;
    (m.files || []).forEach((f) => div.appendChild(buildFileCard(f)));
  }
  messagesEl.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function addMessage(role, text, cls = "") {
  const m = { role, text, cls };
  messages.push(m);
  return { el: renderMessage(m), m };
}

// Блок с картинкой: превью, подпись и кнопка скачивания
function buildImageBlock(url, caption) {
  const wrap = document.createElement("div");
  wrap.className = "img-block";
  const img = document.createElement("img");
  img.src = url;
  img.alt = caption || "Изображение";
  img.loading = "lazy";
  img.addEventListener("click", () => window.open(url, "_blank"));
  const row = document.createElement("div");
  row.className = "img-row";
  const cap = document.createElement("span");
  cap.textContent = caption || "";
  const dl = document.createElement("button");
  dl.className = "ghost-btn";
  dl.title = "Скачать";
  dl.innerHTML = DOWNLOAD_ICON;
  dl.addEventListener("click", () => downloadImage(url));
  row.append(cap, dl);
  wrap.append(img, row);
  return wrap;
}

async function downloadImage(url) {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `redsba-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) {
    window.open(url, "_blank");
  }
}

// Собирает содержимое сообщения пользователя с учётом файлов
function buildUserContent(text, files) {
  const textParts = [];
  const images = [];
  for (const f of files) {
    if (f.kind === "text") {
      textParts.push(`--- Файл: ${f.name} ---\n${f.content}`);
    } else if (f.kind === "image") {
      images.push({ type: "image_url", image_url: { url: f.content } });
    } else {
      textParts.push(`[Прикреплён файл ${f.name}, его содержимое не поддерживается]`);
    }
  }
  const fullText = [text, ...textParts].filter(Boolean).join("\n\n");
  if (!images.length) return fullText;
  return [{ type: "text", text: fullText }, ...images];
}

// ===== Генерация картинок =====
async function generateImage(model, prompt, pending, refs = []) {
  const res = await apiFetch("/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: "1024x1024",
      ...(refs.length ? { image: refs } : {}),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const item = data.data?.[0];
  let url = item?.url;
  if (!url && item?.b64_json) url = `data:image/png;base64,${item.b64_json}`;
  if (!url) throw new Error("Сервер не вернул картинку");

  pending.m.text = prompt;
  pending.m.image = url;
  pending.m.cls = "";
  pending.el.className = "msg bot image-msg";
  pending.el.textContent = "";
  pending.el.appendChild(buildImageBlock(url, prompt));
}

// ===== Отправка =====
async function send() {
  if (busy) return;
  const text = input.value.trim();
  if (!text && !attachments.length) return;
  if (!selectedModel) {
    addMessage("bot", "Сначала выберите модель.", "error");
    saveChat();
    return;
  }

  const imageMode = isImageModel(selectedModel);
  const refs = attachments.filter((a) => a.kind === "image").map((a) => a.content);
  const content = buildUserContent(text, attachments);
  const shown = text + (attachments.length ? `\n📎 ${attachments.map((a) => a.name).join(", ")}` : "");
  addMessage("user", shown);
  if (!imageMode) history.push({ role: "user", content });

  input.value = "";
  input.style.height = "auto";
  attachments = [];
  renderFiles();

  busy = true;
  sendBtn.disabled = true;
  const pending = addMessage("bot", imageMode ? "Генерирую картинку..." : "Думаю...", "typing");
  saveChat();

  try {
    if (imageMode) {
      if (!text) throw new Error("Опишите, какую картинку создать");
      await generateImage(selectedModel, text, pending, refs);
    } else {
      const res = await apiFetch("/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: selectedModel, messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const answer = data.choices?.[0]?.message?.content ?? "(пустой ответ)";
      history.push({ role: "assistant", content: answer });
      const { text: cleaned, files } = parseFiles(answer);
      pending.m.text = cleaned;
      pending.m.files = files;
      pending.m.cls = "";
      pending.el.textContent = cleaned;
      pending.el.classList.remove("typing");
      files.forEach((f) => pending.el.appendChild(buildFileCard(f)));
    }
  } catch (e) {
    pending.m.text = `Ошибка: ${e.message}`;
    pending.m.cls = "error";
    pending.el.className = "msg bot error";
    pending.el.textContent = pending.m.text;
    if (!imageMode) history.pop();
  } finally {
    busy = false;
    sendBtn.disabled = false;
    saveChat();
  }
}

sendBtn.addEventListener("click", send);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});

loadChat();
loadModels();
