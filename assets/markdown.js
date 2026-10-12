/* Port of lib/markdown.ts from the sites, so the preview matches what will be published.
   Also: post file (de)serialisation, markdown lint and llms.txt updaters. */
(function () {
  const FENCE = /^```([\w-]+)?\s*$/;
  const IMAGE = /^!\[([^\]]*)\]\((\S+?)(?:\s+"([^"]*)")?\)$/;
  const LINKED_IMAGE = /^\[!\[([^\]]*)\]\((\S+?)(?:\s+"([^"]*)")?\)\]\((\S+?)\)$/;

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // Same rule as the sites (accents are dropped, not transliterated).
  function slugifyHeading(value) {
    return value.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
  }

  function inline(value, opts) {
    return esc(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
        const external = /^https?:\/\//.test(href);
        const target = external ? href : opts.resolveLink(href);
        return `<a href="${target}" target="_blank" rel="noopener noreferrer"${external ? "" : ' class="internal"'}>${label}</a>`;
      });
  }

  const isHeading = (l) => l.startsWith("## ") || l.startsWith("### ");
  const isList = (l) => l.startsWith("- ");
  const isQuote = (l) => l.startsWith("> ");
  const isTable = (l) => l.startsWith("|") && l.endsWith("|") && l.length > 1;
  const isTableSep = (l) => /^\|(?:\s*:?-+:?\s*\|)+$/.test(l);
  const isImage = (l) => IMAGE.test(l) || LINKED_IMAGE.test(l);
  const isFence = (l) => FENCE.test(l);
  const splitRow = (l) => l.slice(1, -1).split("|").map((c) => c.trim());

  function toHtml(markdown, options = {}) {
    const opts = {
      resolveImage: (src) => src,
      resolveLink: (href) => href,
      ...options,
    };
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) { i++; continue; }

      if (isHeading(line)) {
        const level = line.startsWith("### ") ? 3 : 2;
        const title = line.replace(/^#{2,3}\s+/, "").trim();
        out.push(`<h${level} id="${slugifyHeading(title)}">${inline(title, opts)}</h${level}>`);
        i++; continue;
      }

      if (isFence(line)) {
        const lang = line.match(FENCE)?.[1];
        const code = [];
        i++;
        while (i < lines.length && !isFence(lines[i].trim())) { code.push(lines[i]); i++; }
        if (i < lines.length) i++;
        out.push(`<div class="md-code"><div class="md-code-head">${esc(lang || "code")}</div><pre><code>${esc(code.join("\n").trim())}</code></pre></div>`);
        continue;
      }

      if (isImage(line)) {
        const linked = line.match(LINKED_IMAGE);
        const plain = line.match(IMAGE);
        const m = linked || plain;
        const alt = m[1], src = m[2], caption = m[3], href = linked ? m[4] : null;
        let img = `<img src="${esc(opts.resolveImage(src))}" alt="${esc(alt)}" loading="lazy" />`;
        if (href) img = `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${img}</a>`;
        out.push(`<figure>${img}${caption ? `<figcaption>${inline(caption, opts)}</figcaption>` : ""}</figure>`);
        i++; continue;
      }

      if (isTable(line) && i + 1 < lines.length && isTableSep(lines[i + 1].trim())) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && isTable(lines[i].trim())) {
          const cells = splitRow(lines[i].trim());
          while (cells.length < head.length) cells.push("");
          rows.push(cells.slice(0, head.length));
          i++;
        }
        out.push(
          `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c, opts)}</th>`).join("")}</tr></thead><tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c, opts)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table></div>`
        );
        continue;
      }

      if (isQuote(line)) {
        const q = [];
        while (i < lines.length && isQuote(lines[i].trim())) { q.push(lines[i].trim().slice(2)); i++; }
        out.push(`<blockquote>${inline(q.join(" "), opts)}</blockquote>`);
        continue;
      }

      if (isList(line)) {
        const items = [];
        while (i < lines.length && isList(lines[i].trim())) { items.push(lines[i].trim().slice(2)); i++; }
        out.push(`<ul>${items.map((it) => `<li>${inline(it, opts)}</li>`).join("")}</ul>`);
        continue;
      }

      const para = [];
      while (i < lines.length) {
        const cur = lines[i].trim();
        if (!cur || isHeading(cur) || isList(cur) || isFence(cur) || isImage(cur) || isQuote(cur) || isTable(cur)) break;
        para.push(cur);
        i++;
      }
      out.push(`<p>${inline(para.join(" "), opts)}</p>`);
    }
    return out.join("\n");
  }

  function headings(markdown) {
    const result = [];
    let inFence = false;
    String(markdown || "").split("\n").forEach((raw) => {
      const line = raw.trim();
      if (isFence(line)) { inFence = !inFence; return; }
      if (inFence || !isHeading(line)) return;
      const title = line.replace(/^#{2,3}\s+/, "").trim();
      result.push({ level: line.startsWith("### ") ? 3 : 2, title, id: slugifyHeading(title) });
    });
    return result;
  }

  function plainText(markdown) {
    return String(markdown || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[#>*`|_-]/g, " ");
  }

  function wordCount(markdown) {
    const words = plainText(markdown).trim().split(/\s+/).filter(Boolean);
    return words.length;
  }

  /* Things the site renderer does NOT support, or that hurt quality. */
  function lint(markdown, { noEmDash = true } = {}) {
    const issues = [];
    let inFence = false;
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    lines.forEach((raw, idx) => {
      const n = idx + 1;
      const line = raw.trim();
      if (isFence(line)) { inFence = !inFence; return; }
      if (inFence || !line) return;
      if (/^#\s/.test(line)) issues.push({ n, level: "error", msg: "Titre de niveau 1 (#) : la page a déjà un H1 (le titre). Utilisez ## ou ###." });
      else if (/^#{4,}\s/.test(line)) issues.push({ n, level: "error", msg: "Les titres #### ne sont pas pris en charge (affichés comme texte). Utilisez ### au maximum." });
      if (/^\d+[.)]\s/.test(line)) issues.push({ n, level: "error", msg: "Les listes numérotées (1.) ne sont pas prises en charge : elles s'affichent en paragraphe. Utilisez « - » ou des sous-titres ###." });
      if (/^[*+]\s/.test(line)) issues.push({ n, level: "error", msg: "Seules les listes avec « - » sont prises en charge." });
      if (/^\s{2,}-\s/.test(raw)) issues.push({ n, level: "warn", msg: "Les sous-listes (indentées) sont aplaties à l'affichage." });
      if (line.includes("![") && !isImage(line)) issues.push({ n, level: "error", msg: "Une image doit être seule sur sa ligne, sinon elle n'est pas affichée." });
      if (/(^|\s)__?[^_\s][^_]*__?(\s|$)/.test(line)) issues.push({ n, level: "warn", msg: "Le gras/italique avec _ n'est pas pris en charge : utilisez **gras** et *italique*." });
      if (/<\/?[a-z][^>]*>/i.test(line)) issues.push({ n, level: "warn", msg: "Le HTML n'est pas interprété : il s'affichera tel quel." });
      if (/^(-{3,}|\*{3,})$/.test(line)) issues.push({ n, level: "warn", msg: "Les séparateurs horizontaux (---) ne sont pas pris en charge." });
      if (isTable(line) && idx + 1 < lines.length && !isTable(lines[idx - 1]?.trim() || "") && !isTableSep(lines[idx + 1].trim()))
        issues.push({ n, level: "error", msg: "Tableau sans ligne de séparation (| --- | --- |) juste sous l'en-tête." });
      if (noEmDash && line.includes("—")) issues.push({ n, level: "warn", msg: "Tiret cadratin (—) : remplacez-le par une virgule, deux-points ou des parenthèses." });
      const imgMatch = line.match(IMAGE) || line.match(LINKED_IMAGE);
      if (imgMatch && !imgMatch[1].trim()) issues.push({ n, level: "error", msg: "Image sans texte alternatif (alt) : obligatoire pour l'accessibilité et le SEO." });
      for (const m of line.matchAll(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g)) {
        const href = m[2];
        if (!/^(https?:\/\/|\/|#|mailto:|tel:)/.test(href)) issues.push({ n, level: "warn", msg: `Lien « ${href} » : commencez par / (page du site) ou https:// (site externe).` });
      }
    });
    if (inFence) issues.push({ n: lines.length, level: "error", msg: "Bloc de code ``` non refermé." });
    return issues;
  }

  /* ---------- Post file format (JSON frontmatter + locale bodies) ---------- */

  const LOCALIZED_KEYS = ["category", "title", "seoTitle", "description", "excerpt", "readingTime", "keywords", "heroEyebrow", "intro", "keyTakeaways", "faq", "cta"];

  function buildPostFile(draft) {
    const fr = draft.fr;
    const front = {
      slug: draft.slug,
      category: fr.category,
      title: fr.title,
      seoTitle: fr.seoTitle,
      description: fr.description,
      excerpt: fr.excerpt,
      publishedAt: draft.publishedAt,
      updatedAt: draft.updatedAt || draft.publishedAt,
      readingTime: fr.readingTime,
      keywords: fr.keywords.filter(Boolean),
      heroEyebrow: fr.heroEyebrow,
      intro: fr.intro,
      keyTakeaways: fr.keyTakeaways.filter(Boolean),
      faq: fr.faq.filter((f) => f.question && f.answer),
      relatedSlugs: draft.relatedSlugs.filter(Boolean),
      cta: { ...fr.cta },
    };
    if (draft.enEnabled) {
      const en = draft.en;
      front.locales = {
        en: {
          category: en.category,
          title: en.title,
          seoTitle: en.seoTitle,
          description: en.description,
          excerpt: en.excerpt,
          readingTime: en.readingTime,
          keywords: en.keywords.filter(Boolean),
          heroEyebrow: en.heroEyebrow,
          intro: en.intro,
          keyTakeaways: en.keyTakeaways.filter(Boolean),
          faq: en.faq.filter((f) => f.question && f.answer),
          cta: { ...en.cta },
        },
      };
    }
    let body = `<!-- locale:fr -->\n${fr.body.trim()}\n`;
    if (draft.enEnabled && draft.en.body.trim()) body += `\n<!-- locale:en -->\n${draft.en.body.trim()}\n`;
    return `---\n${JSON.stringify(front, null, 2)}\n---\n${body}`;
  }

  function parsePostFile(text) {
    const s = String(text).replace(/\r\n/g, "\n");
    if (!s.startsWith("---\n")) throw new Error("Le fichier ne commence pas par --- (frontmatter JSON manquant).");
    const end = s.indexOf("\n---\n", 4);
    if (end === -1) throw new Error("Frontmatter non refermé (--- manquant).");
    const front = JSON.parse(s.slice(4, end));
    const body = s.slice(end + 5).trim();
    const marker = /<!--\s*locale:(en|fr|it)\s*-->/g;
    const matches = Array.from(body.matchAll(marker));
    const bodies = {};
    if (!matches.length) bodies.fr = body;
    else {
      const lead = body.slice(0, matches[0].index).trim();
      if (lead) bodies.fr = lead;
      matches.forEach((m, k) => {
        const start = m.index + m[0].length;
        const stop = matches[k + 1]?.index ?? body.length;
        bodies[m[1]] = body.slice(start, stop).trim();
      });
    }
    return { front, bodies };
  }

  /* ---------- llms.txt / llms-full.txt updaters ---------- */

  function postUrl(site, slug) {
    return `${site.domain}/blog/${slug}/`;
  }

  // Returns the section [start, end) line indexes of "## heading" (end = next "## " or EOF).
  function sectionRange(lines, heading) {
    const start = lines.findIndex((l) => l.trim() === heading);
    if (start === -1) return null;
    let end = lines.length;
    for (let k = start + 1; k < lines.length; k++) if (/^##\s/.test(lines[k])) { end = k; break; }
    return [start, end];
  }

  function upsertListLine(text, heading, line, url, { sort = false, createBefore = null } = {}) {
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    let range = sectionRange(lines, heading);
    if (!range) {
      const at = createBefore ? lines.findIndex((l) => l.trim() === createBefore) : -1;
      const block = [heading, "", line, ""];
      if (at === -1) lines.push("", ...block);
      else lines.splice(at, 0, ...block);
      return lines.join("\n");
    }
    const [start, end] = range;
    const existing = [];
    for (let k = start + 1; k < end; k++) if (lines[k].startsWith("- ")) existing.push(k);
    const same = existing.find((k) => lines[k].includes(url));
    if (same !== undefined) { lines[same] = line; return lines.join("\n"); }
    if (!existing.length) { lines.splice(start + 1, 0, "", line); return lines.join("\n"); }
    const items = existing.map((k) => lines[k]).concat(line);
    if (sort) items.sort((a, b) => a.localeCompare(b, "fr"));
    const first = existing[0], last = existing[existing.length - 1];
    lines.splice(first, last - first + 1, ...items);
    return lines.join("\n");
  }

  function wrap(text, width = 80) {
    const words = text.split(/\s+/);
    const out = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length > width && cur) { out.push(cur); cur = w; }
      else cur = (cur + " " + w).trim();
    }
    if (cur) out.push(cur);
    return out;
  }

  function karenFullBlock(site, draft) {
    const fr = draft.fr;
    return [
      `### ${fr.title}`,
      `URL : ${postUrl(site, draft.slug)}`,
      `Catégorie : ${fr.category} · Publié le ${draft.publishedAt} · ${fr.readingTime} de lecture`,
      ...wrap(`Résumé : ${fr.description}`),
      "À retenir :",
      ...fr.keyTakeaways.filter(Boolean).map((t) => `- ${t}`),
    ];
  }

  function upsertKarenFull(text, site, draft) {
    const url = postUrl(site, draft.slug);
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    const block = karenFullBlock(site, draft);
    const range = sectionRange(lines, "## Articles du blog");
    if (!range) {
      const at = lines.findIndex((l) => l.trim() === "## English summary");
      const ins = ["## Articles du blog", "", ...block, ""];
      if (at === -1) lines.push("", ...ins); else lines.splice(at, 0, ...ins);
      return lines.join("\n");
    }
    const [start, end] = range;
    const urlLine = lines.findIndex((l, k) => k > start && k < end && l.trim() === `URL : ${url}`);
    if (urlLine !== -1) {
      let bStart = urlLine - 1;
      let bEnd = urlLine + 1;
      while (bEnd < end && lines[bEnd].trim() !== "" && !/^###?\s/.test(lines[bEnd])) bEnd++;
      lines.splice(bStart, bEnd - bStart, ...block);
      return lines.join("\n");
    }
    let insertAt = end;
    while (insertAt > start + 1 && lines[insertAt - 1].trim() === "") insertAt--;
    lines.splice(insertAt, 0, "", ...block);
    return lines.join("\n");
  }

  function llmsSnippets(site, draft) {
    const fr = draft.fr;
    const url = postUrl(site, draft.slug);
    if (site.id === "karen") {
      return [
        { file: "public/llms.txt", where: "Section « ## Articles du blog » (ajoutez une ligne à la liste)", text: `- ${fr.title} — ${url}` },
        { file: "public/llms-full.txt", where: "Section « ## Articles du blog », à la fin, juste avant « ## English summary »", text: karenFullBlock(site, draft).join("\n") },
      ];
    }
    return [
      { file: "public/llms-full.txt", where: "Section « ## Articles » (une ligne par article, ordre alphabétique)", text: `- [${fr.title}](${url}) : ${fr.excerpt}` },
    ];
  }

  function applyLlms(site, draft, files) {
    const fr = draft.fr;
    const url = postUrl(site, draft.slug);
    const result = {};
    if (site.id === "karen") {
      if (files["public/llms.txt"] != null)
        result["public/llms.txt"] = upsertListLine(files["public/llms.txt"], "## Articles du blog", `- ${fr.title} — ${url}`, url, { createBefore: "## English" });
      if (files["public/llms-full.txt"] != null) result["public/llms-full.txt"] = upsertKarenFull(files["public/llms-full.txt"], site, draft);
    } else if (files["public/llms-full.txt"] != null) {
      result["public/llms-full.txt"] = upsertListLine(files["public/llms-full.txt"], "## Articles", `- [${fr.title}](${url}) : ${fr.excerpt}`, url, { sort: true });
    }
    return result;
  }

  window.MD = { esc, toHtml, headings, wordCount, lint, buildPostFile, parsePostFile, llmsSnippets, applyLlms, postUrl, slugifyHeading, LOCALIZED_KEYS };
})();
