/* Minimal GitHub REST client, run entirely in the browser.
   api.github.com allows cross-origin requests, so a static page can commit with a token. */
(function () {
  const API = "https://api.github.com";

  class GitHubError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  function explain(status, body, what) {
    const msg = body?.message || "";
    if (status === 401) return "Jeton refusé (401) : il est invalide, expiré ou mal copié.";
    if (status === 403 && /rate limit/i.test(msg)) return "Limite d'appels GitHub atteinte. Réessayez dans quelques minutes.";
    if (status === 403) return `Accès refusé (403) pour ${what}. Le jeton n'a pas la permission nécessaire (Contents : Read and write sur ce dépôt).`;
    if (status === 404) return `Introuvable (404) : ${what}. Vérifiez le nom du dépôt et de la branche, et que le jeton a accès à ce dépôt.`;
    if (status === 409) return "Conflit (409) : le dépôt est vide ou la branche a changé. Réessayez.";
    if (status === 422) return `Requête refusée (422) : ${msg || what}.`;
    return `Erreur GitHub ${status} : ${msg || what}`;
  }

  function b64FromUtf8(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
  }

  function utf8FromB64(b64) {
    const bin = atob(b64.replace(/\n/g, ""));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function create({ token, repo, branch }) {
    const [owner, name] = repo.split("/");
    const base = `${API}/repos/${owner}/${name}`;

    async function call(path, { method = "GET", body, what = path, raw = false } = {}) {
      const res = await fetch(path.startsWith("http") ? path : `${base}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new GitHubError(res.status, explain(res.status, data, what));
      return raw ? res : data;
    }

    async function getFile(path, ref = branch) {
      try {
        const data = await call(`/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`, { what: path });
        if (Array.isArray(data)) return null;
        if (data.content) return { text: utf8FromB64(data.content), sha: data.sha };
        const blob = await call(`/git/blobs/${data.sha}`, { what: path });
        return { text: utf8FromB64(blob.content), sha: data.sha };
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    }

    return {
      repo,
      branch,

      async check() {
        const info = await call("", { what: `le dépôt ${repo}` });
        await call(`/branches/${encodeURIComponent(branch)}`, { what: `la branche ${branch}` });
        return {
          fullName: info.full_name,
          private: info.private,
          canPush: info.permissions ? Boolean(info.permissions.push) : null,
          defaultBranch: info.default_branch,
          htmlUrl: info.html_url,
        };
      },

      async listPosts() {
        try {
          const items = await call(`/contents/data/blogs?ref=${encodeURIComponent(branch)}`, { what: "data/blogs" });
          return items.filter((it) => it.type === "file" && it.name.endsWith(".md")).map((it) => it.name.replace(/\.md$/, ""));
        } catch (error) {
          if (error.status === 404) return [];
          throw error;
        }
      },

      getFile,

      /* One atomic commit with several files.
         files: [{ path, text }] or [{ path, base64 }] */
      async commit({ files, message, newBranch = null, prTitle = null, prBody = "" }) {
        const ref = await call(`/git/ref/heads/${encodeURIComponent(branch)}`, { what: `la branche ${branch}` });
        const parentSha = ref.object.sha;
        const parent = await call(`/git/commits/${parentSha}`, { what: "le dernier commit" });

        const tree = [];
        for (const file of files) {
          if (file.base64) {
            const blob = await call("/git/blobs", { method: "POST", body: { content: file.base64, encoding: "base64" }, what: file.path });
            tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
          } else {
            const blob = await call("/git/blobs", { method: "POST", body: { content: b64FromUtf8(file.text), encoding: "base64" }, what: file.path });
            tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
          }
        }
        const newTree = await call("/git/trees", { method: "POST", body: { base_tree: parent.tree.sha, tree }, what: "l'arborescence" });
        const commit = await call("/git/commits", {
          method: "POST",
          body: { message, tree: newTree.sha, parents: [parentSha] },
          what: "le commit",
        });

        if (newBranch) {
          await call("/git/refs", { method: "POST", body: { ref: `refs/heads/${newBranch}`, sha: commit.sha }, what: `la branche ${newBranch}` });
          const pr = await call("/pulls", {
            method: "POST",
            body: { title: prTitle || message, head: newBranch, base: branch, body: prBody },
            what: "la pull request (permission « Pull requests : Read and write » requise)",
          });
          return { sha: commit.sha, url: commit.html_url, prUrl: pr.html_url, prNumber: pr.number };
        }

        await call(`/git/refs/heads/${encodeURIComponent(branch)}`, {
          method: "PATCH",
          body: { sha: commit.sha, force: false },
          what: `la mise à jour de ${branch}`,
        });
        return { sha: commit.sha, url: commit.html_url };
      },

      async runFor(sha) {
        const data = await call(`/actions/runs?head_sha=${sha}&per_page=5`, { what: "GitHub Actions (permission « Actions : Read » requise)" });
        return data.workflow_runs?.[0] || null;
      },
    };
  }

  window.GH = { create, GitHubError, b64FromUtf8 };
})();
