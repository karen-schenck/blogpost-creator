/* Blog post builder: step-by-step editor for the Karen Schenck and Vision Human Consulting blogs. */
(function () {
  const { esc } = MD;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const STORE_CURRENT = "bpc.current";
  const STORE_DRAFTS = "bpc.drafts";
  const STORE_STEP = "bpc.step";

  const STEPS = [
    { id: "start", label: "Démarrer", hint: "Site, brouillons, import" },
    { id: "article", label: "Article", hint: "Titre, slug, catégorie, intro" },
    { id: "seo", label: "SEO", hint: "Titre Google, description, mots-clés" },
    { id: "write", label: "Rédaction", hint: "Texte, images, tableaux, liens" },
    { id: "faq", label: "Points clés & FAQ", hint: "À retenir, questions fréquentes" },
    { id: "links", label: "Maillage & CTA", hint: "Articles liés, appel à l'action" },
    { id: "english", label: "Version anglaise", hint: "Traduction complète" },
    { id: "review", label: "Vérification", hint: "Score SEO, aperçu final" },
    { id: "export", label: "Télécharger", hint: "Fichier .md, images, llms" },
    { id: "publish", label: "Publier", hint: "Guide pas à pas ou commit auto" },
  ];

  const state = {
    draft: null,
    step: "start",
    enTab: "article",
    editorMode: "split",
    previewLocale: "fr",
    publishTab: "guide",
    remoteSlugs: {},
    live: [],
    savedAt: null,
    dirty: false,
    gh: { log: [], result: null, running: false, checked: null },
  };

  /* ---------------- utilities ---------------- */

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const STOP = new Set("le la les l de des du d un une et en a au aux pour par sur dans qu que qui quand avec ce ces est sont se sa son ses vos votre nos notre ou mais plus ne pas the a an of and to in for on with is are how why what your".split(" "));

  function slugify(text, short = false) {
    let words = norm(text).replace(/[’']/g, " ").replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
    if (short) words = words.filter((w) => !STOP.has(w)).slice(0, 7);
    return words.join("-").slice(0, 80).replace(/-+$/, "");
  }

  function site() {
    return SITES[state.draft?.site || "vhc"];
  }

  function emptyLocale(cta) {
    return {
      category: "",
      title: "",
      seoTitle: "",
      description: "",
      excerpt: "",
      readingTime: "",
      keywords: [],
      heroEyebrow: "",
      intro: "",
      keyTakeaways: ["", "", ""],
      faq: [
        { question: "", answer: "" },
        { question: "", answer: "" },
        { question: "", answer: "" },
      ],
      cta: { ...cta },
      body: "",
    };
  }

  function newDraft(siteId) {
    const s = SITES[siteId];
    return {
      version: 1,
      id: uid(),
      site: siteId,
      slug: "",
      slugTouched: false,
      editingExisting: false,
      publishedAt: today(),
      updatedAt: today(),
      relatedSlugs: [],
      enEnabled: true,
      autoReading: { fr: true, en: true },
      fr: emptyLocale(s.cta.fr),
      en: emptyLocale(s.cta.en),
      images: [],
      createdAt: new Date().toISOString(),
    };
  }

  function getPath(obj, path) {
    return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setPath(obj, path, value) {
    const keys = path.split(".");
    let o = obj;
    keys.slice(0, -1).forEach((k) => (o = o[k]));
    o[keys[keys.length - 1]] = value;
  }

  function readingTimeFor(body) {
    const words = MD.wordCount(body);
    return words ? `${Math.max(1, Math.round(words / 200))} min` : "";
  }

  function hasContent(d) {
    return Boolean(d && (d.fr.title || d.fr.body || d.fr.description));
  }

  function knownPosts() {
    const s = site();
    const list = [...s.posts];
    (state.remoteSlugs[s.id] || []).forEach((slug) => {
      if (!list.some((p) => p.slug === slug)) list.push({ slug, title: slug });
    });
    return list.filter((p) => p.slug !== state.draft.slug);
  }

  function toast(message, kind = "info") {
    const el = document.createElement("div");
    el.className = `toast toast-${kind}`;
    el.textContent = message;
    $("#toasts").appendChild(el);
    setTimeout(() => el.classList.add("show"), 10);
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, kind === "error" ? 7000 : 3500);
  }

  function download(filename, content, type = "text/plain;charset=utf-8") {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function dataUrlToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(",");
    const mime = head.match(/data:([^;]+)/)[1];
    const bin = atob(b64);
    return new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type: mime });
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copié dans le presse-papiers.", "ok");
    } catch {
      toast("Copie impossible : sélectionnez le texte manuellement.", "error");
    }
  }

  /* ---------------- persistence ---------------- */

  function storeGet(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function storeSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  let saveTimer = null;
  function scheduleSave() {
    state.dirty = true;
    renderSaveStatus();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(autosave, 600);
  }

  function autosave() {
    if (!state.draft) return;
    state.draft.savedAt = new Date().toISOString();
    if (storeSet(STORE_CURRENT, state.draft)) {
      state.savedAt = new Date();
      state.dirty = false;
    } else {
      toast("Stockage du navigateur plein (images ?). Téléchargez le brouillon en .json pour ne rien perdre.", "error");
    }
    renderSaveStatus();
  }

  function saveToDrafts() {
    autosave();
    const drafts = storeGet(STORE_DRAFTS, {});
    drafts[state.draft.id] = state.draft;
    if (storeSet(STORE_DRAFTS, drafts)) toast("Brouillon enregistré dans ce navigateur.", "ok");
    else toast("Stockage plein : téléchargez le brouillon (.json) à la place.", "error");
  }

  function renderSaveStatus() {
    const el = $("#save-status");
    if (!el) return;
    if (state.dirty) el.textContent = "Modifications en cours…";
    else if (state.savedAt) el.textContent = `Sauvegardé automatiquement à ${state.savedAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
    else el.textContent = "Brouillon local";
  }

  function downloadDraft() {
    autosave();
    const name = state.draft.slug || "brouillon";
    download(`${name}.draft.json`, JSON.stringify(state.draft, null, 2), "application/json");
  }

  function loadDraftObject(obj) {
    if (!obj || obj.version !== 1 || !obj.fr || !SITES[obj.site]) throw new Error("Ce fichier n'est pas un brouillon valide.");
    state.draft = obj;
    applyTheme();
    autosave();
  }

  /* ---------------- checks ---------------- */

  function check(list, step, ok, level, msg) {
    list.push({ step, level: ok ? "ok" : level, msg });
  }

  function emDashFields(loc) {
    const d = state.draft[loc];
    const fields = [d.title, d.seoTitle, d.description, d.excerpt, d.intro, d.heroEyebrow, ...d.keyTakeaways, ...d.faq.flatMap((f) => [f.question, f.answer]), d.cta.title, d.cta.description];
    return fields.some((f) => String(f || "").includes("—"));
  }

  function localeChecks(loc, stepIds) {
    const d = state.draft;
    const L = d[loc];
    const s = site();
    const out = [];
    const [stArticle, stSeo, stWrite, stFaq, stLinks] = stepIds;
    const len = (v) => String(v || "").trim().length;

    check(out, stArticle, len(L.title) > 0, "error", "Titre de l'article renseigné");
    if (len(L.title)) check(out, stArticle, len(L.title) >= 30 && len(L.title) <= 100, "warn", `Titre de 30 à 100 caractères (actuel : ${len(L.title)})`);
    check(out, stArticle, len(L.category) > 0, "error", "Catégorie choisie");
    check(out, stArticle, len(L.heroEyebrow) > 0, "warn", "Surtitre (eyebrow) renseigné");
    check(out, stArticle, len(L.intro) >= 150 && len(L.intro) <= 500, "warn", `Introduction de 150 à 500 caractères (actuel : ${len(L.intro)})`);

    check(out, stSeo, len(L.seoTitle) > 0, "error", "Titre SEO renseigné");
    if (len(L.seoTitle)) check(out, stSeo, len(L.seoTitle) >= 35 && len(L.seoTitle) <= 65, "warn", `Titre SEO de 35 à 65 caractères (actuel : ${len(L.seoTitle)})`);
    check(out, stSeo, len(L.description) >= 120 && len(L.description) <= 160, len(L.description) ? "warn" : "error", `Meta description de 120 à 160 caractères (actuel : ${len(L.description)})`);
    check(out, stSeo, len(L.excerpt) >= 100 && len(L.excerpt) <= 260, "warn", `Extrait (cartes du blog) de 100 à 260 caractères (actuel : ${len(L.excerpt)})`);
    const kw = L.keywords.filter(Boolean);
    check(out, stSeo, kw.length >= 3 && kw.length <= 10, "warn", `3 à 10 mots-clés (actuel : ${kw.length})`);
    if (kw.length) {
      const main = norm(kw[0]);
      const heads = MD.headings(L.body).map((h) => norm(h.title)).join(" ");
      const places = {
        "titre": norm(L.title),
        "titre SEO": norm(L.seoTitle),
        "description": norm(L.description),
        "introduction": norm(L.intro),
        "un sous-titre ##": heads,
      };
      const words = main.split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
      const missing = Object.entries(places)
        .filter(([, v]) => !words.every((w) => v.includes(w)))
        .map(([k]) => k);
      check(out, stSeo, missing.length === 0, "warn", missing.length ? `Mot-clé principal « ${kw[0]} » absent de : ${missing.join(", ")}` : `Mot-clé principal « ${kw[0]} » présent dans le titre, le titre SEO, la description, l'intro et un sous-titre`);
    }

    const words = MD.wordCount(L.body);
    check(out, stWrite, words >= 800, words >= 300 ? "warn" : "error", `Au moins 800 mots pour un article de fond (actuel : ${words})`);
    const h2 = MD.headings(L.body).filter((h) => h.level === 2).length;
    check(out, stWrite, h2 >= 3, "warn", `Au moins 3 sous-titres ## (actuel : ${h2})`);
    const links = Array.from(L.body.matchAll(/\[[^\]]+\]\(([^)\s]+)/g)).map((m) => m[1]);
    const internal = links.filter((h) => h.startsWith("/")).length;
    const external = links.filter((h) => /^https?:\/\//.test(h)).length;
    check(out, stWrite, internal >= 2, "warn", `Au moins 2 liens internes vers le site (actuel : ${internal})`);
    check(out, stWrite, external >= 1, "warn", `Au moins 1 source externe citée (actuel : ${external})`);
    const lint = MD.lint(L.body, { noEmDash: true });
    const lintErr = lint.filter((i) => i.level === "error").length;
    const lintWarn = lint.filter((i) => i.level === "warn").length;
    check(out, stWrite, lintErr === 0, "error", lintErr ? `${lintErr} erreur(s) de mise en forme dans le texte` : "Mise en forme compatible avec le site");
    if (lintWarn) check(out, stWrite, false, "warn", `${lintWarn} avertissement(s) de mise en forme dans le texte`);
    check(out, stArticle, !emDashFields(loc), "warn", "Pas de tiret cadratin (—) dans les champs");

    const kt = L.keyTakeaways.filter(Boolean).length;
    check(out, stFaq, kt >= 3, "warn", `Au moins 3 points clés (actuel : ${kt})`);
    const faq = L.faq.filter((f) => f.question && f.answer);
    check(out, stFaq, faq.length >= 3, "warn", `Au moins 3 questions FAQ complètes, pour le résultat enrichi Google (actuel : ${faq.length})`);
    const longAns = faq.filter((f) => f.answer.length < 40 || f.answer.length > 400).length;
    if (faq.length) check(out, stFaq, longAns === 0, "warn", "Réponses FAQ de 40 à 400 caractères");

    check(out, stLinks, len(L.cta.title) > 0 && len(L.cta.primaryLabel) > 0 && len(L.cta.primaryHref) > 0, "error", "Appel à l'action complet (titre, bouton, lien)");
    return out;
  }

  function computeChecks() {
    const d = state.draft;
    const s = site();
    const out = [];
    check(out, "article", /^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.slug), "error", "Slug (adresse) valide : minuscules, chiffres et tirets");
    if (d.slug) check(out, "article", d.slug.length <= 70, "warn", `Slug court, 70 caractères max (actuel : ${d.slug.length})`);
    const taken = [...s.posts.map((p) => p.slug), ...(state.remoteSlugs[s.id] || [])].includes(d.slug);
    if (d.slug && taken) out.push({ step: "article", level: d.editingExisting ? "ok" : "warn", msg: d.editingExisting ? "Mise à jour d'un article existant (même slug)" : "Ce slug existe déjà : l'article existant serait remplacé" });
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(d.publishedAt) && /^\d{4}-\d{2}-\d{2}$/.test(d.updatedAt);
    check(out, "article", dateOk && d.updatedAt >= d.publishedAt, "error", "Dates valides (mise à jour ≥ publication)");

    out.push(...localeChecks("fr", ["article", "seo", "write", "faq", "links"]));

    check(out, "links", d.relatedSlugs.length >= 1, "warn", `Au moins 1 article lié (actuel : ${d.relatedSlugs.length})`);

    if (!d.enEnabled) {
      out.push({ step: "english", level: "warn", msg: "Pas de version anglaise : la page /en/ affichera le texte français" });
    } else {
      localeChecks("en", ["english", "english", "english", "english", "english"]).forEach((c) => out.push({ ...c, msg: `EN · ${c.msg}` }));
    }
    const missingImages = d.images.filter((img) => !d.fr.body.includes(img.src) && !d.en.body.includes(img.src));
    if (missingImages.length) out.push({ step: "write", level: "warn", msg: `${missingImages.length} image(s) importée(s) non utilisée(s) dans le texte (elles ne seront pas publiées)` });
    return out;
  }

  function stepStatus(stepId, checks) {
    const mine = checks.filter((c) => c.step === stepId);
    if (!mine.length) return "";
    if (mine.some((c) => c.level === "error")) return "error";
    if (mine.some((c) => c.level === "warn")) return "warn";
    return "ok";
  }

  /* ---------------- rendering helpers ---------------- */

  function counterAttrs(path, min, max) {
    return `<span class="counter" data-counter="${path}" data-min="${min}" data-max="${max}"></span>`;
  }

  function field({ label, path, type = "text", hint = "", rows = 0, min = 0, max = 0, placeholder = "", list = "", required = false }) {
    const value = getPath(state.draft, path) ?? "";
    const counter = max ? counterAttrs(path, min, max) : "";
    const control = rows
      ? `<textarea data-bind="${path}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input type="${type}" data-bind="${path}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${list ? `list="${list}"` : ""} />`;
    return `<label class="field">
      <span class="field-label">${label}${required ? ' <b class="req">*</b>' : ""}${counter}</span>
      ${control}
      ${hint ? `<small class="hint">${hint}</small>` : ""}
    </label>`;
  }

  function stepHeader(title, intro) {
    return `<header class="step-head"><h2>${title}</h2>${intro ? `<p>${intro}</p>` : ""}</header>`;
  }

  function navButtons() {
    const idx = STEPS.findIndex((s) => s.id === state.step);
    const prev = STEPS[idx - 1];
    const next = STEPS[idx + 1];
    return `<div class="step-nav">
      ${prev ? `<button class="btn btn-ghost" data-action="go" data-step="${prev.id}">← ${prev.label}</button>` : "<span></span>"}
      ${next ? `<button class="btn btn-primary" data-action="go" data-step="${next.id}">${next.label} →</button>` : ""}
    </div>`;
  }

  function checksList(items, { withLinks = false } = {}) {
    if (!items.length) return '<p class="muted">Rien à vérifier ici.</p>';
    const order = { error: 0, warn: 1, ok: 2 };
    return `<ul class="checks">${items
      .slice()
      .sort((a, b) => order[a.level] - order[b.level])
      .map(
        (c) => `<li class="check check-${c.level}"><span class="dot"></span><span>${esc(c.msg)}</span>${
          withLinks && c.level !== "ok" ? `<button class="link-btn" data-action="go" data-step="${c.step}">Corriger</button>` : ""
        }</li>`
      )
      .join("")}</ul>`;
  }

  function resolveImage(src) {
    const img = state.draft.images.find((i) => i.src === src);
    if (img) return img.dataUrl;
    if (src.startsWith("/")) return `${site().previewDomain}${src}`;
    return src;
  }

  function mdPreview(markdown) {
    return MD.toHtml(markdown, { resolveImage, resolveLink: (href) => `${site().domain}${href}` });
  }

  /* ---------------- steps ---------------- */

  function renderStart() {
    const d = state.draft;
    const drafts = Object.values(storeGet(STORE_DRAFTS, {})).sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
    const siteCards = Object.values(SITES)
      .map(
        (s) => `<button class="site-card ${d.site === s.id ? "active" : ""}" data-action="pick-site" data-site="${s.id}" style="--c-ink:${s.theme.ink};--c-accent:${s.theme.accent}">
          <span class="site-card-mark"></span>
          <strong>${esc(s.name)}</strong>
          <span>${esc(s.tagline)}</span>
          <small>${esc(s.domain.replace("https://", ""))} · ${s.posts.length} articles</small>
        </button>`
      )
      .join("");
    return `${stepHeader("Démarrer", "Choisissez le site, puis créez un nouvel article ou reprenez un brouillon. Tout est enregistré automatiquement dans ce navigateur.")}
      <section class="card">
        <h3>1. Pour quel site ?</h3>
        <div class="site-cards">${siteCards}</div>
        <p class="muted small">Le site choisi définit les catégories, les pages pour les liens internes, l'appel à l'action par défaut, le dépôt GitHub et le format de llms.txt.</p>
      </section>

      <section class="card">
        <h3>2. Brouillon en cours</h3>
        ${
          hasContent(d)
            ? `<div class="draft-row current"><div><strong>${esc(d.fr.title || "(sans titre)")}</strong><small>${esc(SITES[d.site].name)} · ${d.slug ? esc(d.slug) : "pas de slug"}${d.editingExisting ? " · modification d'un article existant" : ""}</small></div>
                <div class="row-actions"><button class="btn btn-primary" data-action="go" data-step="article">Continuer</button><button class="btn btn-ghost" data-action="new-draft">Nouvel article</button></div></div>`
            : `<p class="muted">Brouillon vide pour <strong>${esc(site().name)}</strong>. <button class="link-btn" data-action="go" data-step="article">Commencer la rédaction →</button></p>`
        }
      </section>

      <section class="card">
        <h3>3. Brouillons enregistrés dans ce navigateur</h3>
        ${
          drafts.length
            ? drafts
                .map(
                  (x) => `<div class="draft-row"><div><strong>${esc(x.fr.title || "(sans titre)")}</strong><small>${esc(SITES[x.site]?.name || x.site)} · ${x.savedAt ? new Date(x.savedAt).toLocaleString("fr-FR") : ""}</small></div>
                  <div class="row-actions"><button class="btn btn-ghost" data-action="open-draft" data-id="${x.id}">Ouvrir</button><button class="btn btn-ghost danger" data-action="delete-draft" data-id="${x.id}">Supprimer</button></div></div>`
                )
                .join("")
            : '<p class="muted">Aucun. Utilisez « Enregistrer » en haut de page pour garder plusieurs brouillons.</p>'
        }
      </section>

      <section class="card">
        <h3>4. Charger un fichier</h3>
        <div class="grid-2">
          <label class="drop">
            <input type="file" accept=".json,application/json" data-action="load-draft-file" hidden />
            <strong>Charger un brouillon (.json)</strong>
            <span>Le fichier téléchargé avec « Télécharger le brouillon ». Pratique pour changer d'ordinateur ou partager.</span>
          </label>
          <label class="drop">
            <input type="file" accept=".md,text/markdown" data-action="import-md-file" hidden />
            <strong>Modifier un article publié (.md)</strong>
            <span>Le fichier <code>data/blogs/&lt;slug&gt;.md</code> du site. Il sera réimporté dans tous les champs.</span>
          </label>
        </div>
        <div class="gh-import">
          <button class="btn btn-ghost" data-action="gh-list-posts">Importer depuis GitHub…</button>
          <span class="muted small">Nécessite un jeton configuré à l'étape « Publier ».</span>
          <div id="gh-post-list"></div>
        </div>
      </section>
      ${navButtons()}`;
  }

  function categoryOptions(loc) {
    return `<datalist id="cat-${loc}">${site()
      .categories.map((c) => `<option value="${esc(c[loc])}"></option>`)
      .join("")}</datalist>`;
  }

  function renderArticle(loc = "fr") {
    const d = state.draft;
    const s = site();
    const p = (k) => `${loc}.${k}`;
    const shared =
      loc === "fr"
        ? `<div class="grid-2">
            <label class="field">
              <span class="field-label">Slug (adresse de la page) <b class="req">*</b>${counterAttrs("slug", 3, 70)}</span>
              <div class="input-group"><span class="prefix">/blog/</span><input type="text" data-bind="slug" value="${esc(d.slug)}" placeholder="mon-article" /></div>
              <small class="hint">Généré depuis le titre. Ne le changez plus après publication (les liens existants casseraient). <button class="link-btn" data-action="slug-short">Raccourcir</button> <button class="link-btn" data-action="slug-reset">Régénérer</button></small>
            </label>
            <div class="grid-2 tight">
              ${field({ label: "Publié le", path: "publishedAt", type: "date" })}
              ${field({ label: "Mis à jour le", path: "updatedAt", type: "date" })}
            </div>
          </div>`
        : `<p class="note">Le slug (<code>/blog/${esc(d.slug || "…")}/</code>) et les dates sont communs aux deux langues. La version anglaise sera à <code>/en/blog/${esc(d.slug || "…")}/</code>.</p>`;
    return `${loc === "fr" ? stepHeader("L'article", "Le titre, l'adresse et l'introduction : ce que le lecteur voit en premier.") : ""}
      <section class="card">
        ${field({ label: "Titre de l'article (H1)", path: p("title"), required: true, min: 30, max: 100, placeholder: loc === "fr" ? "Audit stratégique : révéler les écarts invisibles entre la stratégie et le terrain" : "Strategic audit: revealing the invisible gaps", hint: "Le grand titre de la page. Clair, concret, avec le sujet principal au début." })}
        ${shared}
        <div class="grid-2">
          ${field({ label: "Catégorie", path: p("category"), list: `cat-${loc}`, required: true, hint: "Choisissez dans la liste ou tapez une nouvelle catégorie.", placeholder: s.categories[0][loc] })}
          ${field({ label: "Surtitre (eyebrow)", path: p("heroEyebrow"), placeholder: loc === "fr" ? s.eyebrowExample : "", hint: "Petit texte au-dessus du titre, ex. « Catégorie · Sujet »." })}
        </div>
        ${categoryOptions(loc)}
        ${field({ label: "Introduction (chapô)", path: p("intro"), rows: 4, min: 150, max: 500, hint: "2 à 4 phrases sous le titre : le problème, pourquoi c'est important, ce que l'article apporte." })}
      </section>
      ${loc === "fr" ? navButtons() : ""}`;
  }

  function renderSeo(loc = "fr") {
    const p = (k) => `${loc}.${k}`;
    const L = state.draft[loc];
    return `${loc === "fr" ? stepHeader("Référencement (SEO)", "Ce que Google, LinkedIn et les assistants IA affichent. Le titre SEO et la description ne sont pas visibles sur la page, mais ils décident du clic.") : ""}
      <section class="card">
        <div class="field-with-action">
          ${field({ label: "Titre SEO (balise title)", path: p("seoTitle"), required: true, min: 35, max: 65, hint: `Affiché dans Google. « | ${esc(site().brand)} » est ajouté automatiquement. Mot-clé principal au début.` })}
          <button class="link-btn" data-action="copy-field" data-from="${p("title")}" data-to="${p("seoTitle")}">Reprendre le titre</button>
        </div>
        ${field({ label: "Meta description", path: p("description"), rows: 3, min: 120, max: 160, required: true, hint: "Le texte gris sous le titre dans Google. Une promesse concrète + le mot-clé." })}
        <div class="field-with-action">
          ${field({ label: "Extrait (cartes du blog)", path: p("excerpt"), rows: 3, min: 100, max: 260, hint: "Affiché sur la page Blog et dans llms.txt. Peut être un peu plus long que la description." })}
          <button class="link-btn" data-action="copy-field" data-from="${p("description")}" data-to="${p("excerpt")}">Reprendre la description</button>
        </div>
        <div class="field">
          <span class="field-label">Mots-clés <small class="muted">(le premier = mot-clé principal)</small></span>
          <div class="chips" data-chips="${p("keywords")}">
            ${L.keywords.map((k, i) => `<span class="chip ${i === 0 ? "main" : ""}">${esc(k)}<button data-action="chip-remove" data-path="${p("keywords")}" data-index="${i}" aria-label="Retirer">×</button></span>`).join("")}
            <input type="text" data-chip-input="${p("keywords")}" placeholder="Ajouter puis Entrée" />
          </div>
          <small class="hint">3 à 10 expressions que vos clients tapent vraiment. Ex. « audit stratégique », « performance commerciale », « Antibes ».</small>
        </div>
      </section>
      <section class="card">
        <h3>Aperçu Google</h3>
        <div class="serp" data-live="serp-${loc}"></div>
        <h3 class="mt">Aperçu partage (LinkedIn, WhatsApp…)</h3>
        <div class="social" data-live="social-${loc}"></div>
      </section>
      ${loc === "fr" ? navButtons() : ""}`;
  }

  const TOOLBAR = [
    ["h2", "Titre de section (##)", "H2"],
    ["h3", "Sous-titre (###)", "H3"],
    ["bold", "Gras (Ctrl+B)", "<b>G</b>"],
    ["italic", "Italique (Ctrl+I)", "<i>I</i>"],
    ["|"],
    ["link", "Lien (page du site, article, site externe)", "🔗 Lien"],
    ["ul", "Liste à puces", "• Liste"],
    ["quote", "Citation / encadré", "❝ Citation"],
    ["|"],
    ["image", "Image (import ou URL)", "🖼 Image"],
    ["table", "Tableau", "▦ Tableau"],
    ["code", "Bloc de code", "{ } Code"],
    ["|"],
    ["sources", "Section Sources", "📚 Sources"],
    ["template", "Insérer un plan type", "☰ Plan type"],
  ];

  function renderWrite(loc = "fr") {
    const L = state.draft[loc];
    const toolbar = TOOLBAR.map((t) => (t[0] === "|" ? '<span class="sep"></span>' : `<button type="button" class="tool" data-action="md" data-md="${t[0]}" data-loc="${loc}" title="${esc(t[1])}">${t[2]}</button>`)).join("");
    return `${loc === "fr" ? stepHeader("Rédaction", "Le corps de l'article. Utilisez la barre d'outils : titres, listes, liens, images, tableaux, sources. L'aperçu correspond exactement au rendu du site.") : ""}
      ${loc === "en" ? `<div class="note">Écrivez ou collez ici la traduction. <button class="link-btn" data-action="copy-body-en">Copier le texte français comme base</button></div>` : ""}
      <section class="card editor-card">
        <div class="editor-bar">
          <div class="toolbar">${toolbar}</div>
          <div class="seg">
            ${["write", "split", "preview"].map((m) => `<button class="${state.editorMode === m ? "on" : ""}" data-action="editor-mode" data-mode="${m}">${{ write: "Écrire", split: "Côte à côte", preview: "Aperçu" }[m]}</button>`).join("")}
          </div>
        </div>
        <div class="editor mode-${state.editorMode}">
          <textarea id="editor-${loc}" class="md-input" data-bind="${loc}.body" data-editor="${loc}" spellcheck="true" placeholder="Commencez par un paragraphe d'accroche, puis structurez avec des sections ## …">${esc(L.body)}</textarea>
          <div class="md-preview prose" data-live="preview-${loc}"></div>
        </div>
        <div class="editor-foot" data-live="stats-${loc}"></div>
      </section>
      <div class="grid-2">
        <section class="card"><h3>Problèmes de mise en forme</h3><div data-live="lint-${loc}"></div></section>
        <section class="card"><h3>Plan de l'article</h3><div data-live="outline-${loc}"></div></section>
      </div>
      <section class="card">
        <div class="grid-2">
          <div>
            <label class="field"><span class="field-label">Temps de lecture</span>
              <div class="input-group"><input type="text" data-bind="${loc}.readingTime" value="${esc(L.readingTime)}" ${state.draft.autoReading[loc] ? "readonly" : ""} />
              <label class="inline-check"><input type="checkbox" data-bind-check="autoReading.${loc}" ${state.draft.autoReading[loc] ? "checked" : ""}/> auto (200 mots/min)</label></div>
            </label>
          </div>
          <div id="images-box">${renderImagesList()}</div>
        </div>
      </section>
      <details class="card cheat">
        <summary>Syntaxe prise en charge par le site</summary>
        <div class="cheat-grid">
          <div><code>## Titre de section</code><span>H2, apparaît dans le sommaire</span></div>
          <div><code>### Sous-titre</code><span>H3</span></div>
          <div><code>**gras**</code> <code>*italique*</code><span>mise en valeur</span></div>
          <div><code>[texte](/contact)</code><span>lien interne (commence par /)</span></div>
          <div><code>[texte](https://…)</code><span>lien externe (ouvre un nouvel onglet)</span></div>
          <div><code>- élément</code><span>liste à puces (seul format de liste)</span></div>
          <div><code>&gt; citation</code><span>encadré en italique</span></div>
          <div><code>![alt](/images/… "légende")</code><span>image seule sur sa ligne</span></div>
          <div><code>| A | B |</code><br><code>| --- | --- |</code><span>tableau</span></div>
          <div><code>\`\`\`</code><span>bloc de code</span></div>
          <div class="no"><code># Titre</code> <code>1. liste</code> <code>####</code> <code>---</code> <code>&lt;html&gt;</code><span>non pris en charge</span></div>
        </div>
      </details>
      ${loc === "fr" ? navButtons() : ""}`;
  }

  function renderImagesList() {
    const imgs = state.draft.images;
    return `<div class="field"><span class="field-label">Images importées</span>
      ${
        imgs.length
          ? `<ul class="img-list">${imgs
              .map(
                (img, i) => `<li><img src="${img.dataUrl}" alt="" /><div><code>${esc(img.src)}</code><small>${Math.round(img.bytes / 1024)} Ko · ${img.width}×${img.height}</small></div><button class="link-btn danger" data-action="image-remove" data-index="${i}">Retirer</button></li>`
              )
              .join("")}</ul>`
          : '<p class="muted small">Aucune. Le bouton « Image » convertit en WebP, redimensionne (1600 px max) et nomme le fichier pour vous.</p>'
      }</div>`;
  }

  function renderFaq(loc = "fr") {
    const L = state.draft[loc];
    return `${loc === "fr" ? stepHeader("Points clés & FAQ", "Les points clés s'affichent en haut de l'article. La FAQ s'affiche en bas et génère le résultat enrichi « Questions fréquentes » dans Google.") : ""}
      ${loc === "en" ? `<div class="note"><button class="link-btn" data-action="copy-lists-en">Copier les points clés et la FAQ du français comme base</button></div>` : ""}
      <section class="card">
        <h3>À retenir <small class="muted">(3 à 5 phrases courtes)</small></h3>
        ${L.keyTakeaways
          .map(
            (t, i) => `<div class="list-row"><span class="num">${i + 1}</span><input type="text" data-bind="${loc}.keyTakeaways.${i}" value="${esc(t)}" placeholder="Une idée clé, formulée comme une affirmation." />
            <button class="icon-btn" data-action="list-remove" data-path="${loc}.keyTakeaways" data-index="${i}" title="Supprimer">×</button></div>`
          )
          .join("")}
        <button class="btn btn-ghost" data-action="list-add" data-path="${loc}.keyTakeaways" data-kind="text">+ Ajouter un point clé</button>
      </section>
      <section class="card">
        <h3>Questions fréquentes <small class="muted">(3 à 6 questions que vos clients posent vraiment)</small></h3>
        ${L.faq
          .map(
            (f, i) => `<div class="faq-row">
              <div class="faq-head"><span class="num">${i + 1}</span>
                <input type="text" data-bind="${loc}.faq.${i}.question" value="${esc(f.question)}" placeholder="La question, telle qu'on la taperait dans Google ?" />
                <button class="icon-btn" data-action="list-move" data-path="${loc}.faq" data-index="${i}" data-dir="-1" title="Monter">↑</button>
                <button class="icon-btn" data-action="list-move" data-path="${loc}.faq" data-index="${i}" data-dir="1" title="Descendre">↓</button>
                <button class="icon-btn" data-action="list-remove" data-path="${loc}.faq" data-index="${i}" title="Supprimer">×</button>
              </div>
              <textarea rows="3" data-bind="${loc}.faq.${i}.answer" placeholder="Réponse directe en 2 à 4 phrases.">${esc(f.answer)}</textarea>
              ${counterAttrs(`${loc}.faq.${i}.answer`, 40, 400)}
            </div>`
          )
          .join("")}
        <button class="btn btn-ghost" data-action="list-add" data-path="${loc}.faq" data-kind="faq">+ Ajouter une question</button>
      </section>
      ${loc === "fr" ? navButtons() : ""}`;
  }

  function pageOptions(selected) {
    const s = site();
    return `<option value="">(aucun)</option>${s.pages.map((p) => `<option value="${p.path}" ${p.path === selected ? "selected" : ""}>${esc(p.label)} · ${p.path}</option>`).join("")}${
      selected && !s.pages.some((p) => p.path === selected) ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>` : ""
    }`;
  }

  function renderCta(loc) {
    const p = (k) => `${loc}.cta.${k}`;
    const c = state.draft[loc].cta;
    return `<section class="card">
        <h3>Appel à l'action (bloc en bas de l'article)</h3>
        ${field({ label: "Titre", path: p("title"), required: true })}
        ${field({ label: "Texte", path: p("description"), rows: 2 })}
        <div class="grid-2">
          ${field({ label: "Bouton principal", path: p("primaryLabel"), required: true })}
          <label class="field"><span class="field-label">Lien du bouton principal</span><select data-bind="${p("primaryHref")}">${pageOptions(c.primaryHref)}</select></label>
          ${field({ label: "Bouton secondaire", path: p("secondaryLabel") })}
          <label class="field"><span class="field-label">Lien du bouton secondaire</span><select data-bind="${p("secondaryHref")}">${pageOptions(c.secondaryHref)}</select></label>
        </div>
        <small class="hint">Les liens sont automatiquement adaptés à la langue (/en/…). Choisissez la page la plus proche du sujet (offre, formation, approche).</small>
        <div class="mt"><button class="link-btn" data-action="cta-reset" data-loc="${loc}">Remettre l'appel à l'action par défaut</button></div>
      </section>`;
  }

  function renderLinks() {
    const d = state.draft;
    const posts = knownPosts();
    return `${stepHeader("Maillage & appel à l'action", "Relier l'article au reste du site : c'est ce qui aide Google à comprendre vos thèmes et le lecteur à aller plus loin.")}
      <section class="card">
        <h3>Articles liés <small class="muted">(affichés en bas de l'article, 2 recommandés)</small></h3>
        <div class="checklist">
          ${posts
            .map(
              (p) => `<label class="check-item"><input type="checkbox" data-action="toggle-related" value="${esc(p.slug)}" ${d.relatedSlugs.includes(p.slug) ? "checked" : ""}/><span>${esc(p.title)}<small>/blog/${esc(p.slug)}/</small></span></label>`
            )
            .join("") || '<p class="muted">Aucun autre article connu.</p>'}
        </div>
        <p class="hint">Pensez aussi à l'inverse : ajouter ce nouvel article dans les « articles liés » d'un ou deux anciens articles (voir le guide de publication).</p>
      </section>
      ${renderCta("fr")}
      ${navButtons()}`;
  }

  function renderEnglish() {
    const d = state.draft;
    const tabs = [
      ["article", "Article"],
      ["seo", "SEO"],
      ["write", "Rédaction"],
      ["faq", "Points clés & FAQ"],
      ["cta", "Appel à l'action"],
    ];
    const body = !d.enEnabled
      ? `<section class="card"><p>La version anglaise est désactivée : les pages <code>/en/blog/${esc(d.slug || "…")}/</code> afficheront le contenu français. C'est déconseillé pour le SEO international.</p></section>`
      : `<div class="tabs">${tabs.map(([id, label]) => `<button class="${state.enTab === id ? "on" : ""}" data-action="en-tab" data-tab="${id}">${label}</button>`).join("")}</div>
        ${
          state.enTab === "article"
            ? renderArticle("en")
            : state.enTab === "seo"
            ? renderSeo("en")
            : state.enTab === "write"
            ? renderWrite("en")
            : state.enTab === "faq"
            ? renderFaq("en")
            : renderCta("en")
        }`;
    return `${stepHeader("Version anglaise", "Chaque article existe aussi sous /en/. Traduisez tous les champs (un outil de traduction puis une relecture humaine suffit).")}
      <section class="card row-between">
        <label class="switch"><input type="checkbox" data-bind-check="enEnabled" ${d.enEnabled ? "checked" : ""} /><span></span> Publier une version anglaise</label>
        ${d.enEnabled ? '<button class="btn btn-ghost" data-action="copy-all-en">Pré-remplir tout avec le français</button>' : ""}
      </section>
      ${body}
      ${navButtons()}`;
  }

  function renderArticlePreview(loc) {
    const d = state.draft;
    const L = d.enEnabled ? d[loc] : d.fr;
    const body = L.body || d.fr.body;
    const s = site();
    const date = d.publishedAt ? new Date(d.publishedAt).toLocaleDateString(loc === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
    const heads = MD.headings(body).filter((h) => h.level === 2);
    const related = d.relatedSlugs.map((slug) => s.posts.find((p) => p.slug === slug)?.title || slug);
    return `<article class="article-preview">
      <div class="ap-hero">
        <p class="ap-eyebrow">${esc(L.heroEyebrow)}</p>
        <h1>${esc(L.title || "(titre)")}</h1>
        <p class="ap-meta">${esc(L.category)} · ${esc(date)} · ${esc(L.readingTime)}</p>
        <p class="ap-intro">${esc(L.intro)}</p>
      </div>
      <div class="ap-grid">
        <aside class="ap-toc">${heads.length ? `<strong>${loc === "fr" ? "Sommaire" : "Contents"}</strong><ul>${heads.map((h) => `<li>${esc(h.title)}</li>`).join("")}</ul>` : ""}</aside>
        <div>
          ${L.keyTakeaways.filter(Boolean).length ? `<div class="ap-takeaways"><strong>${loc === "fr" ? "À retenir" : "Key takeaways"}</strong><ul>${L.keyTakeaways.filter(Boolean).map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
          <div class="prose">${mdPreview(body)}</div>
          ${L.faq.filter((f) => f.question).length ? `<div class="ap-faq"><h2>${loc === "fr" ? "Questions fréquentes" : "Frequently asked questions"}</h2>${L.faq.filter((f) => f.question).map((f) => `<details><summary>${esc(f.question)}</summary><p>${esc(f.answer)}</p></details>`).join("")}</div>` : ""}
          <div class="ap-cta"><h3>${esc(L.cta.title)}</h3><p>${esc(L.cta.description)}</p><span class="ap-btn">${esc(L.cta.primaryLabel)}</span>${L.cta.secondaryLabel ? `<span class="ap-btn ghost">${esc(L.cta.secondaryLabel)}</span>` : ""}</div>
          ${related.length ? `<div class="ap-related"><strong>${loc === "fr" ? "Articles liés" : "Related articles"}</strong><ul>${related.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}
        </div>
      </div>
    </article>`;
  }

  function renderReview() {
    const checks = computeChecks();
    const total = checks.length;
    const ok = checks.filter((c) => c.level === "ok").length;
    const errors = checks.filter((c) => c.level === "error").length;
    const score = total ? Math.round((ok / total) * 100) : 0;
    return `${stepHeader("Vérification", "Le score résume les contrôles SEO et de mise en forme. Les erreurs (rouge) bloquent l'affichage correct ; les avertissements (orange) sont des recommandations.")}
      <section class="card score-card">
        <div class="score" style="--p:${score}"><span>${score}</span><small>/100</small></div>
        <div>
          <h3>${errors ? `${errors} erreur(s) à corriger avant publication` : score >= 85 ? "Prêt à publier" : "Publiable, mais peut être amélioré"}</h3>
          <p class="muted">${ok} contrôles validés sur ${total}.</p>
        </div>
      </section>
      <section class="card">${checksList(checks, { withLinks: true })}</section>
      <section class="card">
        <div class="row-between"><h3>Aperçu de la page</h3>
          <div class="seg">${["fr", "en"].map((l) => `<button class="${state.previewLocale === l ? "on" : ""}" data-action="preview-locale" data-loc="${l}">${l.toUpperCase()}</button>`).join("")}</div>
        </div>
        <p class="muted small">Mise en page simplifiée : les couleurs, l'ordre des blocs et le texte correspondent au site, pas le détail du design.</p>
        ${renderArticlePreview(state.previewLocale)}
      </section>
      ${navButtons()}`;
  }

  function usedImages() {
    const d = state.draft;
    return d.images.filter((img) => d.fr.body.includes(img.src) || (d.enEnabled && d.en.body.includes(img.src)));
  }

  function renderExport() {
    const d = state.draft;
    const s = site();
    const errors = computeChecks().filter((c) => c.level === "error");
    const file = MD.buildPostFile(d);
    const imgs = usedImages();
    const snippets = MD.llmsSnippets(s, d);
    return `${stepHeader("Télécharger", "Les fichiers prêts à publier. Le fichier .md contient tout : français, anglais, SEO, FAQ.")}
      ${errors.length ? `<section class="card alert"><strong>${errors.length} erreur(s) restent à corriger.</strong> Vous pouvez télécharger quand même, mais l'article risque de mal s'afficher. ${checksList(errors, { withLinks: true })}</section>` : ""}
      <section class="card">
        <div class="row-between">
          <div><h3>1. L'article</h3><p class="muted">À placer dans <code>${s.localFolder}/data/blogs/${esc(d.slug || "slug")}.md</code></p></div>
          <div class="row-actions">
            <button class="btn btn-ghost" data-action="copy-file">Copier</button>
            <button class="btn btn-primary" data-action="download-md" ${d.slug ? "" : "disabled"}>Télécharger ${esc(d.slug || "…")}.md</button>
          </div>
        </div>
        <details><summary>Voir le fichier</summary><pre class="code">${esc(file)}</pre></details>
      </section>
      <section class="card">
        <div class="row-between">
          <div><h3>2. Les images (${imgs.length})</h3><p class="muted">À placer dans <code>${s.localFolder}/public/images/blog/${esc(d.slug || "slug")}/</code></p></div>
          ${imgs.length ? '<button class="btn btn-ghost" data-action="download-images">Tout télécharger</button>' : ""}
        </div>
        ${imgs.length ? `<ul class="img-list">${imgs.map((img, i) => `<li><img src="${img.dataUrl}" alt=""/><div><code>public${esc(img.src)}</code><small>${Math.round(img.bytes / 1024)} Ko</small></div><button class="link-btn" data-action="download-image" data-index="${d.images.indexOf(img)}">Télécharger</button></li>`).join("")}</ul>` : '<p class="muted small">Aucune image importée dans cet article (les images déjà présentes sur le site n\'ont pas besoin d\'être téléchargées).</p>'}
      </section>
      <section class="card">
        <h3>3. Les fichiers pour les assistants IA (llms.txt)</h3>
        <p class="muted">${esc(s.llms.describe)} En publication automatique, c'est fait pour vous.</p>
        ${snippets
          .map(
            (sn, i) => `<div class="snippet"><div class="row-between"><div><code>${sn.file}</code><small>${esc(sn.where)}</small></div><button class="btn btn-ghost" data-action="copy-snippet" data-index="${i}">Copier</button></div><pre class="code">${esc(sn.text)}</pre></div>`
          )
          .join("")}
      </section>
      <section class="card">
        <div class="row-between">
          <div><h3>4. Le brouillon</h3><p class="muted">Pour reprendre l'édition plus tard, sur un autre ordinateur, ou le faire relire.</p></div>
          <button class="btn btn-ghost" data-action="download-draft">Télécharger le brouillon (.json)</button>
        </div>
      </section>
      ${navButtons()}`;
  }

  function code(text) {
    return `<div class="cmd"><pre>${esc(text)}</pre><button class="link-btn" data-action="copy-text" data-text="${esc(text)}">Copier</button></div>`;
  }

  function renderGuide() {
    const d = state.draft;
    const s = site();
    const slug = d.slug || "mon-article";
    const live = `${s.domain}/blog/${slug}/`;
    const liveEn = `${s.domain}/en/blog/${slug}/`;
    const repoUrl = `https://github.com/${s.repo}`;
    const files = [`data/blogs/${slug}.md`, ...(usedImages().length ? [`public/images/blog/${slug}/`] : []), ...s.llms.files].join(" ");
    return `<ol class="guide">
        <li><h4>Télécharger les fichiers</h4><p>À l'étape « Télécharger » : le fichier <code>${esc(slug)}.md</code>, les images éventuelles, et copier les lignes pour llms.</p></li>
        <li><h4>Placer l'article</h4><p>Copiez <code>${esc(slug)}.md</code> dans <code>${s.localFolder}/data/blogs/</code>. Le nom du fichier doit être exactement le slug.</p></li>
        ${usedImages().length ? `<li><h4>Placer les images</h4><p>Créez le dossier <code>${s.localFolder}/public/images/blog/${esc(slug)}/</code> et mettez-y les images téléchargées, sans les renommer.</p></li>` : ""}
        <li><h4>Mettre à jour llms.txt</h4><p>${esc(s.llms.describe)} Collez les lignes fournies à l'étape « Télécharger ». Ces fichiers aident ChatGPT, Claude, Perplexity… à connaître et citer vos articles.</p></li>
        <li><h4>Vérifier en local (recommandé)</h4>
          ${code(`cd ${s.localFolder}\npnpm install\npnpm dev`)}
          <p>Ouvrez <code>http://localhost:3000/blog/${esc(slug)}/</code> et <code>http://localhost:3000/en/blog/${esc(slug)}/</code>. Puis vérifiez que le site se construit sans erreur :</p>
          ${code("pnpm build")}
          <p class="muted small">Une erreur « JSON » au build signifie en général un fichier .md modifié à la main avec une virgule ou un guillemet en trop : réimportez-le ici pour le corriger.</p>
        </li>
        <li><h4>Envoyer sur GitHub</h4>
          ${code(`git add ${files}\ngit commit -m "Blog : ${(d.fr.title || slug).replace(/"/g, "'")}"\ngit push origin ${s.branch}`)}
          <p>Le push sur <code>${s.branch}</code> déclenche la mise en ligne automatique.</p>
        </li>
        <li><h4>Suivre la mise en ligne</h4><p>Dans <a href="${repoUrl}/actions" target="_blank" rel="noopener">l'onglet Actions du dépôt</a>, le workflow « Deploy Next.js site to Pages » doit passer au vert (2 à 4 minutes). En rouge : ouvrez-le, l'erreur est dans l'étape « Build ».</p></li>
        <li><h4>Vérifier la page en ligne</h4>
          <ul class="checks plain">
            <li>La page : <a href="${live}" target="_blank" rel="noopener">${live}</a> et <a href="${liveEn}" target="_blank" rel="noopener">version anglaise</a></li>
            <li>L'article apparaît sur la page <a href="${s.domain}/blog/" target="_blank" rel="noopener">Blog</a>${s.id === "vhc" ? " et dans la section « Analyses » de l'accueil" : ""}</li>
            <li>Le <a href="${s.domain}/sitemap.xml" target="_blank" rel="noopener">sitemap.xml</a> contient <code>/blog/${esc(slug)}/</code> (automatique)</li>
            <li>Les données structurées : <a href="https://search.google.com/test/rich-results?url=${encodeURIComponent(live)}" target="_blank" rel="noopener">Test des résultats enrichis Google</a> (Article, FAQ, fil d'Ariane)</li>
            <li>La vitesse : <a href="https://pagespeed.web.dev/analysis?url=${encodeURIComponent(live)}" target="_blank" rel="noopener">PageSpeed Insights</a></li>
          </ul>
        </li>
        <li><h4>Demander l'indexation à Google</h4><p>Dans <a href="https://search.google.com/search-console" target="_blank" rel="noopener">Google Search Console</a> : barre du haut « Inspecter l'URL », collez <code>${live}</code>, puis « Demander l'indexation ». Faites de même pour la version anglaise. (Le sitemap est déjà déclaré : inutile de le renvoyer.)</p></li>
        <li><h4>Renforcer le maillage</h4><p>Ajoutez <code>"${esc(slug)}"</code> dans <code>relatedSlugs</code> d'un ou deux anciens articles proches (importez-les ici via « Modifier un article publié »), et si possible un lien vers ce nouvel article dans une page du site.</p></li>
        <li><h4>Diffuser</h4><p>Partagez l'article sur <a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(live)}" target="_blank" rel="noopener">LinkedIn</a> et dans votre fiche Google Business Profile (« Ajouter une actualité »). Les premiers visiteurs aident l'indexation.</p></li>
      </ol>
      <section class="card soft">
        <h3>Ce qui est automatique (rien à faire)</h3>
        <ul class="checks plain">
          <li>Page française <code>/blog/${esc(slug)}/</code> et anglaise <code>/en/blog/${esc(slug)}/</code>, avec balises hreflang entre les deux</li>
          <li>Ajout au <code>sitemap.xml</code>, à la page Blog et aux articles liés</li>
          <li>Balises title, meta description, canonical, Open Graph et Twitter</li>
          <li>Données structurées JSON-LD : Article, FAQPage, BreadcrumbList</li>
          <li>Sommaire construit depuis les titres ##</li>
        </ul>
      </section>
      <section class="card soft">
        <h3>Modifier ou supprimer un article plus tard</h3>
        <ul class="checks plain">
          <li><strong>Modifier :</strong> « Démarrer » → « Modifier un article publié », corrigez, mettez à jour la date « Mis à jour le », republiez. Gardez le même slug.</li>
          <li><strong>Supprimer :</strong> supprimez <code>data/blogs/${esc(slug)}.md</code>, retirez le slug des <code>relatedSlugs</code> des autres articles et les lignes llms, puis poussez. Si l'article avait du trafic, préférez le mettre à jour plutôt que le supprimer.</li>
        </ul>
      </section>
      ${s.notes.length ? `<section class="card soft"><h3>Spécificités de ce site</h3><ul class="checks plain">${s.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></section>` : ""}`;
  }

  function ghSettings() {
    const s = site();
    const key = `bpc.gh.${s.id}`;
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(key) || "null") || JSON.parse(localStorage.getItem(key) || "null");
    } catch {}
    return { repo: s.repo, branch: s.branch, token: "", remember: false, mode: "direct", llms: true, ...(saved || {}) };
  }

  function saveGhSettings(cfg) {
    const key = `bpc.gh.${site().id}`;
    try {
      sessionStorage.setItem(key, JSON.stringify(cfg));
      if (cfg.remember) localStorage.setItem(key, JSON.stringify(cfg));
      else localStorage.removeItem(key);
    } catch {}
  }

  function plannedFiles() {
    const d = state.draft;
    const s = site();
    const cfg = ghSettings();
    return [
      { path: `data/blogs/${d.slug}.md`, what: d.editingExisting ? "article (mise à jour)" : "article" },
      ...usedImages().map((img) => ({ path: `public${img.src}`, what: "image" })),
      ...(cfg.llms ? s.llms.files.map((f) => ({ path: f, what: "mis à jour avec l'article" })) : []),
    ];
  }

  function renderAuto() {
    const s = site();
    const d = state.draft;
    const cfg = ghSettings();
    const g = state.gh;
    const errors = computeChecks().filter((c) => c.level === "error");
    return `<section class="card soft">
        <h3>Comment ça marche</h3>
        <p>Cette page parle directement à l'API GitHub depuis votre navigateur : elle crée <strong>un seul commit</strong> contenant l'article, ses images et les fichiers llms mis à jour, sur le dépôt du site. Le push déclenche ensuite la mise en ligne comme d'habitude. Aucun serveur intermédiaire : le jeton ne quitte votre navigateur que pour aller chez GitHub.</p>
        <details><summary>Créer un jeton (2 minutes, une fois)</summary>
          <ol class="small-steps">
            <li>Connecté au compte propriétaire du dépôt, ouvrez <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token</a>.</li>
            <li>Nom : « Blog builder ». Expiration : 90 jours (à renouveler).</li>
            <li><strong>Repository access</strong> : « Only select repositories » → <code>${esc(s.repo)}</code> uniquement.</li>
            <li><strong>Permissions → Repository</strong> : <code>Contents : Read and write</code> (obligatoire). Facultatif : <code>Pull requests : Read and write</code> (mode relecture) et <code>Actions : Read-only</code> (suivi de la mise en ligne).</li>
            <li>« Generate token », copiez-le (commence par <code>github_pat_</code>) et collez-le ci-dessous.</li>
          </ol>
          <p class="muted small">Sécurité : n'utilisez jamais un jeton « classic » avec tous les droits. Par défaut le jeton est oublié à la fermeture de l'onglet. Ne cochez « Se souvenir » que sur votre ordinateur personnel. En cas de doute, révoquez-le sur la même page GitHub.</p>
        </details>
      </section>
      <section class="card">
        <h3>Connexion</h3>
        <div class="grid-3">
          <label class="field"><span class="field-label">Dépôt (propriétaire/nom)</span><input type="text" data-gh="repo" value="${esc(cfg.repo)}" /></label>
          <label class="field"><span class="field-label">Branche de publication</span><input type="text" data-gh="branch" value="${esc(cfg.branch)}" /></label>
          <label class="field"><span class="field-label">Jeton GitHub</span><input type="password" data-gh="token" value="${esc(cfg.token)}" placeholder="github_pat_…" autocomplete="off" /></label>
        </div>
        <div class="row-between">
          <label class="inline-check"><input type="checkbox" data-gh="remember" ${cfg.remember ? "checked" : ""}/> Se souvenir du jeton sur cet appareil</label>
          <button class="btn btn-ghost" data-action="gh-check">Tester la connexion</button>
        </div>
        <div id="gh-check-result">${g.checked ? `<p class="check check-ok"><span class="dot"></span>${esc(g.checked)}</p>` : ""}</div>
      </section>
      <section class="card">
        <h3>Publication</h3>
        <div class="radio-row">
          <label class="radio"><input type="radio" name="gh-mode" data-gh="mode" value="direct" ${cfg.mode === "direct" ? "checked" : ""}/><span><strong>Publier directement</strong><small>Commit sur <code>${esc(cfg.branch)}</code> : en ligne en 2 à 4 minutes.</small></span></label>
          <label class="radio"><input type="radio" name="gh-mode" data-gh="mode" value="pr" ${cfg.mode === "pr" ? "checked" : ""}/><span><strong>Proposer pour relecture</strong><small>Crée une branche et une pull request : rien n'est en ligne avant validation (« Merge »).</small></span></label>
        </div>
        <label class="inline-check"><input type="checkbox" data-gh="llms" ${cfg.llms ? "checked" : ""}/> Mettre à jour automatiquement ${s.llms.files.map((f) => `<code>${f}</code>`).join(" et ")}</label>
        <h4 class="mt">Fichiers qui seront écrits</h4>
        <ul class="file-list">${plannedFiles().map((f) => `<li><code>${esc(f.path)}</code><small>${esc(f.what)}</small></li>`).join("")}</ul>
        ${errors.length ? `<p class="check check-error"><span class="dot"></span>${errors.length} erreur(s) à corriger avant de publier (étape « Vérification »).</p>` : ""}
        <div class="row-actions mt">
          <button class="btn btn-primary" data-action="gh-publish" ${g.running || errors.length || !d.slug ? "disabled" : ""}>${cfg.mode === "pr" ? "Créer la pull request" : "Publier sur le site"}</button>
        </div>
        <ol class="gh-log">${g.log.map((l) => `<li class="log-${l.kind}">${l.html}</li>`).join("")}</ol>
      </section>`;
  }

  function renderPublish() {
    return `${stepHeader("Publier", "Deux façons de mettre l'article en ligne : à la main en suivant le guide, ou automatiquement depuis cette page avec un jeton GitHub.")}
      <div class="tabs">
        <button class="${state.publishTab === "guide" ? "on" : ""}" data-action="publish-tab" data-tab="guide">Guide pas à pas</button>
        <button class="${state.publishTab === "auto" ? "on" : ""}" data-action="publish-tab" data-tab="auto">Publication automatique</button>
      </div>
      ${state.publishTab === "guide" ? renderGuide() : renderAuto()}
      ${navButtons()}`;
  }

  /* ---------------- live updates ---------------- */

  function renderSerp(loc) {
    const d = state.draft;
    const s = site();
    const L = d[loc];
    const title = `${L.seoTitle || L.title || "Titre SEO"} | ${s.brand}`;
    const host = s.domain.replace("https://", "");
    const crumbs = loc === "fr" ? `${host} › blog › ${d.slug || "…"}` : `${host} › en › blog › ${d.slug || "…"}`;
    const desc = L.description || "La meta description apparaîtra ici.";
    return `<div class="serp-site"><span class="serp-fav" style="background:${s.theme.ink}"></span><div><strong>${esc(s.brand)}</strong><small>${esc(crumbs)}</small></div></div>
      <div class="serp-title">${esc(title.length > 62 ? title.slice(0, 60) + "…" : title)}</div>
      <div class="serp-desc">${esc(desc.length > 160 ? desc.slice(0, 157) + "…" : desc)}</div>
      <small class="muted">Titre complet : ${title.length} caractères (Google coupe vers 60).</small>`;
  }

  function renderSocial(loc) {
    const s = site();
    const L = state.draft[loc];
    const og = s.id === "vhc" ? `${s.previewDomain}/og-vhc.jpg` : `${s.previewDomain}/karen-${loc}.png`;
    return `<div class="og-img" style="background-image:url('${og}')"></div>
      <div class="og-body"><small>${esc(s.domain.replace("https://", "").toUpperCase())}</small><strong>${esc(`${L.seoTitle || L.title || "Titre"} | ${s.brand}`)}</strong><span>${esc(L.description)}</span></div>`;
  }

  function refreshLive() {
    const d = state.draft;
    $$("[data-counter]").forEach((el) => {
      const v = String(getPath(d, el.dataset.counter) || "");
      const n = v.trim().length;
      const min = +el.dataset.min, max = +el.dataset.max;
      el.textContent = `${n}/${max}`;
      el.className = `counter ${n === 0 ? "" : n < min || n > max ? "bad" : "good"}`;
    });
    ["fr", "en"].forEach((loc) => {
      const L = d[loc];
      const serp = $(`[data-live="serp-${loc}"]`);
      if (serp) serp.innerHTML = renderSerp(loc);
      const social = $(`[data-live="social-${loc}"]`);
      if (social) social.innerHTML = renderSocial(loc);
      const preview = $(`[data-live="preview-${loc}"]`);
      if (preview) preview.innerHTML = mdPreview(L.body) || '<p class="muted">L\'aperçu apparaîtra ici.</p>';
      const stats = $(`[data-live="stats-${loc}"]`);
      if (stats) {
        const words = MD.wordCount(L.body);
        const h = MD.headings(L.body);
        const links = (L.body.match(/\]\(/g) || []).length;
        stats.innerHTML = `<span><b>${words}</b> mots</span><span><b>${h.filter((x) => x.level === 2).length}</b> sections</span><span><b>${links}</b> liens et images</span><span>≈ <b>${readingTimeFor(L.body) || "0 min"}</b> de lecture</span>`;
      }
      const lint = $(`[data-live="lint-${loc}"]`);
      if (lint) {
        const issues = MD.lint(L.body, { noEmDash: true });
        lint.innerHTML = issues.length
          ? `<ul class="checks">${issues.map((i) => `<li class="check check-${i.level}"><span class="dot"></span><span><button class="link-btn" data-action="goto-line" data-loc="${loc}" data-line="${i.n}">Ligne ${i.n}</button> ${esc(i.msg)}</span></li>`).join("")}</ul>`
          : '<p class="check check-ok"><span class="dot"></span>Aucun problème : tout s\'affichera correctement.</p>';
      }
      const outline = $(`[data-live="outline-${loc}"]`);
      if (outline) {
        const h = MD.headings(L.body);
        outline.innerHTML = h.length ? `<ul class="outline">${h.map((x) => `<li class="lvl${x.level}">${esc(x.title)}</li>`).join("")}</ul>` : '<p class="muted small">Ajoutez des titres ## pour structurer l\'article et générer le sommaire.</p>';
      }
    });
    renderSidebarStatus();
    const aside = $("#aside-checks");
    if (aside) {
      const mine = computeChecks().filter((c) => c.step === state.step);
      aside.innerHTML = mine.length ? checksList(mine) : '<p class="muted small">Pas de contrôle pour cette étape.</p>';
    }
  }

  let liveTimer = null;
  function scheduleLive() {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(refreshLive, 120);
  }

  function renderSidebarStatus() {
    const checks = computeChecks();
    $$(".steps [data-step]").forEach((el) => {
      const st = stepStatus(el.dataset.step, checks);
      el.dataset.status = st;
    });
  }

  /* ---------------- main render ---------------- */

  const RENDERERS = {
    start: renderStart,
    article: () => renderArticle("fr"),
    seo: () => renderSeo("fr"),
    write: () => renderWrite("fr"),
    faq: () => renderFaq("fr"),
    links: renderLinks,
    english: renderEnglish,
    review: renderReview,
    export: renderExport,
    publish: renderPublish,
  };

  function applyTheme() {
    const s = site();
    const root = document.documentElement;
    root.style.setProperty("--ink", s.theme.ink);
    root.style.setProperty("--accent", s.theme.accent);
    root.style.setProperty("--soft", s.theme.soft);
    root.style.setProperty("--paper", s.theme.paper);
    $("#site-name").textContent = s.name;
  }

  function renderSidebar() {
    $("#steps").innerHTML = STEPS.map(
      (s, i) => `<li><button data-action="go" data-step="${s.id}" class="${state.step === s.id ? "active" : ""}"><span class="step-num">${i + 1}</span><span class="step-text"><strong>${s.label}</strong><small>${s.hint}</small></span><span class="step-dot"></span></button></li>`
    ).join("");
  }

  function render({ keepScroll = false } = {}) {
    const main = $("#main");
    const scroll = window.scrollY;
    main.innerHTML = RENDERERS[state.step]();
    renderSidebar();
    const stepInfo = STEPS.find((s) => s.id === state.step);
    $("#aside-title").textContent = `Contrôles · ${stepInfo.label}`;
    refreshLive();
    if (keepScroll) window.scrollTo(0, scroll);
    else window.scrollTo(0, 0);
    try {
      sessionStorage.setItem(STORE_STEP, state.step);
    } catch {}
  }

  function go(step) {
    state.step = step;
    render();
  }

  /* ---------------- editor helpers ---------------- */

  function activeEditor(loc) {
    return $(`#editor-${loc}`);
  }

  function commitEditor(ta) {
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
  }

  function wrapSelection(ta, before, after, placeholder) {
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const sel = value.slice(a, b) || placeholder;
    ta.value = value.slice(0, a) + before + sel + after + value.slice(b);
    ta.selectionStart = a + before.length;
    ta.selectionEnd = a + before.length + sel.length;
    commitEditor(ta);
  }

  function prefixLines(ta, prefix, placeholder) {
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const lineStart = value.lastIndexOf("\n", a - 1) + 1;
    const lineEndIdx = value.indexOf("\n", b);
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const block = value.slice(lineStart, lineEnd) || placeholder;
    const replaced = block
      .split("\n")
      .map((l) => prefix + l.replace(/^(#{1,6}\s|-\s|>\s)/, ""))
      .join("\n");
    ta.value = value.slice(0, lineStart) + replaced + value.slice(lineEnd);
    ta.selectionStart = lineStart;
    ta.selectionEnd = lineStart + replaced.length;
    commitEditor(ta);
  }

  function insertBlock(ta, block, { atEnd = false } = {}) {
    const value = ta.value;
    const pos = atEnd ? value.length : ta.selectionEnd;
    const before = value.slice(0, pos);
    const after = value.slice(pos);
    const pre = before.length === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const post = after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : after.length ? "\n\n" : "\n";
    ta.value = before + pre + block + post + after;
    const caret = (before + pre + block).length;
    ta.selectionStart = ta.selectionEnd = caret;
    commitEditor(ta);
  }

  /* ---------------- modals ---------------- */

  function openModal({ title, body, submitLabel = "Insérer", onOpen, onSubmit, wide = false }) {
    const dlg = $("#modal");
    dlg.className = wide ? "wide" : "";
    dlg.innerHTML = `<form method="dialog" class="modal-form">
      <header><h3>${title}</h3><button type="button" class="icon-btn" data-close aria-label="Fermer">×</button></header>
      <div class="modal-body">${body}</div>
      <footer><button type="button" class="btn btn-ghost" data-close>Annuler</button><button type="submit" class="btn btn-primary">${submitLabel}</button></footer>
    </form>`;
    const form = $("form", dlg);
    $$("[data-close]", dlg).forEach((b) => b.addEventListener("click", () => dlg.close()));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const keep = await onSubmit(form);
        if (keep !== false) dlg.close();
      } catch (error) {
        toast(error.message, "error");
      }
    });
    dlg.showModal();
    onOpen?.(dlg);
  }

  function linkModal(ta, loc) {
    const s = site();
    const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    const posts = [...s.posts, ...(state.remoteSlugs[s.id] || []).filter((x) => !s.posts.some((p) => p.slug === x)).map((x) => ({ slug: x, title: x }))].filter((p) => p.slug !== state.draft.slug);
    openModal({
      title: "Insérer un lien",
      body: `<label class="field"><span class="field-label">Texte du lien</span><input name="text" value="${esc(selected)}" required placeholder="ex. notre audit stratégique" /></label>
        <div class="radio-row compact">
          <label class="radio"><input type="radio" name="kind" value="page" checked /><span>Page du site</span></label>
          <label class="radio"><input type="radio" name="kind" value="post" /><span>Article du blog</span></label>
          <label class="radio"><input type="radio" name="kind" value="url" /><span>Site externe / source</span></label>
        </div>
        <label class="field" data-kind="page"><span class="field-label">Page</span><select name="page">${s.pages.map((p) => `<option value="${p.path}">${esc(p.label)} · ${p.path}</option>`).join("")}</select></label>
        <label class="field" data-kind="post" hidden><span class="field-label">Article</span><select name="post">${posts.map((p) => `<option value="/blog/${p.slug}">${esc(p.title)}</option>`).join("")}</select></label>
        <label class="field" data-kind="url" hidden><span class="field-label">Adresse complète</span><input name="url" type="url" placeholder="https://…" /></label>
        <p class="hint">Liens internes : utiles au SEO et à la navigation. Liens externes : citez des sources fiables (études, chiffres officiels). Le lien s'adapte à la version anglaise automatiquement pour les pages du site.</p>`,
      onOpen(dlg) {
        $$("input[name=kind]", dlg).forEach((r) =>
          r.addEventListener("change", () => $$("[data-kind]", dlg).forEach((el) => (el.hidden = el.dataset.kind !== r.value)))
        );
      },
      onSubmit(form) {
        const f = new FormData(form);
        const kind = f.get("kind");
        let href = kind === "page" ? f.get("page") : kind === "post" ? f.get("post") : String(f.get("url") || "").trim();
        // Internal links end with / to match the static export (no redirect hop).
        if (kind !== "url" && href !== "/" && !href.endsWith("/")) href += "/";
        if (!href) throw new Error("Indiquez une adresse.");
        if (kind === "url" && !/^https?:\/\//.test(href)) throw new Error("L'adresse externe doit commencer par https://");
        const text = String(f.get("text")).trim().replace(/[\[\]]/g, "");
        const { selectionStart: a, selectionEnd: b, value } = ta;
        ta.value = value.slice(0, a) + `[${text}](${href})` + value.slice(b);
        ta.selectionStart = ta.selectionEnd = a + text.length + href.length + 4;
        commitEditor(ta);
      },
    });
  }

  function fileToWebp(file, maxWidth = 1600, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        let dataUrl = canvas.toDataURL("image/webp", quality);
        let ext = "webp";
        if (!dataUrl.startsWith("data:image/webp")) {
          dataUrl = canvas.toDataURL("image/jpeg", quality);
          ext = "jpg";
        }
        const bytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
        resolve({ dataUrl, width: w, height: h, bytes, ext });
      };
      img.onerror = () => reject(new Error("Image illisible."));
      img.src = url;
    });
  }

  function imageModal(ta, loc) {
    const d = state.draft;
    if (!d.slug) {
      toast("Renseignez d'abord le titre (le slug sert à nommer le dossier des images).", "error");
      return;
    }
    let processed = null;
    openModal({
      title: "Insérer une image",
      wide: true,
      body: `<div class="radio-row compact">
          <label class="radio"><input type="radio" name="src" value="upload" checked /><span>Importer depuis l'ordinateur</span></label>
          <label class="radio"><input type="radio" name="src" value="site" /><span>Image déjà sur le site</span></label>
          <label class="radio"><input type="radio" name="src" value="url" /><span>Adresse web</span></label>
        </div>
        <div data-src="upload">
          <label class="drop"><input type="file" name="file" accept="image/*" hidden /><strong>Choisir une image</strong><span>JPG, PNG ou WebP. Convertie en WebP, 1600 px de large maximum.</span></label>
          <div class="img-preview" id="img-preview"></div>
        </div>
        <label class="field" data-src="site" hidden><span class="field-label">Chemin dans public/</span><input name="sitepath" placeholder="/images/conseil-analyse.webp" /></label>
        <label class="field" data-src="url" hidden><span class="field-label">Adresse de l'image</span><input name="url" type="url" placeholder="https://…" /><small class="hint">Déconseillé : l'image peut disparaître. Préférez l'import.</small></label>
        <label class="field"><span class="field-label">Texte alternatif (alt) <b class="req">*</b></span><input name="alt" required placeholder="Décrivez ce que montre l'image, en une phrase." /><small class="hint">Lu par les lecteurs d'écran et Google Images. Pas « image de… ».</small></label>
        <label class="field"><span class="field-label">Légende (facultatif)</span><input name="caption" placeholder="Source, crédit ou commentaire affiché sous l'image" /></label>
        <label class="field" data-src="upload"><span class="field-label">Nom du fichier</span><div class="input-group"><span class="prefix">/images/blog/${esc(d.slug)}/</span><input name="filename" placeholder="auto depuis le texte alternatif" /></div></label>
        <label class="field"><span class="field-label">Lien au clic (facultatif)</span><input name="href" type="url" placeholder="https://…" /></label>`,
      onOpen(dlg) {
        $$("input[name=src]", dlg).forEach((r) =>
          r.addEventListener("change", () => $$("[data-src]", dlg).forEach((el) => (el.hidden = el.dataset.src !== r.value)))
        );
        $("input[name=file]", dlg).addEventListener("change", async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          $("#img-preview").innerHTML = '<p class="muted">Conversion…</p>';
          processed = await fileToWebp(file);
          $("#img-preview").innerHTML = `<img src="${processed.dataUrl}" alt="" /><small>${processed.width}×${processed.height} · ${Math.round(processed.bytes / 1024)} Ko (${processed.ext.toUpperCase()})${processed.bytes > 400000 ? " · un peu lourd, essayez une image plus petite" : ""}</small>`;
          const fn = $("input[name=filename]", dlg);
          if (!fn.value) fn.value = slugify(file.name.replace(/\.[^.]+$/, ""), true);
        });
      },
      onSubmit(form) {
        const f = new FormData(form);
        const kind = f.get("src");
        const alt = String(f.get("alt")).trim().replace(/[\[\]]/g, "");
        const caption = String(f.get("caption") || "").trim().replace(/"/g, "'");
        const href = String(f.get("href") || "").trim();
        let src;
        if (kind === "upload") {
          if (!processed) throw new Error("Choisissez une image.");
          const base = slugify(String(f.get("filename") || "") || alt, true) || `image-${d.images.length + 1}`;
          src = `/images/blog/${d.slug}/${base}.${processed.ext}`;
          d.images = d.images.filter((img) => img.src !== src);
          d.images.push({ src, dataUrl: processed.dataUrl, bytes: processed.bytes, width: processed.width, height: processed.height });
        } else if (kind === "site") {
          src = String(f.get("sitepath")).trim();
          if (!src.startsWith("/")) throw new Error("Le chemin doit commencer par / (ex. /images/photo.webp).");
        } else {
          src = String(f.get("url")).trim();
          if (!/^https?:\/\//.test(src)) throw new Error("L'adresse doit commencer par https://");
        }
        let md = `![${alt}](${src}${caption ? ` "${caption}"` : ""})`;
        if (href) md = `[${md}](${href})`;
        insertBlock(ta, md);
        scheduleSave();
        const box = $("#images-box");
        if (box) box.innerHTML = renderImagesList();
      },
    });
  }

  function tableModal(ta) {
    let rows = 3, cols = 3;
    let grid = [["Colonne 1", "Colonne 2", "Colonne 3"], ["", "", ""], ["", "", ""]];
    const drawGrid = (dlg) => {
      const host = $("#grid", dlg);
      host.style.gridTemplateColumns = `repeat(${cols}, minmax(110px, 1fr))`;
      host.innerHTML = Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => `<input data-r="${r}" data-c="${c}" class="${r === 0 ? "th" : ""}" value="${esc(grid[r]?.[c] || "")}" placeholder="${r === 0 ? "En-tête" : ""}" />`).join("")
      ).join("");
      $$("input", host).forEach((inp) =>
        inp.addEventListener("input", () => {
          grid[inp.dataset.r] = grid[inp.dataset.r] || [];
          grid[inp.dataset.r][inp.dataset.c] = inp.value;
        })
      );
    };
    openModal({
      title: "Insérer un tableau",
      wide: true,
      body: `<div class="grid-3 tight">
          <label class="field"><span class="field-label">Lignes (avec l'en-tête)</span><input type="number" name="rows" min="2" max="30" value="3" /></label>
          <label class="field"><span class="field-label">Colonnes</span><input type="number" name="cols" min="2" max="8" value="3" /></label>
        </div>
        <div class="table-grid" id="grid"></div>
        <details class="mt"><summary>Coller depuis Excel, Google Sheets ou Word</summary>
          <textarea name="paste" rows="5" placeholder="Copiez les cellules dans le tableur puis collez-les ici"></textarea>
          <button type="button" class="btn btn-ghost mt" data-paste>Remplir le tableau</button>
        </details>
        <p class="hint">La première ligne devient l'en-tête. Gardez des cellules courtes : sur mobile, le tableau défile horizontalement.</p>`,
      onOpen(dlg) {
        drawGrid(dlg);
        const resize = () => {
          rows = Math.max(2, Math.min(30, +$("input[name=rows]", dlg).value || 2));
          cols = Math.max(2, Math.min(8, +$("input[name=cols]", dlg).value || 2));
          drawGrid(dlg);
        };
        $("input[name=rows]", dlg).addEventListener("change", resize);
        $("input[name=cols]", dlg).addEventListener("change", resize);
        $("[data-paste]", dlg).addEventListener("click", () => {
          const text = $("textarea[name=paste]", dlg).value.trim();
          if (!text) return;
          grid = text.split(/\r?\n/).map((line) => line.split(line.includes("\t") ? "\t" : /\s*[;|]\s*/));
          rows = Math.min(30, grid.length);
          cols = Math.min(8, Math.max(...grid.map((r) => r.length)));
          $("input[name=rows]", dlg).value = rows;
          $("input[name=cols]", dlg).value = cols;
          drawGrid(dlg);
        });
      },
      onSubmit() {
        const clean = (v) => String(v || "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
        const lines = [];
        for (let r = 0; r < rows; r++) {
          const cells = Array.from({ length: cols }, (_, c) => clean(grid[r]?.[c]) || (r === 0 ? `Colonne ${c + 1}` : ""));
          lines.push(`| ${cells.join(" | ")} |`);
          if (r === 0) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
        }
        insertBlock(ta, lines.join("\n"));
      },
    });
  }

  function sourcesModal(ta, loc) {
    const rowsHtml = (n) => Array.from({ length: n }, (_, i) => `<div class="grid-2 tight src-row"><input name="label${i}" placeholder="Auteur, titre, média, année" /><input name="url${i}" type="url" placeholder="https://…" /></div>`).join("");
    let count = 3;
    openModal({
      title: "Section « Sources »",
      wide: true,
      body: `<p class="hint">Citer ses sources renforce la crédibilité (critère E-E-A-T de Google) et la reprise par les assistants IA. La section est ajoutée à la fin de l'article.</p>
        <div id="src-rows">${rowsHtml(count)}</div>
        <button type="button" class="btn btn-ghost" data-more>+ Une source</button>`,
      onOpen(dlg) {
        $("[data-more]", dlg).addEventListener("click", () => {
          $("#src-rows", dlg).insertAdjacentHTML("beforeend", rowsHtml(1).replace(/label0/g, `label${count}`).replace(/url0/g, `url${count}`));
          count++;
        });
      },
      onSubmit(form) {
        const f = new FormData(form);
        const items = [];
        for (let i = 0; i < count; i++) {
          const label = String(f.get(`label${i}`) || "").trim().replace(/[\[\]]/g, "");
          const url = String(f.get(`url${i}`) || "").trim();
          if (label && url) items.push(`- [${label}](${url})`);
          else if (label) items.push(`- ${label}`);
        }
        if (!items.length) throw new Error("Ajoutez au moins une source.");
        const heading = loc === "fr" ? "## Sources" : "## Sources";
        if (ta.value.includes(`\n${heading}\n`) || ta.value.startsWith(`${heading}\n`)) {
          insertBlock(ta, items.join("\n"), { atEnd: true });
        } else {
          insertBlock(ta, `${heading}\n\n${items.join("\n")}`, { atEnd: true });
        }
      },
    });
  }

  const TEMPLATE = {
    fr: `Paragraphe d'accroche : la situation concrète que vit le lecteur, en 3 ou 4 phrases.

## Le constat : ce qui se passe vraiment

Expliquez le problème, avec un chiffre ou une source si possible.

## Pourquoi cela arrive

- Cause 1
- Cause 2
- Cause 3

## Comment agir

### Première piste

Conseil concret et applicable.

### Deuxième piste

Conseil concret et applicable.

## Ce qu'il faut retenir

Synthèse en 2 ou 3 phrases et ouverture vers l'accompagnement.

## Sources

- [Titre de la source](https://…)`,
    en: `Hook paragraph: the concrete situation the reader is in, in 3 or 4 sentences.

## The reality: what is really happening

Explain the problem, with a figure or a source if possible.

## Why it happens

- Cause 1
- Cause 2
- Cause 3

## How to act

### First lever

Concrete, actionable advice.

### Second lever

Concrete, actionable advice.

## Key points

A 2 or 3 sentence summary, leading to how you can help.

## Sources

- [Source title](https://…)`,
  };

  function mdAction(kind, loc) {
    const ta = activeEditor(loc);
    if (!ta) return;
    switch (kind) {
      case "h2": return prefixLines(ta, "## ", "Titre de section");
      case "h3": return prefixLines(ta, "### ", "Sous-titre");
      case "bold": return wrapSelection(ta, "**", "**", "texte en gras");
      case "italic": return wrapSelection(ta, "*", "*", "texte en italique");
      case "ul": return prefixLines(ta, "- ", "Élément de liste");
      case "quote": return prefixLines(ta, "> ", "Citation ou point important");
      case "code": return insertBlock(ta, "```\n" + (ta.value.slice(ta.selectionStart, ta.selectionEnd) || "code") + "\n```");
      case "link": return linkModal(ta, loc);
      case "image": return imageModal(ta, loc);
      case "table": return tableModal(ta);
      case "sources": return sourcesModal(ta, loc);
      case "template":
        if (ta.value.trim() && !confirm("Insérer le plan type à la position du curseur ?")) return;
        return insertBlock(ta, TEMPLATE[loc]);
    }
  }

  /* ---------------- import ---------------- */

  function importPostText(text, siteId = state.draft.site) {
    const { front, bodies } = MD.parsePostFile(text);
    const s = SITES[siteId];
    const d = newDraft(siteId);
    const en = front.locales?.en || {};
    const pick = (src, base) => ({
      category: src.category ?? base.category ?? "",
      title: src.title ?? base.title ?? "",
      seoTitle: src.seoTitle ?? base.seoTitle ?? "",
      description: src.description ?? base.description ?? "",
      excerpt: src.excerpt ?? base.excerpt ?? "",
      readingTime: src.readingTime ?? base.readingTime ?? "",
      keywords: [...(src.keywords ?? base.keywords ?? [])],
      heroEyebrow: src.heroEyebrow ?? base.heroEyebrow ?? "",
      intro: src.intro ?? base.intro ?? "",
      keyTakeaways: [...(src.keyTakeaways ?? base.keyTakeaways ?? [])],
      faq: (src.faq ?? base.faq ?? []).map((f) => ({ ...f })),
      cta: { ...(base.cta || {}), ...(src.cta || {}) },
      body: "",
    });
    d.slug = front.slug;
    d.slugTouched = true;
    d.editingExisting = true;
    d.publishedAt = front.publishedAt || today();
    d.updatedAt = today();
    d.relatedSlugs = [...(front.relatedSlugs || [])];
    d.fr = pick(front, {});
    d.fr.body = bodies.fr || "";
    d.en = pick(en, front);
    d.en.body = bodies.en || "";
    d.enEnabled = Boolean(front.locales?.en || bodies.en);
    d.autoReading = { fr: false, en: false };
    if (!d.fr.cta.primaryHref) d.fr.cta = { ...s.cta.fr, ...d.fr.cta };
    state.draft = d;
    applyTheme();
    autosave();
    toast(`Article « ${d.fr.title} » importé. La date de mise à jour est passée à aujourd'hui.`, "ok");
    go("article");
  }

  function readFile(input, cb) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        cb(String(reader.result));
      } catch (error) {
        toast(`Import impossible : ${error.message}`, "error");
      }
      input.value = "";
    };
    reader.readAsText(file);
  }

  /* ---------------- GitHub ---------------- */

  function ghClient() {
    const cfg = ghSettings();
    if (!cfg.token) throw new Error("Collez d'abord un jeton GitHub (étape « Publier » → « Publication automatique »).");
    return GH.create({ token: cfg.token.trim(), repo: cfg.repo.trim(), branch: cfg.branch.trim() });
  }

  function log(kind, html) {
    state.gh.log.push({ kind, html });
    const ol = $(".gh-log");
    if (ol) ol.insertAdjacentHTML("beforeend", `<li class="log-${kind}">${html}</li>`);
  }

  async function ghCheck() {
    const box = $("#gh-check-result");
    box.innerHTML = '<p class="muted">Connexion…</p>';
    try {
      const gh = ghClient();
      const info = await gh.check();
      const slugs = await gh.listPosts();
      state.remoteSlugs[site().id] = slugs;
      const push = info.canPush === false ? " · ⚠️ ce jeton ne peut pas écrire" : "";
      state.gh.checked = `Connecté à ${info.fullName} (${info.private ? "privé" : "public"}), branche ${gh.branch}, ${slugs.length} articles trouvés${push}.`;
      box.innerHTML = `<p class="check check-${info.canPush === false ? "warn" : "ok"}"><span class="dot"></span>${esc(state.gh.checked)}</p>`;
      if (gh.branch !== info.defaultBranch) box.insertAdjacentHTML("beforeend", `<p class="check check-warn"><span class="dot"></span>La branche par défaut du dépôt est « ${esc(info.defaultBranch)} ». Vérifiez que le site se déploie bien depuis « ${esc(gh.branch)} ».</p>`);
      renderSidebarStatus();
    } catch (error) {
      state.gh.checked = null;
      box.innerHTML = `<p class="check check-error"><span class="dot"></span>${esc(error.message)}</p>`;
    }
  }

  async function ghListPosts() {
    const host = $("#gh-post-list");
    host.innerHTML = '<p class="muted">Chargement…</p>';
    try {
      const gh = ghClient();
      const slugs = await gh.listPosts();
      state.remoteSlugs[site().id] = slugs;
      host.innerHTML = slugs.length
        ? `<ul class="file-list">${slugs.map((s) => `<li><code>${esc(s)}.md</code><button class="link-btn" data-action="gh-import" data-slug="${esc(s)}">Modifier</button></li>`).join("")}</ul>`
        : '<p class="muted">Aucun article trouvé dans data/blogs.</p>';
    } catch (error) {
      host.innerHTML = `<p class="check check-error"><span class="dot"></span>${esc(error.message)}</p>`;
    }
  }

  async function ghImport(slug) {
    try {
      if (hasContent(state.draft) && !confirm("Remplacer le brouillon en cours par cet article ? (Pensez à « Enregistrer » avant.)")) return;
      const file = await ghClient().getFile(`data/blogs/${slug}.md`);
      if (!file) throw new Error("Fichier introuvable.");
      importPostText(file.text);
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function ghPublish() {
    const d = state.draft;
    const s = site();
    const cfg = ghSettings();
    const files = plannedFiles();
    const verb = cfg.mode === "pr" ? "créer une pull request sur" : "publier directement sur";
    if (!confirm(`Vous allez ${verb} ${cfg.repo} (${cfg.branch}) :\n\n${files.map((f) => `• ${f.path}`).join("\n")}\n\nContinuer ?`)) return;

    state.gh.running = true;
    state.gh.log = [];
    render({ keepScroll: true });
    try {
      const gh = ghClient();
      log("info", "Connexion au dépôt…");
      await gh.check();

      const commitFiles = [{ path: `data/blogs/${d.slug}.md`, text: MD.buildPostFile(d) }];
      usedImages().forEach((img) => commitFiles.push({ path: `public${img.src}`, base64: img.dataUrl.split(",")[1] }));

      if (cfg.llms) {
        log("info", "Lecture des fichiers llms actuels…");
        const current = {};
        for (const path of s.llms.files) {
          const f = await gh.getFile(path);
          if (f) current[path] = f.text;
          else log("warn", `<code>${esc(path)}</code> introuvable : ignoré.`);
        }
        const updated = MD.applyLlms(s, d, current);
        Object.entries(updated).forEach(([path, text]) => {
          if (text !== current[path]) commitFiles.push({ path, text });
        });
      }

      const existing = await gh.getFile(`data/blogs/${d.slug}.md`);
      if (existing && !d.editingExisting && !confirm(`Un article « ${d.slug} » existe déjà sur le site. Le remplacer ?`)) {
        log("warn", "Annulé : l'article existe déjà.");
        return;
      }

      const action = existing ? "Mise à jour" : "Nouvel article";
      const message = `Blog : ${action.toLowerCase()} « ${d.fr.title} »`;
      log("info", `Création du commit (${commitFiles.length} fichier(s))…`);
      const branchName = cfg.mode === "pr" ? `blog/${d.slug}-${Date.now().toString(36)}` : null;
      const res = await gh.commit({
        files: commitFiles,
        message,
        newBranch: branchName,
        prTitle: message,
        prBody: `${action} créé avec le constructeur d'articles.\n\n- FR : /blog/${d.slug}/\n- EN : /en/blog/${d.slug}/\n\nFichiers :\n${commitFiles.map((f) => `- \`${f.path}\``).join("\n")}`,
      });
      log("ok", `Commit créé : <a href="${res.url}" target="_blank" rel="noopener">${res.sha.slice(0, 7)}</a>`);
      d.editingExisting = true;
      state.remoteSlugs[s.id] = Array.from(new Set([...(state.remoteSlugs[s.id] || []), d.slug]));
      autosave();

      if (res.prUrl) {
        log("ok", `Pull request ouverte : <a href="${res.prUrl}" target="_blank" rel="noopener">#${res.prNumber}</a>. Relisez puis cliquez « Merge » sur GitHub pour mettre en ligne.`);
        return;
      }
      await watchDeploy(gh, res.sha);
    } catch (error) {
      log("error", esc(error.message));
    } finally {
      state.gh.running = false;
      const btn = $("[data-action=gh-publish]");
      if (btn) btn.disabled = false;
    }
  }

  async function watchDeploy(gh, sha) {
    const s = site();
    const live = `${s.domain}/blog/${state.draft.slug}/`;
    log("info", "Mise en ligne en cours (2 à 4 minutes)…");
    const started = Date.now();
    let lastStatus = "";
    while (Date.now() - started < 12 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 12000));
      let run;
      try {
        run = await gh.runFor(sha);
      } catch (error) {
        log("warn", `Suivi impossible (${esc(error.message)}). Vérifiez dans <a href="https://github.com/${gh.repo}/actions" target="_blank" rel="noopener">l'onglet Actions</a>.`);
        return;
      }
      if (!run) continue;
      const status = run.status === "completed" ? run.conclusion : run.status;
      if (status !== lastStatus) {
        lastStatus = status;
        if (run.status !== "completed") log("info", `Déploiement : ${esc(status)}…`);
      }
      if (run.status === "completed") {
        if (run.conclusion === "success") {
          log("ok", `En ligne ! <a href="${live}" target="_blank" rel="noopener">${live}</a>. Prochaine étape : demander l'indexation dans Google Search Console (voir le guide).`);
        } else {
          log("error", `Le déploiement a échoué (${esc(run.conclusion)}). <a href="${run.html_url}" target="_blank" rel="noopener">Voir le détail</a> : l'erreur est dans l'étape « Build ».`);
        }
        return;
      }
    }
    log("warn", `Toujours en cours. Suivez-le dans <a href="https://github.com/${gh.repo}/actions" target="_blank" rel="noopener">l'onglet Actions</a>.`);
  }

  /* ---------------- events ---------------- */

  function onBindInput(target) {
    const d = state.draft;
    const path = target.dataset.bind;
    let value = target.value;
    setPath(d, path, value);

    if (path === "fr.title" && !d.slugTouched && !d.editingExisting) {
      d.slug = slugify(value, true);
      const slugInput = $('[data-bind="slug"]');
      if (slugInput) slugInput.value = d.slug;
    }
    if (path === "slug") {
      d.slugTouched = true;
      const clean = value.toLowerCase().replace(/\s+/g, "-");
      if (clean !== value) {
        d.slug = clean;
        target.value = clean;
      }
    }
    const bodyMatch = path.match(/^(fr|en)\.body$/);
    if (bodyMatch && d.autoReading[bodyMatch[1]]) {
      d[bodyMatch[1]].readingTime = readingTimeFor(value);
      const rt = $(`[data-bind="${bodyMatch[1]}.readingTime"]`);
      if (rt) rt.value = d[bodyMatch[1]].readingTime;
    }
    scheduleSave();
    scheduleLive();
  }

  function bindEvents() {
    document.addEventListener("input", (e) => {
      const t = e.target;
      if (t.dataset.bind) onBindInput(t);
      if (t.dataset.gh && t.type !== "radio" && t.type !== "checkbox") {
        const cfg = ghSettings();
        cfg[t.dataset.gh] = t.value;
        saveGhSettings(cfg);
      }
    });

    document.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.bindCheck) {
        setPath(state.draft, t.dataset.bindCheck, t.checked);
        if (t.dataset.bindCheck.startsWith("autoReading") && t.checked) {
          const loc = t.dataset.bindCheck.split(".")[1];
          state.draft[loc].readingTime = readingTimeFor(state.draft[loc].body);
        }
        scheduleSave();
        render({ keepScroll: true });
      }
      if (t.dataset.gh && (t.type === "radio" || t.type === "checkbox")) {
        const cfg = ghSettings();
        cfg[t.dataset.gh] = t.type === "checkbox" ? t.checked : t.value;
        saveGhSettings(cfg);
        render({ keepScroll: true });
      }
      if (t.tagName === "SELECT" && t.dataset.bind) onBindInput(t);
      if (t.dataset.chipInput && t.value.trim()) {
        const list = getPath(state.draft, t.dataset.chipInput);
        t.value.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
          if (!list.includes(v)) list.push(v);
        });
        t.value = "";
        scheduleSave();
        render({ keepScroll: true });
      }
      const action = t.dataset.action;
      if (action === "load-draft-file")
        readFile(t, (text) => {
          loadDraftObject(JSON.parse(text));
          toast("Brouillon chargé.", "ok");
          go("article");
        });
      if (action === "import-md-file") {
        if (hasContent(state.draft) && !confirm("Remplacer le brouillon en cours ? (Pensez à « Enregistrer » avant.)")) {
          t.value = "";
          return;
        }
        readFile(t, (text) => importPostText(text));
      }
      if (action === "toggle-related") {
        const set = new Set(state.draft.relatedSlugs);
        t.checked ? set.add(t.value) : set.delete(t.value);
        state.draft.relatedSlugs = [...set];
        scheduleSave();
        scheduleLive();
      }
    });

    document.addEventListener("keydown", (e) => {
      const t = e.target;
      if (t.dataset.chipInput && (e.key === "Enter" || e.key === ",")) {
        e.preventDefault();
        const val = t.value.trim().replace(/,$/, "");
        if (!val) return;
        const list = getPath(state.draft, t.dataset.chipInput);
        val.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
          if (!list.includes(v)) list.push(v);
        });
        scheduleSave();
        render({ keepScroll: true });
        $(`[data-chip-input="${t.dataset.chipInput}"]`)?.focus();
      }
      if (t.dataset.editor && (e.ctrlKey || e.metaKey)) {
        if (e.key === "b") { e.preventDefault(); mdAction("bold", t.dataset.editor); }
        if (e.key === "i") { e.preventDefault(); mdAction("italic", t.dataset.editor); }
        if (e.key === "k") { e.preventDefault(); mdAction("link", t.dataset.editor); }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveToDrafts();
      }
    });

    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-action]");
      if (!el || el.tagName === "INPUT") return;
      const a = el.dataset.action;
      const d = state.draft;
      const handlers = {
        go: () => go(el.dataset.step),
        "pick-site": () => {
          const id = el.dataset.site;
          if (id === d.site) return;
          if (hasContent(d)) {
            if (!confirm("Commencer un nouvel article pour ce site ? Le brouillon actuel sera gardé dans « Brouillons enregistrés ».")) return;
            saveToDrafts();
          }
          state.draft = newDraft(id);
          applyTheme();
          autosave();
          render();
        },
        "new-draft": () => {
          if (hasContent(d)) {
            if (!confirm("Nouvel article ? Le brouillon actuel sera gardé dans « Brouillons enregistrés ».")) return;
            saveToDrafts();
          }
          state.draft = newDraft(d.site);
          autosave();
          go("article");
        },
        "open-draft": () => {
          const x = storeGet(STORE_DRAFTS, {})[el.dataset.id];
          if (!x) return;
          if (hasContent(d) && d.id !== x.id) saveToDrafts();
          loadDraftObject(x);
          go("article");
        },
        "delete-draft": () => {
          if (!confirm("Supprimer définitivement ce brouillon ?")) return;
          const drafts = storeGet(STORE_DRAFTS, {});
          delete drafts[el.dataset.id];
          storeSet(STORE_DRAFTS, drafts);
          render({ keepScroll: true });
        },
        save: () => saveToDrafts(),
        "download-draft": () => downloadDraft(),
        "slug-short": () => {
          d.slug = slugify(d.fr.title, true);
          d.slugTouched = true;
          scheduleSave();
          render({ keepScroll: true });
        },
        "slug-reset": () => {
          d.slug = slugify(d.fr.title, false);
          d.slugTouched = true;
          scheduleSave();
          render({ keepScroll: true });
        },
        "copy-field": () => {
          setPath(d, el.dataset.to, getPath(d, el.dataset.from));
          scheduleSave();
          render({ keepScroll: true });
        },
        "chip-remove": () => {
          getPath(d, el.dataset.path).splice(+el.dataset.index, 1);
          scheduleSave();
          render({ keepScroll: true });
        },
        "list-add": () => {
          getPath(d, el.dataset.path).push(el.dataset.kind === "faq" ? { question: "", answer: "" } : "");
          scheduleSave();
          render({ keepScroll: true });
        },
        "list-remove": () => {
          getPath(d, el.dataset.path).splice(+el.dataset.index, 1);
          scheduleSave();
          render({ keepScroll: true });
        },
        "list-move": () => {
          const list = getPath(d, el.dataset.path);
          const i = +el.dataset.index;
          const j = i + +el.dataset.dir;
          if (j < 0 || j >= list.length) return;
          [list[i], list[j]] = [list[j], list[i]];
          scheduleSave();
          render({ keepScroll: true });
        },
        md: () => mdAction(el.dataset.md, el.dataset.loc),
        "editor-mode": () => {
          state.editorMode = el.dataset.mode;
          $$(".editor").forEach((ed) => (ed.className = `editor mode-${state.editorMode}`));
          $$("[data-action=editor-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.editorMode));
        },
        "goto-line": () => {
          const ta = activeEditor(el.dataset.loc);
          if (!ta) return;
          const lines = ta.value.split("\n");
          const n = +el.dataset.line;
          const start = lines.slice(0, n - 1).join("\n").length + (n > 1 ? 1 : 0);
          ta.focus();
          ta.setSelectionRange(start, start + (lines[n - 1] || "").length);
          const lh = parseFloat(getComputedStyle(ta).lineHeight) || 22;
          ta.scrollTop = Math.max(0, (n - 4) * lh);
        },
        "image-remove": () => {
          d.images.splice(+el.dataset.index, 1);
          scheduleSave();
          render({ keepScroll: true });
        },
        "toggle-related": () => {},
        "cta-reset": () => {
          d[el.dataset.loc].cta = { ...site().cta[el.dataset.loc] };
          scheduleSave();
          render({ keepScroll: true });
        },
        "en-tab": () => {
          state.enTab = el.dataset.tab;
          render({ keepScroll: true });
        },
        "copy-body-en": () => {
          if (d.en.body.trim() && !confirm("Remplacer le texte anglais actuel ?")) return;
          d.en.body = d.fr.body;
          scheduleSave();
          render({ keepScroll: true });
        },
        "copy-lists-en": () => {
          d.en.keyTakeaways = [...d.fr.keyTakeaways];
          d.en.faq = d.fr.faq.map((f) => ({ ...f }));
          scheduleSave();
          render({ keepScroll: true });
        },
        "copy-all-en": () => {
          if (!confirm("Copier tous les champs français dans la version anglaise (à traduire ensuite) ? Les champs anglais déjà remplis seront remplacés.")) return;
          const keepCta = d.en.cta;
          d.en = JSON.parse(JSON.stringify(d.fr));
          d.en.cta = { ...keepCta };
          d.en.category = site().categories.find((c) => c.fr === d.fr.category)?.en || d.fr.category;
          scheduleSave();
          render({ keepScroll: true });
        },
        "preview-locale": () => {
          state.previewLocale = el.dataset.loc;
          render({ keepScroll: true });
        },
        "copy-file": () => copy(MD.buildPostFile(d)),
        "download-md": () => {
          download(`${d.slug}.md`, MD.buildPostFile(d), "text/markdown;charset=utf-8");
          toast(`${d.slug}.md téléchargé.`, "ok");
        },
        "download-image": () => {
          const img = d.images[+el.dataset.index];
          download(img.src.split("/").pop(), dataUrlToBlob(img.dataUrl));
        },
        "download-images": () => {
          usedImages().forEach((img, i) => setTimeout(() => download(img.src.split("/").pop(), dataUrlToBlob(img.dataUrl)), i * 400));
        },
        "copy-snippet": () => copy(MD.llmsSnippets(site(), d)[+el.dataset.index].text),
        "copy-text": () => copy(el.dataset.text),
        "publish-tab": () => {
          state.publishTab = el.dataset.tab;
          render({ keepScroll: true });
        },
        "gh-check": () => ghCheck(),
        "gh-list-posts": () => ghListPosts(),
        "gh-import": () => ghImport(el.dataset.slug),
        "gh-publish": () => ghPublish(),
      };
      if (handlers[a]) {
        e.preventDefault();
        handlers[a]();
      }
    });

    window.addEventListener("beforeunload", () => autosave());
  }

  /* ---------------- boot ---------------- */

  function boot() {
    const saved = storeGet(STORE_CURRENT);
    try {
      if (saved && saved.version === 1 && SITES[saved.site]) state.draft = saved;
    } catch {}
    if (!state.draft) state.draft = newDraft("vhc");
    // Older drafts may miss newer fields.
    state.draft.autoReading = state.draft.autoReading || { fr: true, en: true };
    state.draft.images = state.draft.images || [];
    try {
      const step = sessionStorage.getItem(STORE_STEP);
      if (step && RENDERERS[step]) state.step = step;
    } catch {}
    applyTheme();
    bindEvents();
    render();
    renderSaveStatus();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
