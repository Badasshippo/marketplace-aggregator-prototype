const API_BASE = "/api";

const TERMINAL = new Set(["sold", "publish_dispatch_failed"]);
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

let pollId = 0;
let inFlight = false;
let hadFirstLoad = false;

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function money(cents) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function relTime(iso) {
  const t = new Date(iso).getTime();
  const s = (t - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 45) return rtf.format(Math.round(s), "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

async function api(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(json?.error || res.statusText);
    err.details = json;
    err.status = res.status;
    throw err;
  }
  return json;
}

function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** For HTML double-quoted attributes (e.g. src); preserves valid URLs with query strings. */
function attrEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function safeImageUrl(u) {
  if (!u || typeof u !== "string") return null;
  try {
    const x = new URL(u.trim());
    if (x.protocol !== "http:" && x.protocol !== "https:") return null;
    return x.href;
  } catch {
    return null;
  }
}

function badgeClass(status) {
  const k = String(status).replace(/[^a-z0-9_]/gi, "_");
  return `badge--${k}`;
}

function hasSoldEvent(acts) {
  return acts?.some((a) => a.type === "item_sold");
}
function hasComment(acts) {
  return acts?.some((a) => a.type === "new_comment");
}

function pipelineHtml(status, acts) {
  const soldEv = hasSoldEvent(acts);
  const cmt = hasComment(acts);
  if (TERMINAL.has(status) && status === "publish_dispatch_failed") {
    return `<div class="pipeline" role="list"><span class="pipe is-err" role="listitem">Publish</span>
      <span class="pipe is-err" role="listitem">Failed</span></div>`;
  }
  if (status === "sold" || soldEv) {
    return `<div class="pipeline" role="list"><span class="pipe is-done" role="listitem">Publish</span>
      <span class="pipe is-done" role="listitem">Activity</span>
      <span class="pipe is-done" role="listitem">Sold</span></div>`;
  }
  if (status === "live" || cmt) {
    return `<div class="pipeline" role="list"><span class="pipe is-done" role="listitem">Publish</span>
      <span class="pipe is-wait" role="listitem">Activity</span>
      <span class="pipe" role="listitem">Sold</span></div>`;
  }
  if (status === "publishing" || status === "pending_publish") {
    return `<div class="pipeline" role="list"><span class="pipe is-wait" role="listitem">Publish</span>
      <span class="pipe" role="listitem">Activity</span>
      <span class="pipe" role="listitem">Sold</span></div>`;
  }
  return "";
}

function needsLivePoll(listings) {
  if (!listings?.length) return false;
  return listings.some((l) => !TERMINAL.has(l.status));
}

function setConnectionState(mode) {
  const pill = document.getElementById("connection-pill");
  const label = document.getElementById("connection-label");
  if (!pill || !label) return;
  pill.classList.remove("is-live");
  if (mode === "live") {
    pill.classList.add("is-live");
    label.textContent = "Live updates";
  } else if (mode === "loading") {
    label.textContent = "Loading…";
  } else {
    label.textContent = "Up to date";
  }
}

function renderListings(data) {
  const root = document.getElementById("listings-root");
  if (!data.listings?.length) {
    root.replaceChildren();
    root.appendChild(
      el(
        `<div class="empty--card"><p class="muted" style="margin:0">No listings yet. Create one — the mock eBay path takes a few seconds (retries on synthetic failures).</p></div>`,
      ),
    );
    return;
  }
  const frag = document.createDocumentFragment();
  for (const l of data.listings) {
    const acts = (l.recentActivity || []).slice().sort((a, b) => {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    const imgHref = safeImageUrl(l.photoUrl);
    const photo = imgHref
      ? `<img class="listing__media" src="${attrEscape(imgHref)}" alt="" loading="lazy" width="96" height="96" />`
      : `<div class="listing__media listing__media--ph" aria-hidden="true">No image</div>`;
    const pipe = pipelineHtml(l.status, acts);
    let timeline = "";
    if (acts.length) {
      for (const a of acts) {
        const isComment = a.type === "new_comment";
        const isSold = a.type === "item_sold";
        const detail = isComment
          ? escapeHtml(String(a.payload?.comment || ""))
          : isSold
            ? `Marketplace <code>${escapeHtml(String(a.payload?.marketplaceListingId || "—"))}</code>`
            : "";
        const title = isComment
          ? "New comment"
          : isSold
            ? "Item sold"
            : escapeHtml(a.type);
        timeline += `<li>
            <span class="timeline__type">${title}</span>
            <span class="timeline__meta" title="${escapeHtml(a.createdAt)}">${relTime(a.createdAt)}</span>
            ${detail ? `<span class="timeline__detail">${detail}</span>` : ""}
          </li>`;
      }
    } else {
      timeline = `<p class="muted" style="margin:0.35rem 0 0">No webhook activity yet — queue may be retrying (~15% synthetic fail).</p>`;
    }
    const node = el(
      `<article class="listing">
        ${photo}
        <div class="listing__body">
          <div class="listing__top">
            <h3 class="listing__title">${escapeHtml(l.title)}</h3>
            <span class="badge ${badgeClass(l.status)}">${escapeHtml(l.status.replace(/_/g, " "))}</span>
          </div>
          <p class="listing__price">${money(l.priceCents)}</p>
          ${pipe}
          <p class="listing__desc">${escapeHtml((l.description || "").slice(0, 200))}${
        (l.description || "").length > 200 ? "…" : ""
      }</p>
          ${acts.length ? `<ol class="timeline" aria-label="Activity">${timeline}</ol>` : `<div class="timeline">${timeline}</div>`}
        </div>
      </article>`,
    );
    const first = node.firstElementChild;
    if (imgHref && first?.tagName === "IMG") {
      first.addEventListener("error", () => {
        const d = document.createElement("div");
        d.className = "listing__media listing__media--ph";
        d.setAttribute("aria-hidden", "true");
        d.textContent = "No preview";
        first.replaceWith(d);
      });
    }
    frag.appendChild(node);
  }
  root.replaceChildren(frag);
}

async function refreshListings({ quiet } = {}) {
  if (inFlight) return;
  inFlight = true;
  const root = document.getElementById("listings-root");
  if (!hadFirstLoad && !quiet) {
    setConnectionState("loading");
  }
  if (!quiet) root.setAttribute("aria-busy", "true");
  try {
    const data = await api("/listings");
    hadFirstLoad = true;
    renderListings(data);
    const ar = document.getElementById("auto-refresh");
    const on = ar?.checked !== false;
    if (on && needsLivePoll(data.listings)) {
      setConnectionState("live");
    } else {
      setConnectionState("idle");
    }
    return data;
  } catch (e) {
    console.error(e);
    if (!hadFirstLoad) {
      root.innerHTML = "";
      root.appendChild(
        el(
          `<p class="empty err" role="alert" style="color:var(--err)">Could not load listings. Check the network and try Refresh.</p>`,
        ),
      );
    }
    setConnectionState("idle");
    throw e;
  } finally {
    inFlight = false;
    if (!quiet) root.setAttribute("aria-busy", "false");
  }
}

let pollHandle = 0;

function startPolling() {
  pollId += 1;
  const my = pollId;
  const tick = async () => {
    if (my !== pollId) return;
    const ar = document.getElementById("auto-refresh");
    if (ar && !ar.checked) return;
    try {
      const d = await refreshListings({ quiet: true });
      if (my !== pollId) return;
      if (!d?.listings || !needsLivePoll(d.listings)) {
        window.clearInterval(pollHandle);
        setConnectionState("idle");
        return;
      }
    } catch {
      /* next tick */
    }
  };
  window.clearInterval(pollHandle);
  pollHandle = window.setInterval(tick, 2000);
  tick();
}

function stopPolling() {
  pollId += 1;
  window.clearInterval(pollHandle);
}

document.getElementById("listing-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("submit-btn");
  const status = document.getElementById("form-status");
  status.textContent = "";
  status.className = "form__status";
  btn.disabled = true;
  const fd = new FormData(e.target);
  const price = Number(fd.get("price"));
  const photoRaw = String(fd.get("photoUrl") || "").trim();
  const body = {
    title: String(fd.get("title")),
    description: String(fd.get("description")),
    price,
  };
  if (photoRaw) body.photoUrl = photoRaw;
  try {
    await api("/listings", {
      method: "POST",
      headers: { "idempotency-key": newIdempotencyKey() },
      body: JSON.stringify(body),
    });
    status.textContent = "Listing accepted — webhooks will appear as the mock finishes.";
    status.classList.add("ok");
    e.target.reset();
    await refreshListings();
    const ar = document.getElementById("auto-refresh");
    if (ar) ar.checked = true;
    startPolling();
  } catch (err) {
    status.textContent = err.message || "Request failed";
    status.classList.add("err");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("refresh-btn")?.addEventListener("click", async () => {
  try {
    await refreshListings();
  } catch {
    /* status in refreshListings */
  }
});

document.getElementById("auto-refresh")?.addEventListener("change", (ev) => {
  if (ev.target.checked) {
    startPolling();
  } else {
    stopPolling();
    setConnectionState("idle");
  }
});

refreshListings()
  .then((d) => {
    if (d?.listings && needsLivePoll(d.listings)) {
      const ar = document.getElementById("auto-refresh");
      if (ar?.checked !== false) startPolling();
    }
  })
  .catch(() => {
    setConnectionState("idle");
  });
