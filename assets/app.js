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
    { id: "publish", label: "Publier", hint: "Commit auto ou guide manuel" },
  ];

  const state = {
    draft: null,
    step: "start",
    enTab: "article",
    editorMode: "split",
    previewLocale: "fr",
    publishTab: "auto",
    blog: {},
    live: [],
    savedAt: null,
    dirty: false,
    gh: { log: [], result: null, running: false, checked: null },
    screen: "home",
    brief: null,
    aiReport: null,
    aiPending: null,
    edit: null,
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

  /* ---------------- live blog index ----------------
     Nothing about the published posts is hard-coded: the list (slugs, titles, categories, dates)
     is read from the site's repository, cached in the browser and refreshed in the background.
     Public repositories need no token (1 API call to list data/blogs, then raw file downloads);
     with a token the authenticated API is used, which also works for private repositories. */

  const BLOG_CACHE = (id) => `bpc.blog.${id}`;
  const BLOG_TTL = 10 * 60 * 1000;

  function blogState(siteId = site().id) {
    if (!state.blog[siteId]) {
      const cached = storeGet(BLOG_CACHE(siteId));
      state.blog[siteId] = cached && Array.isArray(cached.posts) ? { status: "cached", posts: cached.posts, loadedAt: cached.loadedAt } : { status: "idle", posts: [] };
    }
    return state.blog[siteId];
  }

  function blogKnown(siteId = site().id) {
    const b = blogState(siteId);
    return b.status === "ok" || b.status === "cached" || (b.status === "loading" && b.loadedAt);
  }

  function blogPosts(siteId = site().id) {
    return blogState(siteId).posts || [];
  }

  // Categories actually used on the blog, most used first, with their English label.
  function blogCategories(siteId = site().id) {
    const map = new Map();
    blogPosts(siteId).forEach((p) => {
      if (!p.category) return;
      const cur = map.get(p.category) || { fr: p.category, en: p.categoryEn || "", n: 0 };
      cur.n += 1;
      if (!cur.en && p.categoryEn) cur.en = p.categoryEn;
      map.set(p.category, cur);
    });
    return [...map.values()].sort((a, b) => b.n - a.n);
  }

  function knownPosts() {
    return blogPosts().filter((p) => p.slug !== state.draft.slug);
  }

  function summarisePost(slug, text) {
    try {
      const { front, bodies } = MD.parsePostFile(text);
      const en = front.locales?.en || {};
      return {
        slug,
        title: front.title || slug,
        titleEn: en.title || "",
        category: front.category || "",
        categoryEn: en.category || "",
        publishedAt: front.publishedAt || "",
        updatedAt: front.updatedAt || "",
        readingTime: front.readingTime || "",
        description: front.description || "",
        keywords: Array.isArray(front.keywords) ? front.keywords.slice(0, 6) : [],
        en: Boolean(front.locales?.en || bodies.en),
        words: MD.wordCount(bodies.fr || ""),
        images: ((bodies.fr || "").match(/!\[/g) || []).length,
      };
    } catch (error) {
      return { slug, title: slug, broken: error.message };
    }
  }

  function rawUrl(cfg, path) {
    return `https://raw.githubusercontent.com/${cfg.repo}/${encodeURIComponent(cfg.branch)}/${path}?t=${Date.now()}`;
  }

  async function fetchRepoFile(siteId, path) {
    const cfg = ghSettings(siteId);
    if (cfg.token) {
      const file = await GH.create({ token: cfg.token.trim(), repo: cfg.repo.trim(), branch: cfg.branch.trim() }).getFile(path);
      return file ? file.text : null;
    }
    const res = await fetch(rawUrl(cfg, path), { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Lecture de ${path} impossible (${res.status}).`);
    return res.text();
  }

  async function listRepoPosts(siteId) {
    const cfg = ghSettings(siteId);
    if (cfg.token) return GH.create({ token: cfg.token.trim(), repo: cfg.repo.trim(), branch: cfg.branch.trim() }).listPosts();
    const res = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/data/blogs?ref=${encodeURIComponent(cfg.branch)}`, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    if (res.status === 404) throw new Error(`Dépôt ${cfg.repo} introuvable ou privé : ajoutez un jeton dans « Connexion GitHub ».`);
    if (res.status === 403 || res.status === 429) throw new Error("Limite de lecture GitHub sans jeton atteinte (60 par heure) : ajoutez un jeton ou réessayez plus tard.");
    if (!res.ok) throw new Error(`Lecture du dépôt impossible (${res.status}).`);
    const items = await res.json();
    return items.filter((it) => it.type === "file" && it.name.endsWith(".md")).map((it) => it.name.replace(/\.md$/, ""));
  }

  function loadBlogIndex(siteId = site().id, { force = false } = {}) {
    const b = blogState(siteId);
    if (b.status === "loading") return b.promise;
    if (!force && b.status === "ok" && Date.now() - b.loadedAt < BLOG_TTL) return Promise.resolve(b);
    b.status = "loading";
    b.error = null;
    onBlogUpdate(siteId);
    b.promise = (async () => {
      try {
        const slugs = await listRepoPosts(siteId);
        const posts = await Promise.all(slugs.map(async (slug) => summarisePost(slug, (await fetchRepoFile(siteId, `data/blogs/${slug}.md`)) || "")));
        posts.sort((a, c) => (c.publishedAt || "").localeCompare(a.publishedAt || ""));
        Object.assign(b, { status: "ok", posts, loadedAt: Date.now(), error: null });
        storeSet(BLOG_CACHE(siteId), { posts, loadedAt: b.loadedAt });
      } catch (error) {
        b.status = b.loadedAt ? "cached" : "error";
        b.error = error.message;
      }
      onBlogUpdate(siteId);
      return b;
    })();
    return b.promise;
  }

  function blogStatusText(siteId = site().id) {
    const b = blogState(siteId);
    const n = b.posts.length;
    const at = b.loadedAt ? new Date(b.loadedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
    if (b.status === "loading") return b.loadedAt ? `${n} articles · actualisation…` : "Lecture des articles…";
    if (b.status === "ok") return `${n} article${n > 1 ? "s" : ""} publié${n > 1 ? "s" : ""} · à jour (${at})`;
    if (b.status === "cached") return `${n} articles · données du ${new Date(b.loadedAt).toLocaleDateString("fr-FR")} ${at}${b.error ? " · hors ligne" : ""}`;
    if (b.status === "error") return "Articles non chargés";
    return "Articles non chargés";
  }

  // Refresh what depends on the index without disturbing what the user is typing.
  function onBlogChip() {
    const chip = $("#blog-status");
    if (!chip || !state.draft) return;
    const id = site().id;
    const b = blogState(id);
    chip.textContent = `📚 ${blogStatusText(id)}`;
    chip.dataset.state = b.status;
    chip.title = b.error ? `${b.error} · Cliquez pour réessayer` : "Liste des articles lue sur GitHub · Cliquez pour actualiser";
  }

  function onBlogUpdate(siteId) {
    if (siteId === site().id) onBlogChip();
    $$(`[data-blog-count="${siteId}"]`).forEach((el) => (el.textContent = blogStatusText(siteId)));
    if (siteId !== site().id || !state.draft) return;
    if (state.screen === "edit" || state.screen === "home" || state.screen === "mode") return render({ keepScroll: true });
    if (state.screen === "ai") return refreshPrompt();
    if (["links", "start", "review"].includes(state.step) && !document.activeElement?.matches("input, textarea, select")) return render({ keepScroll: true });
    ["fr", "en"].forEach((loc) => {
      const dl = $(`#cat-${loc}`);
      if (dl) dl.innerHTML = blogCategories().map((c) => (c[loc] ? `<option value="${esc(c[loc])}"></option>` : "")).join("");
    });
    refreshLive();
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
    // Drafts kept in this browser were produced by the tool itself: still validated, leniently.
    const report = validateDraftJson(obj, { lenient: true });
    if (report.errors.length) throw new Error(report.errors.slice(0, 3).join(" "));
    report.draft.savedAt = obj.savedAt;
    state.draft = report.draft;
    applyTheme();
    autosave();
  }

  function showReportModal(report, title) {
    openModal({
      title,
      wide: true,
      submitLabel: report.errors.length ? "Fermer" : "Importer et vérifier →",
      body: renderReport(report).replace(/<div class="row-actions mt">[\s\S]*?<\/div>/, ""),
      onSubmit() {
        if (!report.errors.length) applyImportedDraft(report, "Brouillon");
      },
    });
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
    const taken = blogPosts().some((p) => p.slug === d.slug);
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
    return `${stepHeader("Démarrer", "Reprenez un brouillon, importez un article existant ou commencez un nouvel article. Tout est enregistré automatiquement dans ce navigateur.")}
      <section class="card row-between">
        <div><h3>1. Site</h3><p class="muted">${esc(site().name)} · ${esc(site().domain.replace("https://", ""))}</p></div>
        <div class="row-actions"><button class="btn btn-ghost" data-action="screen" data-screen="home">Changer de site</button><button class="btn btn-ghost" data-action="mode" data-mode="ai">✨ Rédiger avec l'IA</button><button class="btn btn-ghost" data-action="mode" data-mode="edit">🛠️ Modifier un article publié</button></div>
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
            <span>Un brouillon téléchargé avec « Télécharger le brouillon », ou le JSON produit par une IA. Sa structure est vérifiée avant l'import.</span>
          </label>
          <label class="drop">
            <input type="file" accept=".md,text/markdown" data-action="import-md-file" hidden />
            <strong>Modifier un article publié (.md)</strong>
            <span>Le fichier <code>data/blogs/&lt;slug&gt;.md</code> du site. Il sera réimporté dans tous les champs.</span>
          </label>
        </div>
        <div class="gh-import">
          <button class="btn btn-ghost" data-action="gh-list-posts">Importer depuis GitHub…</button>
          <span class="muted small">Nécessite un jeton dans le panneau « Connexion GitHub » (à droite sur ordinateur, en bas de page sur mobile).</span>
          <div id="gh-post-list"></div>
        </div>
      </section>
      ${navButtons()}`;
  }

  function categoryOptions(loc) {
    return `<datalist id="cat-${loc}">${blogCategories()
      .map((c) => (c[loc] ? `<option value="${esc(c[loc])}"></option>` : ""))
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
          ${field({ label: "Catégorie", path: p("category"), list: `cat-${loc}`, required: true, hint: "Les catégories déjà utilisées sur le blog sont proposées ; vous pouvez en créer une nouvelle.", placeholder: blogCategories()[0]?.[loc] || "" })}
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
                (img, i) => `<li><img src="${img.dataUrl}" alt="" /><div><code>${esc(img.src)}</code><small>${Math.round(img.bytes / 1024)} Ko · ${img.width}×${img.height}</small></div><span class="row-actions"><button class="link-btn" data-action="image-insert" data-index="${i}">Insérer</button><button class="link-btn danger" data-action="image-remove" data-index="${i}">Retirer</button></span></li>`
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
    const related = d.relatedSlugs.map((slug) => {
      const post = blogPosts().find((p) => p.slug === slug);
      return (loc === "en" && post?.titleEn) || post?.title || slug;
    });
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

  function ghSettings(siteId) {
    const s = siteId ? SITES[siteId] : site();
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

  function renderGhPanel() {
    const cfg = ghSettings();
    const g = state.gh;
    return `<h3>Connexion GitHub</h3>
      <p class="muted small">Pour importer un article depuis GitHub et publier automatiquement. Le jeton est propre à chaque site.</p>
      <label class="field"><span class="field-label">Dépôt</span><input type="text" data-gh="repo" value="${esc(cfg.repo)}" /></label>
      <label class="field"><span class="field-label">Branche</span><input type="text" data-gh="branch" value="${esc(cfg.branch)}" /></label>
      <label class="field"><span class="field-label">Jeton</span>
        <div class="input-group"><input type="password" id="gh-token" data-gh="token" value="${esc(cfg.token)}" placeholder="github_pat_…" autocomplete="off" spellcheck="false" /><button type="button" class="icon-btn reveal" data-action="toggle-token" title="Afficher / masquer">👁</button></div>
      </label>
      <label class="inline-check small"><input type="checkbox" data-gh="remember" ${cfg.remember ? "checked" : ""}/> Se souvenir sur cet appareil</label>
      <small class="hint">${cfg.remember ? "Gardé dans ce navigateur jusqu'à ce que vous décochiez." : "Oublié à la fermeture de l'onglet."}</small>
      <div class="row-actions mt">
        <button class="btn btn-ghost" data-action="gh-check" ${cfg.token ? "" : "disabled"}>Tester</button>
        ${cfg.token ? '<button class="btn btn-ghost danger" data-action="gh-forget">Effacer</button>' : ""}
      </div>
      <div id="gh-check-result">${g.checked ? `<p class="check check-ok"><span class="dot"></span>${esc(g.checked)}</p>` : ""}</div>
      <button class="link-btn mt" data-action="token-help">Comment créer un jeton ?</button>`;
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
      <section class="card row-between">
        <div>
          <h3>Connexion</h3>
          <p class="muted small">${cfg.token ? `Jeton enregistré pour <code>${esc(cfg.repo)}</code> (${esc(cfg.branch)}).` : "Aucun jeton : renseignez-le dans le panneau « Connexion GitHub » (à droite sur ordinateur, en bas de page sur mobile)."}</p>
        </div>
        <button class="btn btn-ghost" data-action="focus-token">${cfg.token ? "Modifier" : "Ajouter un jeton"}</button>
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
    return `${stepHeader("Publier", "Deux façons de mettre l'article en ligne : automatiquement depuis cette page avec un jeton GitHub, ou à la main en suivant le guide.")}
      <div class="tabs">
        <button class="${state.publishTab === "auto" ? "on" : ""}" data-action="publish-tab" data-tab="auto">Publication automatique</button>
        <button class="${state.publishTab === "guide" ? "on" : ""}" data-action="publish-tab" data-tab="guide">Guide pas à pas (manuel)</button>
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

  /* ---------------- AI flow: brief, prompt, validation, import ---------------- */

  const STORE_SCREEN = "bpc.screen";
  const briefKey = () => `bpc.brief.${site().id}`;

  function emptyBrief() {
    return {
      title: "",
      subject: "",
      audience: "",
      goal: "",
      keywords: "",
      length: "1400",
      tone: "",
      languages: { fr: true, en: true },
      research: true,
      sources: "",
      facts: "",
      avoid: "",
      images: [],
      tables: [],
      response: "",
    };
  }

  function loadBrief() {
    const saved = storeGet(briefKey());
    state.brief = { ...emptyBrief(), ...(saved || {}) };
    state.brief.languages = { fr: true, en: true, ...(state.brief.languages || {}) };
    state.aiReport = null;
  }

  let briefTimer = null;
  function saveBrief() {
    clearTimeout(briefTimer);
    briefTimer = setTimeout(() => {
      if (!storeSet(briefKey(), state.brief)) toast("Stockage du navigateur plein : retirez des images ou réduisez leur nombre.", "error");
    }, 400);
  }

  // Tab/CSV/Markdown pasted from a spreadsheet -> Markdown pipe table.
  // CSV / TSV parser: quoted fields, "" escapes, line breaks inside quotes, delimiter auto-detected.
  function parseCsv(text) {
    const src = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const firstLine = src.split("\n").find((l) => l.trim()) || "";
    const count = (ch) => (firstLine.match(new RegExp(ch === "\t" ? "\t" : `\\${ch}`, "g")) || []).length;
    const delim = ["\t", ";", ","].sort((a, b) => count(b) - count(a))[0];
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell.trim() === "") { quoted = true; cell = ""; }
      else if (ch === delim) { row.push(cell.trim()); cell = ""; }
      else if (ch === "\n") { row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if (cell.trim() || row.length) { row.push(cell.trim()); rows.push(row); }
    return rows.filter((r) => r.some((c) => c !== ""));
  }

  function tableRows(text) {
    const raw = String(text || "").trim();
    if (!raw) return [];
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    if (lines.every((l) => l.trim().startsWith("|"))) {
      return lines.filter((l) => !/^\|(?:\s*:?-+:?\s*\|)+$/.test(l.trim())).map((l) => l.trim().slice(1, -1).split("|").map((c) => c.trim()));
    }
    return parseCsv(raw);
  }

  function toMarkdownTable(text) {
    return rowsToMarkdown(tableRows(text));
  }

  function rowsToCsv(rows) {
    return rows.map((r) => r.map((c) => (/[",;\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  }

  // Large tables are not copied into the prompt: the AI places a marker and the tool inserts the data.
  const BIG_TABLE_ROWS = 15;
  const BIG_TABLE_CHARS = 2500;
  function isBigTable(t) {
    return (t.rows || 0) > BIG_TABLE_ROWS || (t.markdown || "").length > BIG_TABLE_CHARS;
  }

  function updateTable(t, text) {
    t.paste = text;
    const rows = tableRows(text);
    t.rows = Math.max(0, rows.length - 1);
    t.cols = rows.length ? Math.max(...rows.map((r) => r.length)) : 0;
    t.headers = rows[0] || [];
    t.markdown = rowsToMarkdown(rows);
    t.csv = rowsToCsv(rows);
  }

  function rowsToMarkdown(rows) {
    if (!rows.length) return "";
    const cols = Math.max(...rows.map((r) => r.length));
    const clean = (v) => String(v || "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
    const out = [];
    rows.forEach((r, i) => {
      const cells = Array.from({ length: cols }, (_, c) => clean(r[c]) || (i === 0 ? `Colonne ${c + 1}` : ""));
      out.push(`| ${cells.join(" | ")} |`);
      if (i === 0) out.push(`| ${cells.map(() => "---").join(" | ")} |`);
    });
    return out.join("\n");
  }

  function buildPrompt() {
    const s = site();
    const b = state.brief;
    const langs = ["fr", "en"].filter((l) => b.languages[l]);
    const withEn = langs.includes("en");
    const posts = blogPosts().filter((p) => !p.broken);
    const cats = blogCategories();
    const day = today();
    const words = +b.length || 1400;
    const keywords = b.keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean);

    const localeTemplate = (lang) => `{
      "category": "${lang === "fr" ? "Catégorie en français" : "Category in English"}",
      "title": "...",
      "seoTitle": "...",
      "description": "...",
      "excerpt": "...",
      "readingTime": "${Math.max(1, Math.round(words / 200))} min",
      "keywords": ["mot-clé principal", "..."],
      "heroEyebrow": "Catégorie · Sujet",
      "intro": "...",
      "keyTakeaways": ["...", "...", "..."],
      "faq": [
        { "question": "...", "answer": "..." }
      ],
      "cta": {
        "title": "...",
        "description": "...",
        "primaryLabel": "...",
        "primaryHref": "${s.cta[lang].primaryHref}",
        "secondaryLabel": "...",
        "secondaryHref": "${s.cta[lang].secondaryHref}"
      },
      "body": "Texte de l'article en Markdown, sauts de ligne encodés \\\\n"
    }`;

    const images = b.images.length
      ? `## Images fournies (obligatoires)

Insère chaque image UNE fois dans le corps de ${withEn ? "chaque langue" : "l'article"}, seule sur sa ligne, avec une ligne vide avant et après, exactement sous cette forme :
![texte alternatif](IMAGE:identifiant "légende")
- Le texte alternatif décrit l'image en une phrase, dans la langue de l'article (pas « image de… »).
- La légende est facultative : si aucune n'est indiquée, écris ![texte alternatif](IMAGE:identifiant) sans guillemets.
- N'invente pas d'autres images et ne change pas les identifiants.

${b.images
  .map((img) => `- ${img.id} : ${img.description || "(pas de description)"} | Emplacement : ${img.placement || "à toi de choisir l'endroit le plus pertinent"}${img.caption ? ` | Légende : ${img.caption}` : ""}`)
  .join("\n")}
`
      : "";

    const filled = b.tables.filter((t) => (t.markdown || "").trim());
    const small = filled.filter((t) => !isBigTable(t));
    const big = filled.filter(isBigTable);
    const tables = filled.length
      ? `## Tableaux fournis (obligatoires)
${
  small.length
    ? `
Insère chacun de ces tableaux tel quel (mêmes données, mêmes colonnes), au format Markdown ci-dessous, avec une ligne vide avant et après. Tu peux ajouter une phrase d'introduction avant le tableau.${withEn ? " Pour la version anglaise, traduis les en-têtes et les textes, pas les chiffres." : ""}

${small.map((t) => `### ${t.id}${t.title ? ` : ${t.title}` : ""}\nEmplacement : ${t.placement || "à toi de choisir l'endroit le plus pertinent"}\n\n${t.markdown}`).join("\n\n")}
`
    : ""
}${
  big.length
    ? `
Grands tableaux : NE LES RECOPIE PAS. À l'endroit voulu, écris uniquement le repère [[TABLE:identifiant]] seul sur sa ligne, avec une ligne vide avant et après${withEn ? ", dans chaque langue" : ""} : l'outil insérera le tableau complet. Le fichier complet est joint à la conversation : utilise-le pour analyser les données et commenter les chiffres importants dans le texte (sans inventer de valeurs).

${big
  .map((t) => {
    const preview = rowsToMarkdown(tableRows(t.paste).slice(0, 6));
    return `### ${t.id}${t.title ? ` : ${t.title}` : ""}\nFichier joint : ${t.fileName || `${t.id}.csv`} (${t.rows} lignes, ${t.cols} colonnes)\nColonnes : ${(t.headers || []).join(", ")}\nEmplacement : ${t.placement || "à toi de choisir l'endroit le plus pertinent"}\nAperçu des premières lignes :\n\n${preview}`;
  })
  .join("\n\n")}
`
    : ""
}`
      : "";

    const research = b.research
      ? `Fais une recherche sérieuse avant d'écrire (utilise la recherche web si tu y as accès). Appuie-toi sur des sources fiables et vérifiables : études, organismes officiels, presse reconnue. N'invente AUCUN chiffre, AUCUNE étude, AUCUNE citation et AUCUNE source. Si tu ne peux pas vérifier une donnée, ne l'utilise pas. Termine le corps par une section « ## Sources » listant les sources réellement utilisées sous forme de liens Markdown.`
      : `N'invente aucun chiffre, aucune étude ni aucune source. N'utilise que des informations sûres ou celles fournies ci-dessous.`;

    const attachments = big.map((t) => t.fileName || `${t.id}.csv`);
    return `Tu es un rédacteur web expert en SEO. Tu écris un article de blog pour le site ${s.domain} (${s.brand} : ${s.tagline}).
Ta réponse sera importée automatiquement dans un outil : elle doit respecter EXACTEMENT le format demandé à la fin.
${attachments.length ? `Fichiers joints à ce message : ${attachments.join(", ")}.\n` : ""}
## Le brief

- Sujet / angle : ${b.subject.trim() || "(à préciser)"}
${b.title.trim() ? `- Titre de travail : ${b.title.trim()} (tu peux l'améliorer pour le SEO)\n` : ""}${b.audience.trim() ? `- Public visé : ${b.audience.trim()}\n` : ""}${b.goal.trim() ? `- Objectif de l'article / message clé : ${b.goal.trim()}\n` : ""}${keywords.length ? `- Mots-clés souhaités (le premier est le mot-clé principal) : ${keywords.join(", ")}\n` : "- Mots-clés : choisis toi-même 3 à 10 expressions réellement recherchées, la première étant le mot-clé principal.\n"}- Longueur du corps : environ ${words} mots${withEn ? " par langue" : ""}
- Langues : ${langs.map((l) => (l === "fr" ? "français (version principale)" : "anglais (adaptation complète, pas une traduction mot à mot)")).join(" et ")}
${b.tone.trim() ? `- Ton : ${b.tone.trim()}\n` : ""}${b.facts.trim() ? `\n### Informations à intégrer\n${b.facts.trim()}\n` : ""}${b.avoid.trim() ? `\n### À éviter\n${b.avoid.trim()}\n` : ""}${b.sources.trim() ? `\n### Sources à utiliser en priorité\n${b.sources.trim()}\n` : ""}
## Recherche et fiabilité

${research}

## Règles d'écriture

- Vouvoiement, phrases claires, paragraphes courts, exemples concrets.
- N'utilise JAMAIS le tiret cadratin « — » ni le tiret demi-cadratin « – » comme ponctuation : utilise des virgules, deux-points ou parenthèses.
- Pas de témoignages ni de clients inventés, pas de promesses de résultats chiffrés.
${s.notes.map((n) => `- ${n}`).join("\n")}

## Markdown autorisé dans "body" (le site n'affiche rien d'autre)

- Titres de section « ## » et sous-titres « ### » (jamais « # » ni « #### »). Au moins 4 sections « ## ».
- Paragraphes séparés par une ligne vide. **gras** et *italique* uniquement avec des astérisques.
- Listes à puces avec « - » uniquement : pas de listes numérotées, pas de sous-listes.
- Citations avec « > ».
- Liens : [texte](/chemin/) pour les pages du site, [texte](https://...) pour les sources.
- Tableaux Markdown avec ligne d'en-tête puis « | --- | --- | ».
- Pas de HTML, pas de séparateur « --- », pas d'emoji.
- Ne répète pas le titre ni l'introduction au début du body : commence directement par un paragraphe d'accroche.

${images}${tables}## Maillage interne

Ajoute 2 à 4 liens internes naturels dans le corps, UNIQUEMENT vers ces adresses (garde le / final) :
${s.pages.filter((p) => p.path !== "/").map((p) => `- ${p.path === "/" ? "/" : p.path + "/"} : ${p.label}`).join("\n")}
${posts.map((p) => `- /blog/${p.slug}/ : article « ${p.title} »`).join("\n")}
Pour la version anglaise, garde exactement les mêmes adresses (le site les adapte tout seul).

## Champs SEO (contraintes strictes)

- "slug" : adresse de l'article en minuscules sans accents, mots séparés par des tirets, 3 à 7 mots, contient le mot-clé principal.${posts.length ? ` Différent de : ${posts.map((p) => p.slug).join(", ")}.` : ""}
- "title" : titre H1, 30 à 100 caractères.
- "seoTitle" : 35 à 65 caractères, commence par le mot-clé principal, sans le nom du site.
- "description" : meta description de 120 à 160 caractères, avec le mot-clé principal et une promesse concrète.
- "excerpt" : 100 à 260 caractères, résumé pour la page Blog.
- "keywords" : 3 à 10 expressions, la première est le mot-clé principal ; il doit apparaître dans title, seoTitle, description, intro et au moins un titre « ## ».
- "heroEyebrow" : « Catégorie · Sujet court ».
- "intro" : chapô de 150 à 500 caractères (texte simple, sans Markdown).
- "keyTakeaways" : 3 à 5 phrases courtes et affirmatives.
- "faq" : 3 à 6 questions que les lecteurs se posent vraiment, réponses de 40 à 400 caractères (texte simple).
- "category" : ${cats.length ? `de préférence une de celles déjà utilisées sur le blog (français / anglais) : ${cats.map((c) => `${c.fr} / ${c.en || "?"}`).join(" ; ")}. Sinon, une nouvelle catégorie courte et cohérente avec celles-ci.` : "une catégorie courte (1 à 3 mots) qui décrit le thème."}
- "readingTime" : nombre de mots du body divisé par 200, arrondi, suivi de « min ».
- "relatedSlugs" : ${posts.length ? `1 ou 2 slugs pris UNIQUEMENT dans cette liste : ${posts.map((p) => p.slug).join(", ")}.` : "[] (aucun autre article publié pour l'instant)."}
- "cta" : un appel à l'action adapté au sujet. "primaryHref" et "secondaryHref" doivent être des adresses de la liste du maillage interne, sans le / final (ex. "/contact"). Exemple du ton attendu : « ${s.cta.fr.title} ».
- "publishedAt" et "updatedAt" : "${day}".

## Format de réponse (obligatoire)

Réponds UNIQUEMENT avec un bloc de code \`\`\`json contenant un JSON valide, sans aucun texte avant ou après, sans commentaires, sans virgule finale. Dans les chaînes, échappe les guillemets doubles (\\") et encode les sauts de ligne en \\n. Structure exacte :

\`\`\`json
{
  "format": "blogpost-draft",
  "version": 1,
  "site": "${s.id}",
  "slug": "...",
  "publishedAt": "${day}",
  "updatedAt": "${day}",
  "relatedSlugs": ["..."],
  "enEnabled": ${withEn},
  "fr": ${localeTemplate("fr")}${withEn ? `,\n  "en": ${localeTemplate("en")}` : ""}
}
\`\`\`
`;
  }

  /* ---- strict validation of an imported JSON (AI answer or draft file) ---- */

  function extractJson(text) {
    const raw = String(text || "").trim();
    if (!raw) throw new Error("La réponse est vide.");
    const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    const candidate = fence ? fence[1] : raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    if (!candidate.trim().startsWith("{")) throw new Error("Aucun objet JSON trouvé dans la réponse.");
    try {
      return JSON.parse(candidate);
    } catch (error) {
      const pos = +(String(error.message).match(/position (\d+)/)?.[1] ?? -1);
      const around = pos >= 0 ? ` Près de : « ${candidate.slice(Math.max(0, pos - 40), pos + 40).replace(/\n/g, "⏎")} »` : "";
      throw new Error(`JSON invalide (${error.message}).${around}`);
    }
  }

  const isStr = (v) => typeof v === "string";
  const isDate = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

  function validateDraftJson(obj, { briefImages = [], briefTables = [], lenient = false } = {}) {
    const errors = [];
    const warnings = [];
    const fixes = [];
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return { errors: ["La racine doit être un objet JSON { … }."], warnings, fixes, draft: null };
    }
    const siteId = SITES[obj.site] ? obj.site : site().id;
    if (obj.site && !SITES[obj.site]) errors.push(`"site" vaut « ${obj.site} » : attendu « vhc » ou « karen ».`);
    else if (obj.site && obj.site !== site().id) warnings.push(`Ce brouillon est pour le site « ${SITES[obj.site].name} » : l'outil bascule sur ce site.`);
    const s = SITES[siteId];
    const d = newDraft(siteId);
    const indexKnown = blogKnown(siteId);
    const known = blogPosts(siteId).map((p) => p.slug);

    const str = (path, value, { required = false, min = 0, max = Infinity, label = path, plain = false } = {}) => {
      if (value == null || value === "") {
        if (required) errors.push(`"${label}" est obligatoire.`);
        return "";
      }
      if (!isStr(value)) {
        if (typeof value === "number") { fixes.push(`"${label}" converti en texte.`); value = String(value); }
        else { errors.push(`"${label}" doit être du texte (reçu : ${Array.isArray(value) ? "liste" : typeof value}).`); return ""; }
      }
      let v = value.trim();
      if (plain && /[*#`]|\]\(/.test(v)) warnings.push(`"${label}" contient du Markdown : il s'affichera tel quel.`);
      if (v.length && (v.length < min || v.length > max)) warnings.push(`"${label}" : ${v.length} caractères (attendu ${min} à ${max === Infinity ? "∞" : max}).`);
      return v;
    };
    const strList = (value, label, { min = 0, max = Infinity } = {}) => {
      if (value == null) { if (min) errors.push(`"${label}" est obligatoire (liste).`); return []; }
      if (isStr(value)) { fixes.push(`"${label}" était un texte : découpé en liste.`); value = value.split(/[,\n]/); }
      if (!Array.isArray(value)) { errors.push(`"${label}" doit être une liste de textes.`); return []; }
      const out = [];
      value.forEach((v, i) => {
        if (isStr(v) && v.trim()) out.push(v.trim());
        else if (typeof v === "number") out.push(String(v));
        else if (v != null && v !== "") errors.push(`"${label}[${i}]" doit être du texte.`);
      });
      if (out.length < min || out.length > max) warnings.push(`"${label}" : ${out.length} élément(s) (attendu ${min} à ${max === Infinity ? "∞" : max}).`);
      return out;
    };

    const readLocale = (src, lang, required) => {
      const L = emptyLocale(s.cta[lang]);
      if (src == null) {
        if (required) errors.push(`L'objet "${lang}" est absent.`);
        return L;
      }
      if (typeof src !== "object" || Array.isArray(src)) {
        errors.push(`"${lang}" doit être un objet { … }.`);
        return L;
      }
      const known = new Set(["category", "title", "seoTitle", "description", "excerpt", "readingTime", "keywords", "heroEyebrow", "intro", "keyTakeaways", "faq", "cta", "body"]);
      Object.keys(src).filter((k) => !known.has(k)).forEach((k) => warnings.push(`Champ inconnu ignoré : "${lang}.${k}".`));
      const p = (k) => `${lang}.${k}`;
      L.category = str(p("category"), src.category, { required, label: p("category") });
      L.title = str(p("title"), src.title, { required, min: 30, max: 100, label: p("title"), plain: true });
      L.seoTitle = str(p("seoTitle"), src.seoTitle, { required, min: 35, max: 65, label: p("seoTitle"), plain: true });
      L.description = str(p("description"), src.description, { required, min: 120, max: 160, label: p("description"), plain: true });
      L.excerpt = str(p("excerpt"), src.excerpt, { min: 100, max: 260, label: p("excerpt"), plain: true });
      if (!L.excerpt && L.description) { L.excerpt = L.description; fixes.push(`"${p("excerpt")}" vide : la description est reprise.`); }
      L.heroEyebrow = str(p("heroEyebrow"), src.heroEyebrow, { label: p("heroEyebrow") });
      L.intro = str(p("intro"), src.intro, { required, min: 150, max: 500, label: p("intro"), plain: true });
      L.keywords = strList(src.keywords, p("keywords"), { min: 3, max: 10 });
      L.keyTakeaways = strList(src.keyTakeaways, p("keyTakeaways"), { min: 3, max: 6 });
      if (src.faq == null) { warnings.push(`"${p("faq")}" absente.`); L.faq = []; }
      else if (!Array.isArray(src.faq)) { errors.push(`"${p("faq")}" doit être une liste de { "question", "answer" }.`); L.faq = []; }
      else {
        L.faq = [];
        src.faq.forEach((f, i) => {
          if (!f || typeof f !== "object" || !isStr(f.question) || !isStr(f.answer)) errors.push(`"${p("faq")}[${i}]" doit être { "question": "…", "answer": "…" } en texte.`);
          else if (f.question.trim() && f.answer.trim()) L.faq.push({ question: f.question.trim(), answer: f.answer.trim() });
        });
        if (L.faq.length < 3) warnings.push(`"${p("faq")}" : ${L.faq.length} question(s), 3 recommandées.`);
      }
      if (src.cta != null && (typeof src.cta !== "object" || Array.isArray(src.cta))) errors.push(`"${p("cta")}" doit être un objet.`);
      else if (src.cta) {
        ["title", "description", "primaryLabel", "primaryHref", "secondaryLabel", "secondaryHref"].forEach((k) => {
          if (src.cta[k] == null) return;
          if (!isStr(src.cta[k])) errors.push(`"${p("cta")}.${k}" doit être du texte.`);
          else L.cta[k] = src.cta[k].trim();
        });
        ["primaryHref", "secondaryHref"].forEach((k) => {
          let href = L.cta[k];
          if (!href) return;
          href = href.replace(/^https?:\/\/[^/]+/, "").replace(/(.)\/$/, "$1");
          if (!s.pages.some((pg) => pg.path === href)) {
            warnings.push(`"${p("cta")}.${k}" = « ${L.cta[k]} » n'est pas une page connue : remplacé par ${s.cta[lang][k]}.`);
            href = s.cta[lang][k];
          }
          L.cta[k] = href;
        });
      } else fixes.push(`"${p("cta")}" absent : appel à l'action par défaut du site.`);
      if (!L.cta.title || !L.cta.primaryLabel) { L.cta = { ...s.cta[lang], ...Object.fromEntries(Object.entries(L.cta).filter(([, v]) => v)) }; }
      L.body = str(p("body"), src.body, { required, label: p("body") });
      if (L.body && !L.body.includes("\n") && L.body.includes("\\n")) { L.body = L.body.replace(/\\n/g, "\n"); fixes.push(`"${p("body")}" : sauts de ligne « \\n » décodés.`); }
      L.readingTime = str(p("readingTime"), src.readingTime, { label: p("readingTime") });
      const computed = readingTimeFor(L.body);
      if (!/^\d+\s?min$/.test(L.readingTime)) { if (L.readingTime) fixes.push(`"${p("readingTime")}" recalculé (${computed}).`); L.readingTime = computed; }
      if (L.body) {
        const lint = MD.lint(L.body, { noEmDash: true });
        const bad = lint.filter((i) => i.level === "error");
        if (bad.length) warnings.push(`"${p("body")}" : ${bad.length} problème(s) de mise en forme (ex. ligne ${bad[0].n} : ${bad[0].msg})`);
        const dashes = (JSON.stringify(src).match(/—/g) || []).length;
        if (dashes) warnings.push(`${lang.toUpperCase()} : ${dashes} tiret(s) cadratin(s) « — » à remplacer.`);
      }
      return L;
    };

    if (obj.format && obj.format !== "blogpost-draft") warnings.push(`"format" inattendu : « ${obj.format} ».`);
    if (obj.version != null && obj.version !== 1) errors.push(`"version" doit valoir 1.`);

    d.fr = readLocale(obj.fr, "fr", true);

    // Slug
    let slug = isStr(obj.slug) ? obj.slug.trim() : "";
    if (slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      const fixed = slugify(slug);
      fixes.push(`"slug" « ${slug} » corrigé en « ${fixed} ».`);
      slug = fixed;
    }
    if (!slug && d.fr.title) { slug = slugify(d.fr.title, true); fixes.push(`"slug" absent : généré depuis le titre (« ${slug} »).`); }
    if (!slug) errors.push(`"slug" est obligatoire.`);
    if (slug && known.includes(slug)) warnings.push(`Le slug « ${slug} » existe déjà sur le site : publier remplacerait cet article.`);
    d.slug = slug;
    d.slugTouched = true;

    // Dates
    ["publishedAt", "updatedAt"].forEach((k) => {
      if (obj[k] == null) { d[k] = today(); fixes.push(`"${k}" absent : date du jour.`); }
      else if (!isDate(obj[k])) { d[k] = today(); warnings.push(`"${k}" « ${obj[k]} » invalide (format AAAA-MM-JJ) : date du jour.`); }
      else d[k] = obj[k];
    });
    if (d.updatedAt < d.publishedAt) { d.updatedAt = d.publishedAt; fixes.push(`"updatedAt" antérieur à "publishedAt" : aligné.`); }

    // Related
    const related = strList(obj.relatedSlugs, "relatedSlugs", { min: 0, max: 3 });
    if (indexKnown) {
      d.relatedSlugs = related.filter((r) => known.includes(r) && r !== slug);
      related.filter((r) => !d.relatedSlugs.includes(r)).forEach((r) => warnings.push(`Article lié « ${r} » inconnu : retiré.`));
    } else {
      d.relatedSlugs = related.filter((r) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(r) && r !== slug);
      if (related.length) warnings.push("Liste des articles du blog indisponible : les articles liés n'ont pas pu être vérifiés.");
    }

    // English
    const wantsEn = obj.enEnabled === true || (obj.enEnabled == null && obj.en != null);
    if (obj.enEnabled != null && typeof obj.enEnabled !== "boolean") errors.push(`"enEnabled" doit valoir true ou false.`);
    d.enEnabled = wantsEn;
    if (wantsEn) d.en = readLocale(obj.en, "en", true);
    else if (obj.en) warnings.push(`"en" présent mais "enEnabled" vaut false : version anglaise ignorée.`);

    // Images: resolve IMAGE:id placeholders against the brief.
    d.images = Array.isArray(obj.images) ? obj.images.filter((im) => im && isStr(im.src) && isStr(im.dataUrl) && im.dataUrl.startsWith("data:image/")) : [];
    const usedNames = new Set();
    const bodies = ["fr", ...(d.enEnabled ? ["en"] : [])];
    briefImages.forEach((img) => {
      let base = slugify(img.description || img.id, true).split("-").slice(0, 6).join("-") || img.id;
      while (usedNames.has(base)) base += "-2";
      usedNames.add(base);
      const src = `/images/blog/${slug || "article"}/${base}.${img.ext || "webp"}`;
      let placed = false;
      bodies.forEach((lang) => {
        const token = new RegExp(`\\(\\s*IMAGE:${img.id}(?=[\\s)"])`, "g");
        if (token.test(d[lang].body)) {
          placed = true;
          d[lang].body = d[lang].body.replace(token, `(${src}`);
        } else warnings.push(`Image ${img.id} (« ${img.description || "sans description"} ») non placée dans la version ${lang.toUpperCase()} : insérez-la à l'étape Rédaction (bouton « Insérer » dans la liste des images).`);
      });
      d.images.push({ src, dataUrl: img.dataUrl, bytes: img.bytes, width: img.width, height: img.height, alt: img.description || "" });
      if (!placed) fixes.push(`Image ${img.id} gardée dans le brouillon, prête à être insérée.`);
    });
    // Large tables: [[TABLE:id]] markers replaced by the full data.
    briefTables.filter((t) => t.markdown && isBigTable(t)).forEach((t) => {
      bodies.forEach((lang) => {
        const marker = new RegExp(`^[ \\t]*\\[\\[\\s*TABLE:${t.id}\\s*\\]\\][ \\t]*$`, "m");
        if (marker.test(d[lang].body)) d[lang].body = d[lang].body.replace(marker, t.markdown);
        else {
          const body = d[lang].body;
          const at = body.search(/\n## Sources\b/);
          d[lang].body = at === -1 ? `${body.trimEnd()}\n\n${t.markdown}\n` : `${body.slice(0, at)}\n\n${t.markdown}\n${body.slice(at)}`;
          fixes.push(`Tableau ${t.id} non placé par l'IA (${lang.toUpperCase()}) : ajouté ${at === -1 ? "à la fin" : "avant les sources"}, déplacez-le si besoin.`);
        }
      });
    });
    bodies.forEach((lang) => {
      const leftTables = d[lang].body.match(/\[\[\s*TABLE:[\w-]+\s*\]\]/g);
      if (leftTables) errors.push(`Version ${lang.toUpperCase()} : repère(s) de tableau inconnu(s) ${[...new Set(leftTables)].join(", ")}.`);
      const left = d[lang].body.match(/IMAGE:[\w-]+/g);
      if (left) errors.push(`Version ${lang.toUpperCase()} : image(s) inconnue(s) ${[...new Set(left)].join(", ")} (identifiant inventé ou modifié).`);
    });

    // Unknown root keys
    const rootKeys = new Set(["format", "version", "site", "slug", "publishedAt", "updatedAt", "relatedSlugs", "enEnabled", "fr", "en", "id", "slugTouched", "editingExisting", "autoReading", "images", "createdAt", "savedAt"]);
    Object.keys(obj).filter((k) => !rootKeys.has(k)).forEach((k) => warnings.push(`Champ inconnu ignoré : "${k}".`));

    d.autoReading = { fr: false, en: false };
    if (isStr(obj.id)) d.id = obj.id;
    if (obj.editingExisting === true) d.editingExisting = true;

    // A draft saved mid-way by this tool may legitimately have empty required fields.
    if (lenient) {
      for (let i = errors.length - 1; i >= 0; i--) {
        if (/obligatoire|est absent/.test(errors[i])) warnings.push(errors.splice(i, 1)[0].replace("est obligatoire", "est vide"));
      }
    }
    // Final safety net: the generated file must parse back exactly as the site will read it.
    if (!errors.length && d.slug) {
      try {
        const roundTrip = MD.parsePostFile(MD.buildPostFile(d));
        if (roundTrip.front.slug !== d.slug || roundTrip.bodies.fr !== d.fr.body.trim()) errors.push("Le fichier généré ne se relit pas correctement (contrôle interne).");
      } catch (error) {
        errors.push(`Le fichier généré serait illisible par le site : ${error.message}`);
      }
    }
    return { errors, warnings, fixes, draft: d };
  }

  function correctionMessage(report) {
    return `Ton JSON ne peut pas être importé. Corrige UNIQUEMENT ces points, sans changer le reste du contenu, et renvoie le JSON complet dans un seul bloc \`\`\`json, sans texte autour :\n\n${report.errors.map((e) => `- ${e}`).join("\n")}${
      report.warnings.length ? `\n\nSi possible, corrige aussi :\n${report.warnings.slice(0, 12).map((w) => `- ${w}`).join("\n")}` : ""
    }`;
  }

  function importJsonText(text, { fromBrief = false } = {}) {
    let obj;
    try {
      obj = extractJson(text);
    } catch (error) {
      return { errors: [error.message], warnings: [], fixes: [], draft: null, parseError: true };
    }
    // A full draft saved by this tool keeps its images; an AI answer uses the brief's.
    const ownDraft = Boolean(obj && obj.id && obj.createdAt);
    const useBrief = fromBrief && !ownDraft;
    return validateDraftJson(obj, { briefImages: useBrief ? state.brief.images : [], briefTables: useBrief ? state.brief.tables : [], lenient: ownDraft });
  }

  function applyImportedDraft(report, label) {
    if (hasContent(state.draft) && state.draft.id !== report.draft.id) saveToDrafts();
    const siteChanged = state.draft.site !== report.draft.site;
    state.draft = report.draft;
    if (siteChanged) loadBrief();
    applyTheme();
    autosave();
    state.screen = "wizard";
    state.step = "review";
    render();
    toast(`${label} importé : vérifiez chaque étape avant de publier.`, "ok");
  }

  /* ---------------- screens before the wizard ---------------- */

  function renderHome() {
    const d = state.draft;
    const cards = Object.values(SITES)
      .map(
        (s) => `<button class="home-card" data-action="choose-site" data-site="${s.id}" style="--c-ink:${s.theme.ink};--c-accent:${s.theme.accent};--c-soft:${s.theme.soft};--c-paper:${s.theme.paper}">
          <span class="home-card-band"></span>
          <span class="home-card-body">
            <small>${esc(s.domain.replace("https://", ""))}</small>
            <strong>${esc(s.name)}</strong>
            <span>${esc(s.tagline)}</span>
            <em><span data-blog-count="${s.id}">${esc(blogStatusText(s.id))}</span> · dépôt ${esc(s.repo)}</em>
          </span>
          <span class="home-card-cta">Choisir ce site →</span>
        </button>`
      )
      .join("");
    return `<div class="screen">
      <header class="screen-head center">
        <p class="kicker">Étape 1 sur 2</p>
        <h1>Pour quel site écrivez-vous&nbsp;?</h1>
        <p>Le site choisi définit le ton, les catégories, les pages pour les liens internes, le dépôt GitHub et le format des fichiers pour les IA.</p>
      </header>
      <div class="home-grid">${cards}</div>
      ${
        hasContent(d)
          ? `<div class="resume card"><div><small class="muted">Brouillon en cours · ${esc(SITES[d.site].name)}</small><strong>${esc(d.fr.title || "(sans titre)")}</strong></div><button class="btn btn-primary" data-action="resume">Reprendre ce brouillon</button></div>`
          : ""
      }
    </div>`;
  }

  function renderMode() {
    const s = site();
    return `<div class="screen">
      <button class="link-btn back" data-action="screen" data-screen="home">← Changer de site</button>
      <header class="screen-head center">
        <p class="kicker">Étape 2 sur 2 · ${esc(s.name)}</p>
        <h1>Que voulez-vous faire&nbsp;?</h1>
      </header>
      <div class="mode-grid">
        <button class="mode-card" data-action="mode" data-mode="manual">
          <span class="mode-icon" aria-hidden="true">✍️</span>
          <strong>Rédiger moi-même</strong>
          <span>Le constructeur pas à pas : vous écrivez chaque champ, avec la barre d'outils, l'aperçu et les contrôles SEO en direct.</span>
          <ul><li>Contrôle total du texte</li><li>Idéal pour modifier un article existant</li><li>Images, tableaux, liens, FAQ</li></ul>
          <em>Ouvrir le constructeur →</em>
        </button>
        <button class="mode-card featured" data-action="mode" data-mode="ai">
          <span class="mode-icon" aria-hidden="true">✨</span>
          <strong>Rédiger avec l'IA</strong>
          <span>Vous remplissez un court brief, l'outil génère le prompt à coller dans Claude ou ChatGPT, puis vous importez sa réponse.</span>
          <ul><li>Article complet, recherché et sourcé</li><li>Français et anglais, SEO inclus</li><li>Vos images et tableaux placés où vous voulez</li></ul>
          <em>Préparer le brief →</em>
        </button>
        <button class="mode-card" data-action="mode" data-mode="edit">
          <span class="mode-icon" aria-hidden="true">🛠️</span>
          <strong>Modifier un article publié</strong>
          <span>Retrouvez les articles en ligne directement depuis GitHub, ouvrez-en un dans le constructeur, corrigez, republiez.</span>
          <ul><li>Liste à jour des articles en ligne</li><li>Même adresse, même fichier remplacé</li><li>Mise à jour des llms incluse</li></ul>
          <em>Voir les articles →</em>
        </button>
      </div>
    </div>`;
  }

  function briefField({ label, key, rows = 0, placeholder = "", hint = "", required = false }) {
    const value = state.brief[key] ?? "";
    const control = rows
      ? `<textarea data-brief="${key}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
      : `<input type="text" data-brief="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}" />`;
    return `<label class="field"><span class="field-label">${label}${required ? ' <b class="req">*</b>' : ""}</span>${control}${hint ? `<small class="hint">${hint}</small>` : ""}</label>`;
  }

  function renderBriefTable(t, i) {
    const big = isBigTable(t);
    return `<div class="brief-table ${big ? "big" : ""}">
      <div class="row-between">
        <span><code>${t.id}</code> ${t.fileName ? `<small class="muted">${esc(t.fileName)}</small>` : ""} ${t.rows ? `<small class="muted">· ${t.rows} lignes × ${t.cols} colonnes</small>` : ""} ${big ? '<span class="pill">Grand tableau : fichier à joindre</span>' : ""}</span>
        <span class="row-actions">
          ${t.markdown ? `<button class="link-btn" data-action="brief-table-download" data-index="${i}">Télécharger le CSV</button>` : ""}
          <button class="link-btn danger" data-action="brief-table-remove" data-index="${i}">Retirer</button>
        </span>
      </div>
      <div class="grid-2">
        <input type="text" data-brief-table="${i}" data-key="title" value="${esc(t.title)}" placeholder="De quoi parle ce tableau ?" />
        <input type="text" data-brief-table="${i}" data-key="placement" value="${esc(t.placement)}" list="placements" placeholder="Où le placer ?" />
      </div>
      ${
        t.fileName
          ? ""
          : `<textarea rows="4" data-brief-table="${i}" data-key="paste" placeholder="Collez les cellules ici">${esc(t.paste || "")}</textarea>`
      }
      ${big ? `<p class="hint">Dans Claude ou ChatGPT, joignez le fichier <strong>${esc(t.fileName || `${t.id}.csv`)}</strong> (bouton « Télécharger le CSV » ci-dessus) en même temps que le prompt.</p>` : ""}
      <div class="table-preview prose" data-table-preview="${i}">${t.markdown ? MD.toHtml(t.markdown) : '<p class="muted small">L\'aperçu du tableau apparaîtra ici.</p>'}</div>
    </div>`;
  }

  const PLACEMENTS = ["Juste après le premier paragraphe", "Dans la section qui en parle le plus", "Avant la conclusion", "En illustration du tableau"];

  function renderAi() {
    const s = site();
    const b = state.brief;
    const report = state.aiReport;
    return `<div class="screen wide">
      <button class="link-btn back" data-action="screen" data-screen="mode">← Retour au choix</button>
      <header class="screen-head">
        <p class="kicker">${esc(s.name)} · Rédaction avec l'IA</p>
        <h1>Préparer l'article avec l'IA</h1>
        <p>Remplissez le brief, copiez le prompt dans Claude ou ChatGPT, puis importez la réponse. L'outil vérifie tout, place vos images, et vous publiez comme d'habitude.</p>
      </header>
      <ol class="ai-steps">
        <li class="card">
          <h3><span class="badge">1</span> Le sujet</h3>
          ${briefField({ label: "Sujet / angle de recherche", key: "subject", rows: 3, required: true, placeholder: s.id === "vhc" ? "Ex. Pourquoi les promoteurs perdent des ventes entre le premier contact et la réservation, et comment y remédier" : "Ex. Comment reconnaître une anxiété de performance au travail et quand consulter", hint: "Le plus précis possible : la question à laquelle l'article répond." })}
          <div class="grid-2">
            ${briefField({ label: "Titre de travail (facultatif)", key: "title", placeholder: "L'IA peut l'améliorer pour le SEO" })}
            ${briefField({ label: "Public visé", key: "audience", placeholder: s.id === "vhc" ? "Dirigeants de PME, directeurs commerciaux" : "Adultes actifs, cadres" })}
          </div>
          ${briefField({ label: "Objectif / message clé", key: "goal", rows: 2, placeholder: "Ce que le lecteur doit retenir ou faire après la lecture" })}
          ${briefField({ label: "Mots-clés souhaités (facultatif)", key: "keywords", placeholder: "séparés par des virgules, le premier = principal", hint: "Laissez vide pour que l'IA les choisisse." })}
        </li>
        <li class="card">
          <h3><span class="badge">2</span> Langues, longueur et sources</h3>
          <div class="grid-3">
            <div class="field"><span class="field-label">Langues</span>
              <label class="inline-check"><input type="checkbox" checked disabled /> Français (principal)</label><br/>
              <label class="inline-check"><input type="checkbox" data-brief-lang="en" ${b.languages.en ? "checked" : ""}/> Anglais</label>
            </div>
            <label class="field"><span class="field-label">Longueur du texte</span>
              <select data-brief="length">${[["900", "Courte · ~900 mots"], ["1400", "Standard · ~1 400 mots"], ["2000", "Approfondie · ~2 000 mots"], ["2600", "Guide complet · ~2 600 mots"]].map(([v, l]) => `<option value="${v}" ${b.length === v ? "selected" : ""}>${l}</option>`).join("")}</select>
            </label>
            ${briefField({ label: "Ton (facultatif)", key: "tone", placeholder: s.id === "vhc" ? "expert, direct, concret" : "chaleureux, rassurant, nuancé" })}
          </div>
          <label class="inline-check"><input type="checkbox" data-brief-check="research" ${b.research ? "checked" : ""}/> Demander une recherche avec sources vérifiables (section « Sources » en fin d'article)</label>
          <div class="grid-2 mt">
            ${briefField({ label: "Sources à utiliser (facultatif)", key: "sources", rows: 3, placeholder: "Une adresse ou une référence par ligne" })}
            ${briefField({ label: "Informations à intégrer (facultatif)", key: "facts", rows: 3, placeholder: "Chiffres internes, offre à mettre en avant, exemple vécu…" })}
          </div>
          ${briefField({ label: "À éviter (facultatif)", key: "avoid", rows: 2, placeholder: "Sujets, formulations ou promesses à ne pas faire" })}
        </li>
        <li class="card">
          <h3><span class="badge">3</span> Images <small class="muted">(facultatif)</small></h3>
          <p class="muted small">Importez vos images et dites ce qu'elles montrent et où les placer. Elles sont converties en WebP et l'IA place un repère à l'endroit voulu ; à l'import, l'outil remplace ce repère par la vraie image.</p>
          <label class="drop"><input type="file" accept="image/*" multiple data-action="brief-images" hidden /><strong>Ajouter des images</strong><span>JPG, PNG ou WebP · plusieurs à la fois</span></label>
          <datalist id="placements">${PLACEMENTS.map((p) => `<option value="${esc(p)}"></option>`).join("")}</datalist>
          ${b.images
            .map(
              (img, i) => `<div class="brief-item">
                <img src="${img.dataUrl}" alt="" />
                <div class="brief-item-fields">
                  <div class="row-between"><code>${img.id}</code><small class="muted">${img.width}×${img.height} · ${Math.round(img.bytes / 1024)} Ko</small></div>
                  <input type="text" data-brief-img="${i}" data-key="description" value="${esc(img.description)}" placeholder="Ce que montre l'image (sert au texte alternatif) *" />
                  <input type="text" data-brief-img="${i}" data-key="placement" value="${esc(img.placement)}" list="placements" placeholder="Où la placer ? (ex. dans la section sur le suivi des prospects)" />
                  <input type="text" data-brief-img="${i}" data-key="caption" value="${esc(img.caption)}" placeholder="Légende affichée sous l'image (facultatif)" />
                </div>
                <button class="icon-btn" data-action="brief-image-remove" data-index="${i}" title="Retirer">×</button>
              </div>`
            )
            .join("")}
        </li>
        <li class="card">
          <h3><span class="badge">4</span> Tableaux <small class="muted">(facultatif)</small></h3>
          <p class="muted small">Collez un tableau depuis Excel, Google Sheets ou Word, ou importez un fichier CSV. Les petits tableaux sont donnés à l'IA dans le prompt. Les grands tableaux (plus de ${BIG_TABLE_ROWS} lignes) ne le sont pas : vous joignez le fichier dans Claude ou ChatGPT, l'IA place un repère, et l'outil insère le tableau complet à l'import, sans risque d'erreur sur les chiffres.</p>
          ${b.tables.map((t, i) => renderBriefTable(t, i)).join("")}
          <div class="row-actions">
            <button class="btn btn-ghost" data-action="brief-table-add">+ Coller un tableau</button>
            <label class="btn btn-ghost"><input type="file" accept=".csv,.tsv,.txt,text/csv" multiple data-action="brief-csv" hidden />Importer un fichier CSV</label>
          </div>
        </li>
        <li class="card prompt-card">
          <h3><span class="badge">5</span> Le prompt à copier</h3>
          ${b.subject.trim() ? "" : '<p class="check check-warn"><span class="dot"></span>Renseignez au moins le sujet (étape 1).</p>'}
          ${b.images.some((im) => !im.description.trim()) ? '<p class="check check-warn"><span class="dot"></span>Décrivez chaque image : l\'IA s\'en sert pour le texte alternatif et l\'emplacement.</p>' : ""}
          ${
            b.tables.filter((t) => t.markdown && isBigTable(t)).length
              ? `<div class="note">À joindre avec le prompt : ${b.tables
                  .filter((t) => t.markdown && isBigTable(t))
                  .map((t, k) => `<button class="link-btn" data-action="brief-table-download" data-index="${b.tables.indexOf(t)}">${esc(t.fileName || `${t.id}.csv`)}</button>`)
                  .join(", ")}</div>`
              : ""
          }
          <textarea class="prompt-box" id="prompt-box" readonly>${esc(buildPrompt())}</textarea>
          <div class="row-between">
            <small class="muted" id="prompt-size"></small>
            <div class="row-actions">
              <button class="btn btn-primary" data-action="copy-prompt">Copier le prompt</button>
              <a class="btn btn-ghost" href="https://claude.ai/new" target="_blank" rel="noopener">Ouvrir Claude ↗</a>
              <a class="btn btn-ghost" href="https://chatgpt.com/" target="_blank" rel="noopener">Ouvrir ChatGPT ↗</a>
            </div>
          </div>
          <details class="mt"><summary>Conseils</summary>
            <ul class="checks plain">
              <li>Activez la recherche web (Claude : « Recherche » ; ChatGPT : « Rechercher ») pour des sources réelles.</li>
              <li>Les images ne sont pas envoyées à l'IA : seule leur description l'est. Elles restent dans votre navigateur.</li>
              <li>Si la réponse est coupée, écrivez « continue » puis collez la réponse complète ci-dessous.</li>
              <li>Relisez toujours le texte : vous publiez sous votre nom.</li>
            </ul>
          </details>
        </li>
        <li class="card">
          <h3><span class="badge">6</span> Importer la réponse de l'IA</h3>
          <p class="muted small">Collez toute la réponse (le bloc \`\`\`json suffit) ou chargez un fichier .json. L'outil valide la structure champ par champ avant d'importer.</p>
          <textarea rows="7" data-brief="response" class="mono" placeholder='\`\`\`json\n{ "format": "blogpost-draft", … }\n\`\`\`'>${esc(b.response)}</textarea>
          <div class="row-actions mt">
            <button class="btn btn-primary" data-action="ai-validate">Vérifier et importer</button>
            <label class="btn btn-ghost"><input type="file" accept=".json,application/json,.txt" data-action="ai-file" hidden />Charger un fichier .json</label>
          </div>
          <div id="ai-report">${report ? renderReport(report) : ""}</div>
        </li>
      </ol>
    </div>`;
  }

  function renderReport(r) {
    const list = (items, cls) => (items.length ? `<ul class="checks">${items.map((m) => `<li class="check check-${cls}"><span class="dot"></span><span>${esc(m)}</span></li>`).join("")}</ul>` : "");
    if (r.errors.length) {
      return `<div class="report report-error">
        <h4>${r.errors.length} erreur(s) bloquante(s) : rien n'a été importé</h4>
        ${list(r.errors, "error")}
        ${r.warnings.length ? `<h4 class="mt">Avertissements</h4>${list(r.warnings, "warn")}` : ""}
        <div class="row-actions mt"><button class="btn btn-primary" data-action="copy-correction">Copier un message de correction pour l'IA</button></div>
        <p class="muted small">Collez ce message dans la même conversation : l'IA renverra un JSON corrigé, à recoller ici.</p>
      </div>`;
    }
    return `<div class="report report-ok">
      <h4>Structure valide</h4>
      ${r.fixes.length ? `<p class="muted small">Corrigé automatiquement :</p>${list(r.fixes, "ok")}` : ""}
      ${r.warnings.length ? `<p class="muted small">À vérifier après l'import :</p>${list(r.warnings, "warn")}` : ""}
      <div class="row-actions mt"><button class="btn btn-primary" data-action="ai-apply">Importer et vérifier l'article →</button></div>
    </div>`;
  }

  function refreshPrompt() {
    const box = $("#prompt-box");
    if (!box) return;
    box.value = buildPrompt();
    const size = $("#prompt-size");
    if (size) size.textContent = `${box.value.length.toLocaleString("fr-FR")} caractères`;
  }

  /* ---- edit a published article straight from GitHub ---- */

  function renderEdit() {
    const s = site();
    const cfg = ghSettings();
    const b = blogState(s.id);
    const e = { posts: b.posts.length || b.status === "ok" ? b.posts : null, loading: b.status === "loading", error: b.error, loadedAt: b.loadedAt ? new Date(b.loadedAt) : null };
    const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "");
    const list = e.posts
      ? `<div class="row-between edit-tools">
          <input type="search" class="search" data-edit-filter placeholder="Rechercher un article (titre, catégorie, slug)" />
          <span class="muted small">${esc(blogStatusText(s.id))}</span>
        </div>
        <div class="edit-list">${e.posts
          .map(
            (p) => `<article class="edit-row" data-edit-row="${esc(`${p.title} ${p.category} ${p.slug}`.toLowerCase())}">
              <div class="edit-main">
                <small class="muted">${esc(p.category)}${p.publishedAt ? ` · publié le ${fmt(p.publishedAt)}` : ""}${p.updatedAt && p.updatedAt !== p.publishedAt ? ` · mis à jour le ${fmt(p.updatedAt)}` : ""}</small>
                <strong>${esc(p.title)}</strong>
                ${p.broken ? `<p class="check check-error"><span class="dot"></span>Fichier illisible : ${esc(p.broken)}</p>` : `<p class="muted small">${esc(p.description)}</p>`}
                <div class="tags"><code>/blog/${esc(p.slug)}/</code>${p.words ? `<span>${p.words} mots</span>` : ""}${p.readingTime ? `<span>${esc(p.readingTime)}</span>` : ""}<span>${p.en ? "FR + EN" : "FR seulement"}</span>${p.images ? `<span>${p.images} image(s)</span>` : ""}</div>
              </div>
              <div class="edit-actions">
                <button class="btn btn-primary" data-action="edit-open" data-slug="${esc(p.slug)}" ${p.broken ? "disabled" : ""}>Modifier</button>
                <a class="btn btn-ghost" href="${s.domain}/blog/${esc(p.slug)}/" target="_blank" rel="noopener">Voir en ligne ↗</a>
                <a class="link-btn" href="https://github.com/${esc(cfg.repo)}/blob/${esc(cfg.branch)}/data/blogs/${esc(p.slug)}.md" target="_blank" rel="noopener">Fichier sur GitHub</a>
              </div>
            </article>`
          )
          .join("")}</div>
        <p class="muted small mt">Après modification, l'article s'ouvre dans le constructeur (date « Mis à jour le » passée à aujourd'hui). Publiez depuis l'étape « Publier » : le même fichier est remplacé, l'adresse ne change pas.</p>`
      : `<p class="muted">${e.loading ? "Lecture des articles sur GitHub…" : "Cliquez sur « Charger les articles »."}</p>`;
    return `<div class="screen wide">
      <button class="link-btn back" data-action="screen" data-screen="mode">← Retour au choix</button>
      <header class="screen-head">
        <p class="kicker">${esc(s.name)} · Articles publiés</p>
        <h1>Modifier un article publié</h1>
        <p>Les articles sont lus directement sur GitHub (<code>${esc(cfg.repo)}</code>, branche <code>${esc(cfg.branch)}</code>), c'est-à-dire la version réellement en ligne. ${cfg.token ? "" : "Sans jeton, la lecture fonctionne pour un dépôt public ; un jeton reste nécessaire pour publier."}</p>
      </header>
      <div class="edit-layout">
        <section class="card">
          <div class="row-between"><h3>Articles</h3><button class="btn btn-ghost" data-action="edit-load" ${e.loading ? "disabled" : ""}>${e.loading ? "Lecture…" : e.posts ? "Actualiser" : "Charger les articles"}</button></div>
          ${e.error ? `<p class="check check-error"><span class="dot"></span>${esc(e.error)}</p>` : ""}
          ${list}
        </section>
        <aside class="card gh-inline">${renderGhPanel()}</aside>
      </div>
    </div>`;
  }

  function renderScreen() {
    if (state.screen === "home") return renderHome();
    if (state.screen === "mode") return renderMode();
    if (state.screen === "edit") return renderEdit();
    return renderAi();
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
    onBlogChip();
  }

  function renderSidebar() {
    $("#steps").innerHTML = STEPS.map(
      (s, i) => `<li><button data-action="go" data-step="${s.id}" class="${state.step === s.id ? "active" : ""}"><span class="step-num">${i + 1}</span><span class="step-text"><strong>${s.label}</strong><small>${s.hint}</small></span><span class="step-dot"></span></button></li>`
    ).join("");
  }

  function render({ keepScroll = false } = {}) {
    const main = $("#main");
    const scroll = window.scrollY;
    const full = state.screen !== "wizard";
    document.body.classList.toggle("screen-full", full);
    try {
      sessionStorage.setItem(STORE_SCREEN, state.screen);
    } catch {}
    if (full) {
      $("#aside-gh").innerHTML = "";
      main.innerHTML = renderScreen();
      refreshPrompt();
      window.scrollTo(0, keepScroll ? scroll : 0);
      return;
    }
    main.innerHTML = RENDERERS[state.step]();
    renderSidebar();
    const stepInfo = STEPS.find((s) => s.id === state.step);
    $("#aside-title").textContent = `Contrôles · ${stepInfo.label}`;
    $("#aside-gh").innerHTML = renderGhPanel();
    refreshLive();
    // On mobile the steps are a horizontal strip: keep the current one visible.
    const strip = $("#steps");
    const current = $(".steps .active");
    if (strip && current && strip.scrollWidth > strip.clientWidth) {
      strip.scrollLeft = current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2;
    }
    if (keepScroll) window.scrollTo(0, scroll);
    else window.scrollTo(0, 0);
    try {
      sessionStorage.setItem(STORE_STEP, state.step);
    } catch {}
  }

  function go(step) {
    state.screen = "wizard";
    state.step = step;
    render();
  }

  function startSite(id) {
    if (id !== state.draft.site) {
      if (hasContent(state.draft)) saveToDrafts();
      state.draft = newDraft(id);
      autosave();
    }
    applyTheme();
    loadBrief();
    loadBlogIndex(id);
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
    const posts = knownPosts();
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
          d.images.push({ src, dataUrl: processed.dataUrl, bytes: processed.bytes, width: processed.width, height: processed.height, alt });
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
    let bigRows = null;
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
        <div class="row-actions mt"><label class="btn btn-ghost"><input type="file" accept=".csv,.tsv,.txt,text/csv" data-csv hidden />Importer un fichier CSV</label><span class="muted small" id="csv-info"></span></div>
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
        const fill = (parsed, label) => {
          if (!parsed.length) return toast("Aucune donnée lisible.", "error");
          const width = Math.max(...parsed.map((r) => r.length));
          if (parsed.length > 30 || width > 8) {
            // Too big for the editable grid: inserted as is.
            bigRows = parsed;
            $("#grid", dlg).innerHTML = `<div class="table-preview prose">${MD.toHtml(rowsToMarkdown(parsed))}</div>`;
            $("#grid", dlg).style.gridTemplateColumns = "1fr";
            $("#csv-info", dlg).textContent = `${label} : ${parsed.length - 1} lignes × ${width} colonnes, inséré tel quel.`;
            return;
          }
          bigRows = null;
          grid = parsed;
          rows = Math.max(2, parsed.length);
          cols = Math.max(2, width);
          $("input[name=rows]", dlg).value = rows;
          $("input[name=cols]", dlg).value = cols;
          $("#csv-info", dlg).textContent = label;
          drawGrid(dlg);
        };
        $("[data-paste]", dlg).addEventListener("click", () => fill(tableRows($("textarea[name=paste]", dlg).value), "Tableau collé"));
        $("[data-csv]", dlg).addEventListener("change", async (e) => {
          const file = e.target.files[0];
          if (file) fill(parseCsv(await file.text()), file.name);
        });
      },
      onSubmit() {
        if (bigRows) return insertBlock(ta, rowsToMarkdown(bigRows));
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
    if (!cfg.token) throw new Error("Collez d'abord un jeton dans le panneau « Connexion GitHub ».");
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
      await loadBlogIndex(site().id, { force: true });
      const slugs = blogPosts().map((p) => p.slug);
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
      await loadBlogIndex(site().id, { force: true });
      if (blogState().error) throw new Error(blogState().error);
      const slugs = blogPosts().map((p) => p.slug);
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
      const text = await fetchRepoFile(site().id, `data/blogs/${slug}.md`);
      if (!text) throw new Error("Fichier introuvable.");
      importPostText(text);
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
      if (!res.prUrl) loadBlogIndex(s.id, { force: true });
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
      if (t.dataset.editFilter !== undefined) {
        const q = norm(t.value.trim());
        $$("[data-edit-row]").forEach((row) => (row.hidden = q && !norm(row.dataset.editRow).includes(q)));
      }
      if (t.dataset.brief) {
        state.brief[t.dataset.brief] = t.value;
        saveBrief();
        if (t.dataset.brief !== "response") refreshPrompt();
        else state.aiReport = null;
      }
      if (t.dataset.briefImg) {
        state.brief.images[+t.dataset.briefImg][t.dataset.key] = t.value;
        saveBrief();
        refreshPrompt();
      }
      if (t.dataset.briefTable) {
        const tb = state.brief.tables[+t.dataset.briefTable];
        tb[t.dataset.key] = t.value;
        if (t.dataset.key === "paste") {
          const wasBig = isBigTable(tb);
          updateTable(tb, t.value);
          if (wasBig !== isBigTable(tb)) {
            saveBrief();
            render({ keepScroll: true });
            const again = $(`[data-brief-table="${t.dataset.briefTable}"][data-key="paste"]`);
            again?.focus();
            return;
          }
          const pv = $(`[data-table-preview="${t.dataset.briefTable}"]`);
          if (pv) pv.innerHTML = tb.markdown ? MD.toHtml(tb.markdown) : "";
        }
        saveBrief();
        refreshPrompt();
      }
      if (t.dataset.bind) onBindInput(t);
      if (t.dataset.gh && t.type !== "radio" && t.type !== "checkbox") {
        const cfg = ghSettings();
        cfg[t.dataset.gh] = t.value;
        saveGhSettings(cfg);
        state.gh.checked = null;
        const testBtn = $("[data-action=gh-check]");
        if (testBtn) testBtn.disabled = !cfg.token;
      }
    });

    document.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.briefLang) {
        state.brief.languages[t.dataset.briefLang] = t.checked;
        saveBrief();
        refreshPrompt();
      }
      if (t.dataset.briefCheck) {
        state.brief[t.dataset.briefCheck] = t.checked;
        saveBrief();
        refreshPrompt();
      }
      if (t.tagName === "SELECT" && t.dataset.brief) {
        state.brief[t.dataset.brief] = t.value;
        saveBrief();
        refreshPrompt();
      }
      if (t.dataset.action === "brief-images") {
        const files = Array.from(t.files || []);
        t.value = "";
        (async () => {
          for (const file of files) {
            try {
              const img = await fileToWebp(file);
              const n = Math.max(0, ...state.brief.images.map((x) => +x.id.split("-")[1] || 0)) + 1;
              state.brief.images.push({ id: `img-${n}`, ...img, description: "", placement: "", caption: "" });
            } catch (error) {
              toast(`${file.name} : ${error.message}`, "error");
            }
          }
          saveBrief();
          render({ keepScroll: true });
        })();
        return;
      }
      if (t.dataset.action === "brief-csv") {
        const files = Array.from(t.files || []);
        t.value = "";
        Promise.all(files.map((f) => f.text().then((text) => ({ name: f.name, text })))).then((list) => {
          list.forEach(({ name, text }) => {
            const n = Math.max(0, ...state.brief.tables.map((x) => +x.id.split("-")[1] || 0)) + 1;
            const tb = { id: `tab-${n}`, title: name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "), placement: "", fileName: name.replace(/\.[^.]+$/, "") + ".csv" };
            updateTable(tb, text);
            if (!tb.rows) toast(`${name} : aucune donnée lisible.`, "error");
            else state.brief.tables.push(tb);
          });
          saveBrief();
          render({ keepScroll: true });
        });
        return;
      }
      if (t.dataset.action === "ai-file") {
        readFile(t, (text) => {
          state.brief.response = text;
          saveBrief();
          state.aiReport = importJsonText(text, { fromBrief: true });
          state.aiPending = state.aiReport;
          render({ keepScroll: true });
          $("#ai-report")?.scrollIntoView({ block: "start", behavior: "smooth" });
        });
        return;
      }
      if (t.dataset.bindCheck) {
        setPath(state.draft, t.dataset.bindCheck, t.checked);
        if (t.dataset.bindCheck.startsWith("autoReading") && t.checked) {
          const loc = t.dataset.bindCheck.split(".")[1];
          state.draft[loc].readingTime = readingTimeFor(state.draft[loc].body);
        }
        scheduleSave();
        render({ keepScroll: true });
      }
      if (t.dataset.gh === "token" || t.dataset.gh === "repo" || t.dataset.gh === "branch") loadBlogIndex(site().id, { force: true });
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
          const report = importJsonText(text, { fromBrief: true });
          showReportModal(report, report.errors.length ? "Ce fichier ne peut pas être importé" : "Vérification du fichier");
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
        "go-home": () => {
          state.screen = "home";
          render();
        },
        screen: () => {
          state.screen = el.dataset.screen;
          render();
        },
        "choose-site": () => {
          startSite(el.dataset.site);
          state.screen = "mode";
          render();
        },
        resume: () => {
          applyTheme();
          loadBrief();
          go(state.step === "start" ? "article" : state.step);
        },
        mode: () => {
          if (el.dataset.mode === "ai" || el.dataset.mode === "edit") {
            state.screen = el.dataset.mode;
            render();
            if (el.dataset.mode === "edit") loadBlogIndex(site().id, { force: true });
            return;
          }
          go(hasContent(state.draft) ? "start" : "article");
        },
        "brief-image-remove": () => {
          state.brief.images.splice(+el.dataset.index, 1);
          saveBrief();
          render({ keepScroll: true });
        },
        "brief-table-add": () => {
          const n = Math.max(0, ...state.brief.tables.map((x) => +x.id.split("-")[1] || 0)) + 1;
          state.brief.tables.push({ id: `tab-${n}`, title: "", placement: "", paste: "", markdown: "" });
          saveBrief();
          render({ keepScroll: true });
        },
        "edit-load": () => loadBlogIndex(site().id, { force: true }),
        "edit-open": async () => {
          const slug = el.dataset.slug;
          el.disabled = true;
          el.textContent = "Ouverture…";
          try {
            // Always the current version from the repository, never a cached copy.
            const text = await fetchRepoFile(site().id, `data/blogs/${slug}.md`);
            if (!text) throw new Error("Fichier introuvable sur GitHub.");
            if (hasContent(state.draft) && state.draft.slug !== slug) saveToDrafts();
            importPostText(text, site().id);
          } catch (error) {
            toast(`Import impossible : ${error.message}`, "error");
            el.disabled = false;
            el.textContent = "Modifier";
          }
        },
        "blog-refresh": () => loadBlogIndex(site().id, { force: true }),
        "brief-table-download": () => {
          const tb = state.brief.tables[+el.dataset.index];
          download(tb.fileName || `${tb.id}.csv`, "\uFEFF" + (tb.csv || rowsToCsv(tableRows(tb.paste))), "text/csv;charset=utf-8");
        },
        "brief-table-remove": () => {
          state.brief.tables.splice(+el.dataset.index, 1);
          saveBrief();
          render({ keepScroll: true });
        },
        "copy-prompt": () => {
          if (!state.brief.subject.trim()) {
            toast("Renseignez d'abord le sujet (étape 1).", "error");
            return;
          }
          copy(buildPrompt());
        },
        "ai-validate": () => {
          state.aiReport = importJsonText(state.brief.response, { fromBrief: true });
          render({ keepScroll: true });
          $("#ai-report")?.scrollIntoView({ block: "start", behavior: "smooth" });
        },
        "ai-apply": () => {
          if (!state.aiReport || state.aiReport.errors.length) return;
          applyImportedDraft(state.aiReport, "Article de l'IA");
          state.aiReport = null;
        },
        "copy-correction": () => state.aiReport && copy(correctionMessage(state.aiReport)),
        "image-insert": () => {
          const img = d.images[+el.dataset.index];
          const loc = state.step === "english" ? "en" : "fr";
          const ta = activeEditor(loc);
          if (!ta) return toast("Ouvrez l'éditeur (étape Rédaction) pour insérer l'image.", "error");
          insertBlock(ta, `![${(img.alt || "Décrivez l'image").replace(/[\[\]]/g, "")}](${img.src})`);
        },
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
          d.en.category = blogCategories().find((c) => c.fr === d.fr.category)?.en || d.fr.category;
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
        "toggle-token": () => {
          const input = $("#gh-token");
          input.type = input.type === "password" ? "text" : "password";
        },
        "gh-forget": () => {
          const cfg = ghSettings();
          cfg.token = "";
          cfg.remember = false;
          saveGhSettings(cfg);
          state.gh.checked = null;
          toast("Jeton effacé de ce navigateur.", "ok");
          render({ keepScroll: true });
        },
        "focus-token": () => {
          const input = $("#gh-token");
          input.scrollIntoView({ block: "center", behavior: "smooth" });
          setTimeout(() => input.focus(), 300);
        },
        "token-help": () => {
          state.step = "publish";
          state.publishTab = "auto";
          render();
          const det = $(".main details");
          if (det) det.open = true;
        },
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
    try {
      const screen = sessionStorage.getItem(STORE_SCREEN);
      if (["home", "mode", "ai", "edit", "wizard"].includes(screen)) state.screen = screen;
    } catch {}
    applyTheme();
    loadBrief();
    bindEvents();
    render();
    renderSaveStatus();
    loadBlogIndex(state.draft.site);
    Object.keys(SITES).filter((id) => id !== state.draft.site).forEach((id) => loadBlogIndex(id));
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
