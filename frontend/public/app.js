const API_BASE = "/api";
const TERMINAL = new Set(["sold", "publish_dispatch_failed"]);
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

let pollId = 0, inFlight = false, hadFirstLoad = false, pollHandle = 0;
let selectionMode = false;
const selectedIds = new Set();
const sessionPhotos = new Map(); // listingId → objectURL (session only)

// ── Toast ──────────────────────────────────────────────────────────────────

function toast(msg, type = "info", ms = 4500) {
  const icons = { ok: "✅", err: "❌", info: "ℹ️", warn: "⚠️" };
  const c = document.getElementById("toast-container");
  if (!c) return;
  const t = document.createElement("div");
  t.className = `toast toast--${type}`;
  t.innerHTML = `<span class="toast__icon">${icons[type] ?? "ℹ️"}</span><span>${escapeHtml(msg)}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.classList.add("is-leaving"); t.addEventListener("animationend", () => t.remove(), { once: true }); }, ms);
}

// ── Utilities ──────────────────────────────────────────────────────────────

function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function money(cents) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function attrEscape(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }

function relTime(iso) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000, abs = Math.abs(s);
  if (abs < 45) return rtf.format(Math.round(s), "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

function safeImageUrl(u) {
  if (!u) return null;
  try { const x = new URL(String(u).trim()); return (x.protocol === "http:" || x.protocol === "https:") ? x.href : null; } catch { return null; }
}

function newIdem() { return globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

// ── API ────────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) { const err = new Error(json?.error || res.statusText); err.details = json; err.status = res.status; throw err; }
  return json;
}

// ── Stats ──────────────────────────────────────────────────────────────────

function updateStats(listings) {
  const total = listings.length;
  const publishing = listings.filter(l => l.status === "pending_publish" || l.status === "publishing").length;
  const live = listings.filter(l => l.status === "live").length;
  const sold = listings.filter(l => l.status === "sold");
  const revenue = sold.reduce((s, l) => s + (l.priceCents || 0), 0);
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set("stat-total", total);
  set("stat-publishing", publishing);
  set("stat-live", live);
  set("stat-revenue", sold.length ? money(revenue) : "$0");
  const sub = document.getElementById("feed-sub");
  if (sub) sub.textContent = !total ? "No listings yet — create your first one."
    : publishing > 0 ? `${publishing} in-flight · live updates on…`
    : `${total} listing${total !== 1 ? "s" : ""} · ${sold.length} sold`;
}

// ── Connection ─────────────────────────────────────────────────────────────

function setConnectionState(mode) {
  const pill = document.getElementById("connection-pill");
  const label = document.getElementById("connection-label");
  if (!pill || !label) return;
  pill.classList.remove("is-live", "is-loading");
  if (mode === "live") { pill.classList.add("is-live"); label.textContent = "Live"; }
  else if (mode === "loading") { pill.classList.add("is-loading"); label.textContent = "Loading…"; }
  else label.textContent = "Up to date";
}

// ── Pipeline ───────────────────────────────────────────────────────────────

function pipelineNode(status, acts) {
  const soldEv = acts?.some(a => a.type === "item_sold");
  const cmt = acts?.some(a => a.type === "new_comment");
  const step = (lbl, cls) => `<span class="pipeline__step ${cls}"><span class="pipeline__dot"></span>${lbl}</span>`;
  const line = (cls = "") => `<span class="pipeline__line ${cls}"></span>`;
  if (status === "publish_dispatch_failed")
    return `<div class="pipeline">${step("Submit","is-err")}${line("is-err")}${step("Failed","is-err")}</div>`;
  if (status === "sold" || soldEv)
    return `<div class="pipeline">${step("Submit","is-done")}${line("is-done")}${step("Live","is-done")}${line("is-done")}${step("Sold","is-done")}</div>`;
  if (status === "live" || cmt)
    return `<div class="pipeline">${step("Submit","is-done")}${line("is-done")}${step("Live","is-done")}${line()}${step("Sold","")}</div>`;
  if (status === "publishing" || status === "pending_publish")
    return `<div class="pipeline">${step("Submit","is-done")}${line("is-wait")}${step("Live","is-wait")}${line()}${step("Sold","")}</div>`;
  return "";
}

// ── Listing card ───────────────────────────────────────────────────────────

function renderCard(l) {
  const acts = (l.recentActivity || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const imgHref = safeImageUrl(l.photoUrl) ?? sessionPhotos.get(l.listingId) ?? null;
  const statusLabel = l.status.replace(/_/g, " ");
  const badgeCls = `badge badge--${l.status.replace(/[^a-z0-9_]/gi, "_")}`;
  const selCls = selectionMode ? " selection-mode" : "";
  const selChecked = selectedIds.has(l.listingId) ? "checked" : "";

  const mediaHtml = imgHref
    ? `<img class="listing-card__img" src="${attrEscape(imgHref)}" alt="" loading="lazy" title="Click to enlarge" />`
    : `<div class="listing-card__img-ph" aria-hidden="true"><span style="font-size:1.8rem">📷</span></div>`;

  let actHtml = "";
  if (acts.length) {
    actHtml = acts.map(a => {
      const isCmt = a.type === "new_comment", isSold = a.type === "item_sold";
      const icon = isCmt ? "💬" : isSold ? "💰" : "📋";
      const iconCls = isCmt ? "activity-item__icon--comment" : isSold ? "activity-item__icon--sold" : "activity-item__icon--other";
      const title = isCmt ? "New comment" : isSold ? "Item sold" : escapeHtml(a.type);
      const detail = isCmt
        ? `<span class="activity-item__detail">${escapeHtml(String(a.payload?.comment || ""))}</span>`
        : isSold ? `<span class="activity-item__detail">ID: <code>${escapeHtml(String(a.payload?.marketplaceListingId || "—"))}</code></span>` : "";
      return `<li class="activity-item">
        <span class="activity-item__icon ${iconCls}">${icon}</span>
        <span class="activity-item__title">${title}</span>
        <span class="activity-item__time" title="${escapeHtml(a.createdAt)}">${relTime(a.createdAt)}</span>
        ${detail}
      </li>`;
    }).join("");
    actHtml = `<div class="listing-card__activity"><ol class="activity-list">${actHtml}</ol></div>`;
  } else {
    actHtml = `<div class="listing-card__activity"><p class="activity-empty">Waiting for webhooks from mock eBay…</p></div>`;
  }

  const card = el(`<article class="listing-card${selCls}" data-listing-id="${attrEscape(l.listingId)}" style="position:relative">
    <input type="checkbox" class="listing-card__check" aria-label="Select listing" ${selChecked} style="position:absolute;top:.5rem;left:.5rem;z-index:2;display:${selectionMode ? "block" : "none"};width:18px;height:18px;accent-color:var(--accent);cursor:pointer;" />
    <button class="listing-card__delete" aria-label="Delete listing" title="Delete this listing">🗑</button>
    <div class="listing-card__top">
      <div class="listing-card__media">${mediaHtml}</div>
      <div class="listing-card__body">
        <div class="listing-card__header">
          <h3 class="listing-card__title">${escapeHtml(l.title)}</h3>
          <span class="${badgeCls}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="listing-card__meta">
          <span class="listing-card__price">${money(l.priceCents)}</span>
          <span class="channel-tag channel-tag--ebay">🏪 mock eBay</span>
        </div>
        ${pipelineNode(l.status, acts)}
        <p class="listing-card__desc">${escapeHtml((l.description || "").slice(0, 160))}${(l.description || "").length > 160 ? "…" : ""}</p>
      </div>
    </div>
    ${actHtml}
  </article>`);

  // Lightbox on image click
  const img = card.querySelector("img.listing-card__img");
  if (img) {
    img.addEventListener("error", () => {
      const ph = document.createElement("div");
      ph.className = "listing-card__img-ph";
      ph.setAttribute("aria-hidden", "true");
      ph.innerHTML = `<span style="font-size:1.8rem">📷</span>`;
      img.replaceWith(ph);
    });
    img.addEventListener("click", () => openLightbox(img.src));
  }

  // Delete button
  card.querySelector(".listing-card__delete")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${l.title}"?`)) return;
    await doDeleteListing(l.listingId);
  });

  // Checkbox selection
  const chk = card.querySelector(".listing-card__check");
  chk?.addEventListener("change", () => {
    if (chk.checked) selectedIds.add(l.listingId);
    else selectedIds.delete(l.listingId);
    card.classList.toggle("is-selected", chk.checked);
    updateSelectionUI();
  });
  if (selectedIds.has(l.listingId)) card.classList.add("is-selected");

  return card;
}

// ── Lightbox ───────────────────────────────────────────────────────────────

function openLightbox(src) {
  const lb = document.getElementById("lightbox");
  const img = document.getElementById("lightbox-img");
  if (!lb || !img) return;
  img.src = src;
  lb.removeAttribute("hidden");
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  const lb = document.getElementById("lightbox");
  if (!lb) return;
  lb.setAttribute("hidden", "");
  document.body.style.overflow = "";
}

document.getElementById("lightbox-close")?.addEventListener("click", closeLightbox);
document.getElementById("lightbox")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeLightbox(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });

// ── Delete helpers ──────────────────────────────────────────────────────────

async function doDeleteListing(listingId) {
  try {
    await api(`/listings/${listingId}`, { method: "DELETE" });
    selectedIds.delete(listingId);
    await refreshListings();
    toast("Listing deleted.", "ok", 2500);
  } catch (e) {
    toast(`Delete failed: ${e.message}`, "err");
  }
}

// ── Selection mode ──────────────────────────────────────────────────────────

function enterSelectionMode() {
  selectionMode = true;
  document.getElementById("selection-toolbar")?.removeAttribute("hidden");
  document.getElementById("normal-controls")?.setAttribute("hidden", "");
  renderListings(lastData);
}

function exitSelectionMode() {
  selectionMode = false;
  selectedIds.clear();
  document.getElementById("selection-toolbar")?.setAttribute("hidden", "");
  document.getElementById("normal-controls")?.removeAttribute("hidden");
  updateSelectionUI();
  renderListings(lastData);
}

function updateSelectionUI() {
  const n = selectedIds.size;
  const countEl = document.getElementById("selection-count");
  const delBtn = document.getElementById("delete-selected-btn");
  if (countEl) countEl.textContent = `${n} selected`;
  if (delBtn) delBtn.disabled = n === 0;
}

document.getElementById("select-mode-btn")?.addEventListener("click", enterSelectionMode);
document.getElementById("cancel-selection-btn")?.addEventListener("click", exitSelectionMode);

document.getElementById("delete-selected-btn")?.addEventListener("click", async () => {
  const ids = [...selectedIds];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} listing${ids.length !== 1 ? "s" : ""}?`)) return;
  try {
    await api("/listings/batch-delete", { method: "POST", body: JSON.stringify({ listingIds: ids }) });
    selectedIds.clear();
    exitSelectionMode();
    toast(`${ids.length} listing${ids.length !== 1 ? "s" : ""} deleted.`, "ok");
  } catch (e) {
    toast(`Batch delete failed: ${e.message}`, "err");
  }
});

// ── Render listings ─────────────────────────────────────────────────────────

let lastData = { listings: [] };

function renderListings(data) {
  lastData = data;
  const root = document.getElementById("listings-root");
  updateStats(data.listings ?? []);
  if (!data.listings?.length) {
    root.replaceChildren(el(`<div class="empty-state">
      <span class="empty-state__icon">🛍️</span>
      <p class="empty-state__title">No listings yet</p>
      <p class="empty-state__sub">Create one on the left — manual, AI single item, or bulk from one photo.</p>
    </div>`));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const l of data.listings) frag.appendChild(renderCard(l));
  root.replaceChildren(frag);
}

// ── Refresh / polling ───────────────────────────────────────────────────────

function needsLivePoll(listings) { return !!listings?.some(l => !TERMINAL.has(l.status)); }

async function refreshListings({ quiet } = {}) {
  if (inFlight) return;
  inFlight = true;
  const root = document.getElementById("listings-root");
  if (!hadFirstLoad && !quiet) setConnectionState("loading");
  if (!quiet) root.setAttribute("aria-busy", "true");
  try {
    const data = await api("/listings");
    hadFirstLoad = true;
    renderListings(data);
    const on = document.getElementById("auto-refresh")?.checked !== false;
    setConnectionState(on && needsLivePoll(data.listings) ? "live" : "idle");
    return data;
  } catch (e) {
    if (!hadFirstLoad) root.replaceChildren(el(`<div class="empty-state"><span class="empty-state__icon">⚠️</span><p class="empty-state__title">Could not load</p><p class="empty-state__sub">Check your connection and refresh.</p></div>`));
    setConnectionState("idle");
    throw e;
  } finally {
    inFlight = false;
    if (!quiet) root.setAttribute("aria-busy", "false");
  }
}

function startPolling() {
  pollId += 1; const my = pollId;
  const tick = async () => {
    if (my !== pollId) return;
    if (!document.getElementById("auto-refresh")?.checked) return;
    try {
      const d = await refreshListings({ quiet: true });
      if (my !== pollId) return;
      if (!d?.listings || !needsLivePoll(d.listings)) { window.clearInterval(pollHandle); setConnectionState("idle"); }
    } catch { /* retry */ }
  };
  window.clearInterval(pollHandle);
  pollHandle = window.setInterval(tick, 2000);
  tick();
}

function stopPolling() { pollId += 1; window.clearInterval(pollHandle); }

// ── Tabs ───────────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll(".tab-panel").forEach(p => p.setAttribute("hidden", ""));
  document.getElementById(`tab-${tab}`)?.removeAttribute("hidden");
  document.querySelectorAll(".mode-tab").forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", String(active));
  });
}
document.querySelectorAll(".mode-tab").forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

// ── Char counters ───────────────────────────────────────────────────────────

function initCounter(id, cntId, max) {
  const inp = document.getElementById(id), cnt = document.getElementById(cntId);
  if (!inp || !cnt) return;
  const upd = () => { const l = inp.value.length; cnt.textContent = `${l} / ${max}`; cnt.classList.toggle("near-limit", l >= max * 0.85); cnt.classList.toggle("at-limit", l >= max); };
  inp.addEventListener("input", upd); upd();
}
initCounter("f-title", "title-count", 200);
initCounter("f-desc", "desc-count", 4000);

// ── Image compression ───────────────────────────────────────────────────────

const BEDROCK_NATIVE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

async function compressImage(file, maxBytes = 3.5 * 1024 * 1024) {
  const needsConvert = !BEDROCK_NATIVE.has(file.type);
  if (!needsConvert && file.size <= maxBytes) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res({ imageBase64: r.result.split(",")[1], mediaType: file.type });
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }
  const img = await createImageBitmap(file);
  const scale = file.size > maxBytes ? Math.sqrt(maxBytes / file.size) : 1;
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return { imageBase64: c.toDataURL("image/jpeg", 0.88).split(",")[1], mediaType: "image/jpeg" };
}

// ── AI single item ──────────────────────────────────────────────────────────

function wirePhotoZone({ inputId, pickBtnId, changeBtnId, previewId, placeholderId, analyzeBtnId, analyzeLabelId, analyzeStatusId, onAnalyze }) {
  const photoInput = document.getElementById(inputId);
  const pickBtn = document.getElementById(pickBtnId);
  const changeBtn = document.getElementById(changeBtnId);
  const preview = document.getElementById(previewId);
  const placeholder = document.getElementById(placeholderId);
  const analyzeBtn = document.getElementById(analyzeBtnId);
  const analyzeLabel = document.getElementById(analyzeLabelId);
  const analyzeStatus = document.getElementById(analyzeStatusId);

  pickBtn?.addEventListener("click", () => photoInput?.click());
  changeBtn?.addEventListener("click", () => {
    photoInput.value = "";
    preview?.setAttribute("hidden", "");
    placeholder?.removeAttribute("hidden");
    changeBtn.setAttribute("hidden", "");
    if (analyzeBtn) analyzeBtn.disabled = true;
    if (analyzeStatus) { analyzeStatus.textContent = ""; analyzeStatus.className = "ai-status"; }
  });
  photoInput?.addEventListener("change", () => {
    const file = photoInput.files?.[0]; if (!file) return;
    const url = URL.createObjectURL(file);
    if (preview) { preview.src = url; preview.removeAttribute("hidden"); }
    placeholder?.setAttribute("hidden", "");
    changeBtn?.removeAttribute("hidden");
    if (analyzeBtn) analyzeBtn.disabled = false;
    if (analyzeStatus) { analyzeStatus.textContent = ""; analyzeStatus.className = "ai-status"; }
  });
  analyzeBtn?.addEventListener("click", async () => {
    const file = photoInput?.files?.[0]; if (!file) return;
    analyzeBtn.disabled = true;
    if (analyzeLabel) analyzeLabel.textContent = "Analyzing…";
    if (analyzeStatus) { analyzeStatus.textContent = ""; analyzeStatus.className = "ai-status"; }
    try {
      const compressed = await compressImage(file);
      await onAnalyze(compressed, file);
    } catch (e) {
      const detail = e.details?.detail ?? e.message ?? "Analysis failed.";
      if (analyzeStatus) { analyzeStatus.textContent = detail; analyzeStatus.className = "ai-status err"; }
      toast(detail, "err");
    } finally {
      analyzeBtn.disabled = false;
      if (analyzeLabel) analyzeLabel.textContent = analyzeBtnId === "analyze-btn" ? "Analyze with AI" : "Identify all items";
    }
  });
}

wirePhotoZone({
  inputId: "photo-input", pickBtnId: "photo-pick-btn", changeBtnId: "photo-change-btn",
  previewId: "photo-preview", placeholderId: "photo-placeholder",
  analyzeBtnId: "analyze-btn", analyzeLabelId: "analyze-label", analyzeStatusId: "analyze-status",
  onAnalyze: async ({ imageBase64, mediaType }, _file) => {
    const result = await api("/listings/analyze", { method: "POST", body: JSON.stringify({ imageBase64, mediaType }) });
    const s = result.suggestion;
    document.getElementById("f-title").value = s.title ?? "";
    document.getElementById("f-desc").value = s.description ?? "";
    document.getElementById("f-price").value = s.suggestedPriceCents ? (s.suggestedPriceCents / 100).toFixed(2) : "";
    ["f-title", "f-desc"].forEach(id => document.getElementById(id)?.dispatchEvent(new Event("input")));
    switchTab("manual");
    document.getElementById("f-title").focus();
    toast("✨ AI filled the form — review, edit, then publish.", "ok");
  }
});

// ── AI bulk ─────────────────────────────────────────────────────────────────

let bulkSessionUrl = null;

wirePhotoZone({
  inputId: "bulk-photo-input", pickBtnId: "bulk-photo-pick-btn", changeBtnId: "bulk-photo-change-btn",
  previewId: "bulk-photo-preview", placeholderId: "bulk-photo-placeholder",
  analyzeBtnId: "bulk-analyze-btn", analyzeLabelId: "bulk-analyze-label", analyzeStatusId: "bulk-analyze-status",
  onAnalyze: async ({ imageBase64, mediaType }, file) => {
    bulkSessionUrl = URL.createObjectURL(file);
    const statusEl = document.getElementById("bulk-analyze-status");
    if (statusEl) { statusEl.textContent = "Claude is identifying items…"; statusEl.className = "ai-status"; }
    const result = await api("/listings/analyze", { method: "POST", body: JSON.stringify({ imageBase64, mediaType, bulk: true }) });
    renderBulkResults(result.items);
    if (statusEl) { statusEl.textContent = `Found ${result.items.length} item${result.items.length !== 1 ? "s" : ""}. Review below.`; statusEl.className = "ai-status ok"; }
  }
});

function renderBulkResults(items) {
  const container = document.getElementById("bulk-results");
  const list = document.getElementById("bulk-items-list");
  const countEl = document.getElementById("bulk-count");
  const publishBtn = document.getElementById("bulk-publish-btn");
  if (!container || !list) return;
  if (countEl) countEl.textContent = items.length;
  list.innerHTML = "";
  items.forEach((item, i) => {
    const card = el(`<div class="bulk-item" data-idx="${i}">
      <input type="checkbox" class="bulk-item__check" checked aria-label="Include item ${i + 1}" />
      <div class="bulk-item__fields">
        <p class="bulk-item__num">Item ${i + 1}</p>
        <input type="text" class="bulk-item__title" value="${attrEscape(item.title)}" maxlength="200" placeholder="Title" />
        <div class="bulk-item__row">
          <input type="number" class="bulk-item__price" value="${item.suggestedPriceCents ? (item.suggestedPriceCents / 100).toFixed(2) : ""}" min="0" step="0.01" placeholder="Price" />
          <textarea class="bulk-item__desc" rows="2" maxlength="4000" placeholder="Description">${escapeHtml(item.description)}</textarea>
        </div>
        <p class="bulk-item__progress" id="bulk-item-progress-${i}"></p>
      </div>
    </div>`);
    card.querySelector(".bulk-item__check")?.addEventListener("change", updateBulkPublishBtn);
    list.appendChild(card);
  });
  updateBulkPublishBtn();
  container.removeAttribute("hidden");
  if (publishBtn) publishBtn.disabled = false;
}

function updateBulkPublishBtn() {
  const checks = document.querySelectorAll(".bulk-item__check");
  const n = [...checks].filter(c => c.checked).length;
  const btn = document.getElementById("bulk-publish-btn");
  const label = document.getElementById("bulk-publish-label");
  if (btn) btn.disabled = n === 0;
  if (label) label.textContent = n > 0 ? `Publish ${n} listing${n !== 1 ? "s" : ""}` : "Select items to publish";
}

document.getElementById("bulk-select-all-btn")?.addEventListener("click", () => {
  const checks = document.querySelectorAll(".bulk-item__check");
  const allChecked = [...checks].every(c => c.checked);
  checks.forEach(c => { c.checked = !allChecked; c.dispatchEvent(new Event("change")); });
  updateBulkPublishBtn();
});

document.getElementById("bulk-publish-btn")?.addEventListener("click", async () => {
  const items = document.querySelectorAll(".bulk-item");
  const toPublish = [];
  items.forEach((item, i) => {
    const chk = item.querySelector(".bulk-item__check");
    if (!chk?.checked) return;
    const title = item.querySelector(".bulk-item__title")?.value?.trim() ?? "";
    const price = parseFloat(item.querySelector(".bulk-item__price")?.value ?? "0");
    const description = item.querySelector(".bulk-item__desc")?.value?.trim() ?? "";
    if (title && description && !isNaN(price)) toPublish.push({ idx: i, title, description, price });
  });
  if (!toPublish.length) return;

  const btn = document.getElementById("bulk-publish-btn");
  const label = document.getElementById("bulk-publish-label");
  btn.disabled = true;
  if (label) label.textContent = `Publishing 0 / ${toPublish.length}…`;

  let done = 0;
  // Stagger requests 300ms apart so Lambda + mock URL don't all cold-start at once
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = await Promise.allSettled(toPublish.map(async (item, idx) => {
    await sleep(idx * 300);
    const progEl = document.getElementById(`bulk-item-progress-${item.idx}`);
    const idem = newIdem();
    try {
      const r = await api("/listings", {
        method: "POST",
        headers: { "idempotency-key": idem },
        body: JSON.stringify({ title: item.title, description: item.description, price: item.price }),
      });
      if (bulkSessionUrl) sessionPhotos.set(r.listing?.listingId, bulkSessionUrl);
      if (progEl) { progEl.textContent = "✓ Sent to mock eBay"; progEl.className = "bulk-item__progress is-ok"; }
      done++;
      if (label) label.textContent = `Publishing ${done} / ${toPublish.length}…`;
    } catch (e) {
      if (progEl) { progEl.textContent = `✕ ${e.message}`; progEl.className = "bulk-item__progress is-err"; }
      throw e;
    }
  }));

  const failed = results.filter(r => r.status === "rejected").length;
  if (label) label.textContent = failed ? `Done — ${failed} failed` : `Published ${done} listings!`;
  toast(failed ? `${done} published, ${failed} failed.` : `🎉 ${done} listings sent to mock eBay!`, failed ? "warn" : "ok");
  await refreshListings();
  const ar = document.getElementById("auto-refresh");
  if (ar) ar.checked = true;
  startPolling();
  setTimeout(() => { btn.disabled = false; updateBulkPublishBtn(); }, 2000);
});

// ── Manual form ────────────────────────────────────────────────────────────

document.getElementById("listing-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("submit-btn"), label = document.getElementById("submit-label");
  btn.disabled = true;
  if (label) label.textContent = "Publishing…";
  const fd = new FormData(e.target);
  const body = { title: String(fd.get("title")), description: String(fd.get("description")), price: Number(fd.get("price")) };
  const photoRaw = String(fd.get("photoUrl") || "").trim();
  if (photoRaw) body.photoUrl = photoRaw;
  try {
    const r = await api("/listings", { method: "POST", headers: { "idempotency-key": newIdem() }, body: JSON.stringify(body) });
    e.target.reset();
    ["f-title","f-desc"].forEach(id => document.getElementById(id)?.dispatchEvent(new Event("input")));
    toast("🚀 Listing sent to mock eBay — watching for webhooks…", "ok");
    await refreshListings();
    document.getElementById("auto-refresh").checked = true;
    startPolling();
    void r;
  } catch (err) {
    toast(err.message || "Publish failed", "err");
  } finally {
    btn.disabled = false;
    if (label) label.textContent = "Publish listing";
  }
});

// ── Controls ───────────────────────────────────────────────────────────────

document.getElementById("refresh-btn")?.addEventListener("click", async () => {
  try { await refreshListings(); } catch { /* shown inline */ }
});

document.getElementById("auto-refresh")?.addEventListener("change", ev => {
  if (ev.target.checked) startPolling(); else { stopPolling(); setConnectionState("idle"); }
});

document.getElementById("replay-dlq-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("replay-dlq-btn");
  btn.disabled = true; btn.textContent = "Replaying…";
  try {
    const r = await api("/admin/replay-dlq", { method: "POST" });
    toast(r.replayed > 0 ? `Replayed ${r.replayed} failed job${r.replayed !== 1 ? "s" : ""}.` : "DLQ is empty.", r.replayed > 0 ? "ok" : "info");
    if (r.replayed > 0) { await refreshListings(); document.getElementById("auto-refresh").checked = true; startPolling(); }
  } catch (e) { toast("DLQ replay failed", "err"); }
  finally { setTimeout(() => { btn.disabled = false; btn.textContent = "Replay DLQ"; }, 2000); }
});

// ── Init ───────────────────────────────────────────────────────────────────

setConnectionState("loading");
refreshListings()
  .then(d => { if (d?.listings && needsLivePoll(d.listings)) { if (document.getElementById("auto-refresh")?.checked !== false) startPolling(); } })
  .catch(() => setConnectionState("idle"));
