# Constructeur d'articles

Static page that builds a publish-ready blog post, step by step, for:

- **karenschenck.fr** (`website/`, repo `kaddour-youcef/keren_website`, branch `master`)
- **visionhumanconsulting.com** (`vision-human-consulting/`, repo `karen-schenck/vision-consulting`, branch `main`)

No build, no dependencies, no server: open `index.html` or the GitHub Pages URL.

## What it does

1. **Démarrer**: pick the site, resume a draft, load a `.json` draft, or import an existing `data/blogs/<slug>.md` (from a file or from GitHub) to edit it.
2. **Article / SEO / Rédaction / Points clés & FAQ / Maillage & CTA / Version anglaise**: every field of the blog frontmatter, a Markdown editor with a toolbar (H2, H3, bold, italic, links with an internal-page picker, lists, quotes, images, tables, code, sources, outline template) and a live preview that uses a port of the sites' own `lib/markdown.ts`.
3. **Vérification**: SEO and formatting checks (lengths, main keyword placement, word count, internal and external links, FAQ, unsupported Markdown, em dashes) with a score and a full page preview.
4. **Télécharger**: the `.md` file, the images (converted to WebP, max 1600 px), the llms.txt lines, and the draft.
5. **Publier**: a step-by-step guide (files, local check, git commands, Actions, Search Console, rich results test, internal linking), or **automatic publication**.

Drafts autosave to `localStorage`. "Enregistrer" keeps several drafts; "Télécharger le brouillon" exports a `.json` to move between computers.

## Automatic publication

The GitHub REST API allows cross-origin requests (`Access-Control-Allow-Origin: *`), so the page commits directly from the browser with a **fine-grained personal access token**:

- Repository access: only the site's repository.
- Permissions: `Contents: Read and write` (required), `Pull requests: Read and write` (review mode), `Actions: Read-only` (deploy status).

It writes one atomic commit (Git Data API: blobs, tree, commit, ref) with the post, its images and the updated `llms.txt` / `llms-full.txt`, then follows the Pages deployment. "Proposer pour relecture" creates a branch and a pull request instead.

The token is kept in `sessionStorage` (forgotten when the tab closes) unless "Se souvenir" is ticked. It is only ever sent to `api.github.com`. Never commit a token to this repository.

## Files

| File | Role |
|---|---|
| `index.html` | Page shell |
| `assets/sites.js` | Per-site profile: domain, repo, branch, categories, internal pages, existing posts, default CTA, llms format |
| `assets/markdown.js` | Markdown renderer (mirror of the sites), lint, `.md` (de)serialisation, llms updaters |
| `assets/github.js` | Minimal GitHub client (check, list, read, atomic commit, PR, Actions status) |
| `assets/app.js` | Wizard, editor, checks, previews, persistence |
| `assets/app.css` | Styles |

## Keeping it in sync with the sites

When a site gains a page, a category or a post, update its profile in `assets/sites.js` (the post list is also refreshed live from GitHub when a token is connected). If a site's `lib/markdown.ts` or blog frontmatter changes, mirror it in `assets/markdown.js`.
